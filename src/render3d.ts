// ============ COBALT SECTOR — rendu Three.js (2.5D vue satellite) ============
import * as THREE from 'three';
import {
  GameState, V2, v2, dist, len, clamp, lerp, TACTICAL_ZOOM, WORLD_R, PIRATE_TEAM,
} from './core';
import { TEAM_DEFS, PIRATE_DEF, WEAPONS, SHIP_CLASSES } from './data';
import {
  buildShip, buildStructure, buildPlanet, buildRoid, buildCloud, buildWreck,
  buildStarBody, buildProjectile, buildMineMesh, mat,
} from './meshes';

interface Particle { p: THREE.Vector3; v: THREE.Vector3; life: number; maxLife: number; color: THREE.Color; size: number }
interface Beam { line: THREE.Line; life: number; maxOpacity: number }

/** Libère géométries + matériaux non partagés d'un objet retiré de la scène. */
function disposeObject(obj: THREE.Object3D) {
  obj.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      if (!(m as THREE.Material).userData?.shared) {
        const anyM = m as THREE.Material & { map?: THREE.Texture | null };
        (anyM as THREE.Material).dispose();
      }
    }
  });
}
interface Ring { mesh: THREE.Mesh; life: number; maxLife: number; from: number; to: number }

const MAX_PARTICLES = 900;

function teamColorOf(team: number): number {
  if (team === PIRATE_TEAM) return PIRATE_DEF.color;
  return TEAM_DEFS[team]?.color ?? 0x8a93a0;
}

export class Renderer3D {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;

  camH = 120;              // hauteur caméra (zoom)
  camPos: V2 = v2();       // position caméra (vue tactique libre)
  private camCur = new THREE.Vector3(0, 120, 0);

  private meshes = new Map<number, THREE.Object3D>();      // entités → mesh
  private icons = new Map<number, THREE.Sprite>();          // icônes tactiques
  private terrRings = new Map<number, THREE.Mesh>();        // anneaux de territoire
  private smokeMeshes = new Map<number, THREE.Mesh>();
  private starGroup = new THREE.Group();
  private grid: THREE.GridHelper;
  private aimGroup = new THREE.Group();
  private selRings = new THREE.Group();
  private novaRing: THREE.Mesh | null = null;

  // effets
  private particles: Particle[] = [];
  private points: THREE.Points;
  private pGeo = new THREE.BufferGeometry();
  private beams: Beam[] = [];
  private rings: Ring[] = [];
  private time = 0;

  private iconTexCache = new Map<string, THREE.SpriteMaterial>();
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 6000);
    this.scene.background = new THREE.Color(0x05070d);
    this.scene.fog = new THREE.Fog(0x05070d, 2200, 5200);

    // lumières
    this.scene.add(new THREE.AmbientLight(0x8899bb, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(300, 500, 200);
    this.scene.add(dir);

    // étoiles de fond
    this.scene.add(makeStarfield(2600, 4200, -160, 0.45));
    this.scene.add(makeStarfield(1000, 2600, -90, 0.7));

    // grille tactique
    this.grid = new THREE.GridHelper(WORLD_R * 2.2, 44, 0x1d3350, 0x101c30);
    this.grid.position.y = -6;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.grid.visible = false;
    this.scene.add(this.grid);

    // limite du monde
    const border = new THREE.Mesh(
      new THREE.RingGeometry(WORLD_R, WORLD_R + 14, 96),
      new THREE.MeshBasicMaterial({ color: 0x40c4ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide }),
    );
    border.rotation.x = -Math.PI / 2;
    this.scene.add(border);

    this.scene.add(this.starGroup);
    this.scene.add(this.aimGroup);
    this.scene.add(this.selRings);
    this.buildAim();

    // particules
    const pm = new THREE.PointsMaterial({
      size: 3, vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this.pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3));
    this.pGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3));
    this.points = new THREE.Points(this.pGeo, pm);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** À appeler quand une nouvelle partie démarre (le renderer est réutilisé). */
  reset() {
    for (const [, m] of this.meshes) { this.scene.remove(m); disposeObject(m); }
    this.meshes.clear();
    for (const [, i] of this.icons) { this.scene.remove(i); i.material.dispose(); }
    this.icons.clear();
    for (const [, r] of this.terrRings) { this.scene.remove(r); disposeObject(r); }
    this.terrRings.clear();
    for (const [, s] of this.smokeMeshes) { this.scene.remove(s); disposeObject(s); }
    this.smokeMeshes.clear();
    for (const b of this.beams) { this.scene.remove(b.line); b.line.geometry.dispose(); (b.line.material as THREE.Material).dispose(); }
    this.beams.length = 0;
    for (const r of this.rings) { this.scene.remove(r.mesh); r.mesh.geometry.dispose(); (r.mesh.material as THREE.Material).dispose(); }
    this.rings.length = 0;
    this.particles.length = 0;
    // astres de la partie précédente
    while (this.starGroup.children.length) {
      const c = this.starGroup.children[0];
      this.starGroup.remove(c);
    }
    if (this.novaRing) { this.scene.remove(this.novaRing); this.novaRing.geometry.dispose(); this.novaRing = null; }
    this.starBuilt = false;
  }

  isTactical(): boolean { return this.camH >= TACTICAL_ZOOM; }

  // ---------- Conversions écran <-> monde ----------
  worldFromScreen(sx: number, sy: number): V2 {
    const ndc = new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.plane, out);
    return { x: out.x, y: out.z };
  }
  screenFromWorld(p: V2): { x: number; y: number } {
    const v = new THREE.Vector3(p.x, 0, p.y).project(this.camera);
    return { x: (v.x + 1) / 2 * window.innerWidth, y: (-v.y + 1) / 2 * window.innerHeight };
  }

  /** Entité cliquée : id ou null. */
  pickEntity(gs: GameState, sx: number, sy: number, visible: Set<number>): number | null {
    let best: number | null = null, bd = 26;
    const test = (id: number, pos: V2, bonus = 0) => {
      const s = this.screenFromWorld(pos);
      const d = Math.hypot(s.x - sx, s.y - sy) - bonus;
      if (d < bd) { bd = d; best = id; }
    };
    for (const s of gs.ships) {
      if (!s.alive) continue;
      if (s.team !== gs.playerTeam && !visible.has(s.id)) continue;
      test(s.id, s.pos, 4);
    }
    for (const st of gs.structures) if (st.alive) test(st.id, st.pos, 8);
    for (const p of gs.planets) if (p.alive) test(p.id, p.pos, 10);
    for (const r of gs.roids) if (r.alive) test(r.id, r.pos, 2);
    for (const c of gs.clouds) if (c.alive) test(c.id, c.pos, 8);
    for (const w of gs.wrecks) if (w.alive) test(w.id, w.pos, 2);
    return best;
  }

  // ---------- Indicateur de visée (arc + flèche) ----------
  private aimArc!: THREE.Mesh;
  private aimArrow!: THREE.Mesh;
  private aimArcRadius = -1;
  private buildAim() {
    const arcGeo = new THREE.RingGeometry(9, 10, 24, 1, -Math.PI / 5, (Math.PI * 2) / 5);
    this.aimArc = new THREE.Mesh(arcGeo, new THREE.MeshBasicMaterial({ color: 0x40c4ff, transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
    this.aimArc.rotation.x = -Math.PI / 2;
    this.aimArrow = new THREE.Mesh(new THREE.ConeGeometry(1.6, 4, 3), new THREE.MeshBasicMaterial({ color: 0x40c4ff, transparent: true, opacity: 0.9 }));
    this.aimGroup.add(this.aimArc, this.aimArrow);
  }

  // ================================================================
  //  MISE À JOUR PRINCIPALE
  // ================================================================
  update(gs: GameState, dt: number, visible: Set<number>, aimWorld: V2) {
    this.time += dt;
    const tactical = this.isTactical();

    this.syncStar(gs, dt);
    this.syncEntities(gs, visible, tactical, dt);
    this.syncSmokes(gs);
    this.consumeFx(gs);
    this.updateEffects(dt);
    this.updateCamera(gs, dt, tactical);
    this.updateAim(gs, aimWorld, tactical);
    this.grid.visible = tactical;

    this.renderer.render(this.scene, this.camera);
  }

  // ---------- Astres ----------
  private starBuilt = false;
  private syncStar(gs: GameState, dt: number) {
    if (!this.starBuilt) {
      this.starBuilt = true;
      gs.map.bodies.forEach((b, i) => {
        const g = buildStarBody(gs.map.starType, b.radius, b.color);
        g.name = `star${i}`;
        this.starGroup.add(g);
        const light = new THREE.PointLight(b.color === 0x000000 ? 0xff8c42 : b.color, 2.2, 2600, 1.4);
        light.position.set(0, 60, 0);
        g.add(light);
      });
      if (gs.map.supernovaAt > 0) {
        this.novaRing = new THREE.Mesh(
          new THREE.RingGeometry(1, 1.06, 96),
          new THREE.MeshBasicMaterial({ color: 0xff6b4b, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
        );
        this.novaRing.rotation.x = -Math.PI / 2;
        this.novaRing.visible = false;
        this.scene.add(this.novaRing);
      }
    }
    gs.map.bodies.forEach((b, i) => {
      const g = this.starGroup.getObjectByName(`star${i}`);
      if (!g) return;
      g.position.set(b.pos.x, 0, b.pos.y);
      const corona = g.getObjectByName('corona') as THREE.Mesh | undefined;
      if (corona) {
        const s = 1 + Math.sin(this.time * 2.2 + i) * 0.05;
        corona.scale.setScalar(s);
      }
      const disk = g.getObjectByName('disk');
      if (disk) disk.rotation.z += dt * 0.5;
      const disk2 = g.getObjectByName('disk2');
      if (disk2) disk2.rotation.z -= dt * 0.9;
    });
    // onde de supernova
    if (this.novaRing) {
      if (gs.supernovaWave > 0) {
        this.novaRing.visible = true;
        this.novaRing.scale.setScalar(gs.supernovaWave);
      }
    }
  }

  // ---------- Entités ----------
  private syncEntities(gs: GameState, visible: Set<number>, tactical: boolean, dt: number) {
    const seen = new Set<number>();

    // Vaisseaux
    for (const s of gs.ships) {
      if (!s.alive) continue;
      seen.add(s.id);
      let m = this.meshes.get(s.id);
      if (!m) {
        m = buildShip(s.cls, teamColorOf(s.team));
        this.meshes.set(s.id, m);
        this.scene.add(m);
      }
      m.position.set(s.pos.x, 0, s.pos.y);
      m.rotation.y = -s.heading;
      // roulis léger dans les virages
      const targetRoll = clamp(-((s.vel.x * Math.sin(s.heading)) - (s.vel.y * Math.cos(s.heading))) * -0.008, -0.5, 0.5);
      m.rotation.x = lerp(m.rotation.x, targetRoll, 0.1);

      const isPlayerTeam = s.team === gs.playerTeam;
      const detected = isPlayerTeam || visible.has(s.id);
      const cloaked = s.cloakT > 0 || s.mode === 'espion';
      // les vaisseaux camouflés de l'équipe du joueur scintillent (effet fantôme),
      // ceux des ennemis sont simplement invisibles (gérés par `detected`)
      m.visible = detected && (!cloaked || !isPlayerTeam || Math.sin(this.time * 14 + s.id) > -0.45);

      // flamme moteur
      const flame = m.getObjectByName('flame') as THREE.Mesh | undefined;
      if (flame) {
        const sp = len(s.vel) / SHIP_CLASSES[s.cls].speed;
        flame.scale.set(1, 0.6 + sp * 1.2 + Math.sin(this.time * 30) * 0.15, 1);
        flame.visible = sp > 0.05;
      }
      const drill = m.getObjectByName('drill') as THREE.Mesh | undefined;
      if (drill && s.miningRes) drill.rotation.x += dt * 8;

      // icône tactique
      this.syncIcon(s.id, s.pos, s.isFlagship ? 'diamond' : 'tri', teamColorOf(s.team), tactical && detected, s.heading);
    }

    // Structures
    for (const st of gs.structures) {
      if (!st.alive) continue;
      seen.add(st.id);
      let m = this.meshes.get(st.id);
      if (!m) {
        m = buildStructure(st.stype, teamColorOf(st.team));
        this.meshes.set(st.id, m);
        this.scene.add(m);
        // anneau de territoire
        const r = st.stype === 'station' ? 340 : st.stype === 'avantposte' ? 260 : 0;
        if (r > 0) {
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(r - 3, r, 64),
            new THREE.MeshBasicMaterial({ color: teamColorOf(st.team), transparent: true, opacity: 0.12, side: THREE.DoubleSide }),
          );
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(st.pos.x, -2, st.pos.y);
          this.terrRings.set(st.id, ring);
          this.scene.add(ring);
        }
      }
      m.position.set(st.pos.x, 0, st.pos.y);
      const ring = m.getObjectByName('ring');
      if (ring) ring.rotation.z += dt * 0.25;
      const drill = m.getObjectByName('drill');
      if (drill) drill.rotation.y += dt * 3;
      this.syncIcon(st.id, st.pos, 'square', teamColorOf(st.team), tactical, 0);
    }

    // Planètes
    for (const p of gs.planets) {
      if (!p.alive) continue;
      seen.add(p.id);
      let m = this.meshes.get(p.id);
      if (!m) {
        m = buildPlanet(p.ptype, p.radius, p.id * 7.3);
        this.meshes.set(p.id, m);
        this.scene.add(m);
      }
      m.position.set(p.pos.x, 0, p.pos.y);
      const globe = m.getObjectByName('globe');
      if (globe) globe.rotation.y += dt * 0.08;
      const ownerRing = m.getObjectByName('ownerRing') as THREE.Mesh | undefined;
      if (ownerRing) {
        const mm = ownerRing.material as THREE.MeshBasicMaterial;
        if (p.owner >= 0) {
          mm.opacity = 0.75;
          mm.color.setHex(teamColorOf(p.owner));
        } else mm.opacity = 0;
      }
      this.syncIcon(p.id, p.pos, 'circle', p.owner >= 0 ? teamColorOf(p.owner) : 0x8a93a0, tactical, 0);
    }

    // Astéroïdes
    for (const r of gs.roids) {
      if (!r.alive) continue;
      seen.add(r.id);
      let m = this.meshes.get(r.id);
      if (!m) {
        m = buildRoid(r.rtype, r.radius, r.id * 3.1);
        this.meshes.set(r.id, m);
        this.scene.add(m);
        m.rotation.set(r.id * 0.7, r.id * 1.3, 0);
      }
      m.position.set(r.pos.x, 0, r.pos.y);
      m.rotation.y += dt * 0.15;
    }

    // Nuages de gaz
    for (const c of gs.clouds) {
      if (!c.alive) continue;
      seen.add(c.id);
      let m = this.meshes.get(c.id);
      if (!m) {
        m = buildCloud(c.radius, c.id * 5.7);
        this.meshes.set(c.id, m);
        this.scene.add(m);
      }
      m.position.set(c.pos.x, 0, c.pos.y);
      m.rotation.y += dt * 0.05;
    }

    // Épaves
    for (const w of gs.wrecks) {
      if (!w.alive) continue;
      seen.add(w.id);
      let m = this.meshes.get(w.id);
      if (!m) {
        m = buildWreck(SHIP_CLASSES[w.cls].radius);
        this.meshes.set(w.id, m);
        this.scene.add(m);
      }
      m.position.set(w.pos.x, 0, w.pos.y);
      m.rotation.y += dt * 0.4;
    }

    // Projectiles
    for (const p of gs.projectiles) {
      if (!p.alive) continue;
      seen.add(p.id);
      let m = this.meshes.get(p.id);
      if (!m) {
        const w = WEAPONS[p.wid];
        m = buildProjectile(w.color, (w.aoe ?? 0) > 0);
        this.meshes.set(p.id, m);
        this.scene.add(m);
      }
      m.position.set(p.pos.x, 0, p.pos.y);
      m.rotation.y = -Math.atan2(p.vel.y, p.vel.x);
    }

    // Mines posées
    for (const mn of gs.minesArmed) {
      if (!mn.alive) continue;
      seen.add(mn.id);
      let m = this.meshes.get(mn.id);
      if (!m) {
        m = buildMineMesh(0xff4b4b);
        this.meshes.set(mn.id, m);
        this.scene.add(m);
      }
      m.position.set(mn.pos.x, 0, mn.pos.y);
      const blink = m.getObjectByName('blink') as THREE.Mesh | undefined;
      if (blink) blink.visible = Math.sin(this.time * (mn.timer < 1.5 ? 30 : 10)) > 0;
    }

    // suppression des disparus (avec libération GPU)
    for (const [id, m] of this.meshes) {
      if (!seen.has(id)) {
        this.scene.remove(m);
        disposeObject(m);
        this.meshes.delete(id);
        const icon = this.icons.get(id);
        if (icon) { this.scene.remove(icon); icon.material.dispose(); this.icons.delete(id); }
        const ring = this.terrRings.get(id);
        if (ring) { this.scene.remove(ring); disposeObject(ring); this.terrRings.delete(id); }
      }
    }
  }

  // ---------- Icônes tactiques ----------
  private syncIcon(id: number, pos: V2, shape: string, color: number, show: boolean, heading: number) {
    let icon = this.icons.get(id);
    if (!show) { if (icon) icon.visible = false; return; }
    const key = `${shape}|${color}`;
    if (!icon) {
      // matériau CLONÉ : la rotation de SpriteMaterial est par instance, un
      // matériau partagé ferait tourner toutes les icônes avec le dernier cap
      icon = new THREE.Sprite(this.iconMaterial(shape, color).clone());
      icon.userData.key = key;
      this.icons.set(id, icon);
      this.scene.add(icon);
    } else if (icon.userData.key !== key) {
      // la couleur/forme a changé (colonisation, transfert d'amiral…)
      icon.material.dispose();
      icon.material = this.iconMaterial(shape, color).clone();
      icon.userData.key = key;
    }
    icon.visible = true;
    const s = this.camH * 0.035 * (shape === 'square' ? 1.25 : shape === 'circle' ? 1.4 : 1);
    icon.scale.set(s, s, 1);
    icon.position.set(pos.x, 8, pos.y);
    if (shape === 'tri' || shape === 'diamond') icon.material.rotation = -heading - Math.PI / 2;
  }

  private iconMaterial(shape: string, color: number): THREE.SpriteMaterial {
    const key = `${shape}|${color}`;
    let m = this.iconTexCache.get(key);
    if (m) return m;
    const c = document.createElement('canvas');
    c.width = c.height = 48;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (shape === 'tri') {
      ctx.moveTo(24, 4); ctx.lineTo(42, 42); ctx.lineTo(24, 34); ctx.lineTo(6, 42);
    } else if (shape === 'diamond') {
      ctx.moveTo(24, 2); ctx.lineTo(44, 24); ctx.lineTo(24, 46); ctx.lineTo(4, 24);
    } else if (shape === 'square') {
      ctx.rect(8, 8, 32, 32);
    } else {
      ctx.arc(24, 24, 17, 0, Math.PI * 2);
    }
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    const tex = new THREE.CanvasTexture(c);
    m = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    this.iconTexCache.set(key, m);
    return m;
  }

  // ---------- Fumée ----------
  private syncSmokes(gs: GameState) {
    const seen = new Set<number>();
    for (const z of gs.smokes) {
      seen.add(z.id);
      let m = this.smokeMeshes.get(z.id);
      if (!m) {
        m = new THREE.Mesh(
          new THREE.SphereGeometry(z.radius, 10, 6),
          new THREE.MeshStandardMaterial({ color: 0x9aa0a8, transparent: true, opacity: 0.35, flatShading: true, depthWrite: false }),
        );
        m.scale.y = 0.35;
        m.position.set(z.pos.x, 2, z.pos.y);
        this.smokeMeshes.set(z.id, m);
        this.scene.add(m);
      }
      (m.material as THREE.MeshStandardMaterial).opacity = 0.35 * Math.min(1, z.t / 3);
    }
    for (const [id, m] of this.smokeMeshes) {
      if (!seen.has(id)) { this.scene.remove(m); disposeObject(m); this.smokeMeshes.delete(id); }
    }
  }

  // ---------- Effets ----------
  private consumeFx(gs: GameState) {
    for (const fx of gs.fx) {
      const p3 = new THREE.Vector3(fx.pos.x, 2, fx.pos.y);
      switch (fx.type) {
        case 'tir':
          this.spawnParticles(p3, fx.color ?? 0xffd27a, 2, 14, 0.12, 1.6);
          break;
        case 'impact':
          this.spawnParticles(p3, fx.color ?? 0xffffff, 6, 30, 0.3, 2);
          break;
        case 'explosion': {
          const size = fx.size ?? 10;
          this.spawnParticles(p3, fx.color ?? 0xff8c42, Math.min(50, 10 + size * 2), 20 + size * 2.4, 0.7, 3);
          this.spawnParticles(p3, 0xffd84b, Math.min(20, size), 12 + size, 0.5, 2.4);
          this.spawnRing(fx.pos, 2, size * 2.2, 0.5, fx.color ?? 0xff8c42);
          break;
        }
        case 'beam': {
          if (!fx.pos2) break;
          const g = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(fx.pos.x, 2, fx.pos.y),
            new THREE.Vector3(fx.pos2.x, 2, fx.pos2.y),
          ]);
          const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: fx.color ?? 0xff5d5d, transparent: true, opacity: 0.95 }));
          this.scene.add(line);
          this.beams.push({ line, life: 0.14, maxOpacity: 0.95 });
          this.spawnParticles(new THREE.Vector3(fx.pos2.x, 2, fx.pos2.y), fx.color ?? 0xff5d5d, 4, 16, 0.2, 1.6);
          break;
        }
        case 'minage': case 'colonise': {
          if (!fx.pos2) break;
          const g = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(fx.pos.x, 2, fx.pos.y),
            new THREE.Vector3(fx.pos2.x, 2, fx.pos2.y),
          ]);
          const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: fx.color ?? 0xffd84b, transparent: true, opacity: 0.5 }));
          this.scene.add(line);
          this.beams.push({ line, life: 0.2, maxOpacity: 0.5 });
          break;
        }
        case 'saut':
          this.spawnParticles(p3, 0x7adfff, 24, 40, 0.5, 2.6);
          this.spawnRing(fx.pos, 2, 34, 0.45, 0x7adfff);
          break;
        case 'onde':
          this.spawnRing(fx.pos, 6, fx.size ?? 400, 1.4, fx.color ?? 0x7adfff);
          break;
        case 'frappe': {
          // colonne de feu venue du ciel
          const g = new THREE.CylinderGeometry(4, 7, 320, 8, 1, true);
          const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff6b4b, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
          m.position.set(fx.pos.x, 160, fx.pos.y);
          this.scene.add(m);
          this.rings.push({ mesh: m, life: 0.6, maxLife: 0.6, from: 1, to: 1 });
          this.spawnParticles(p3, 0xff6b4b, 40, 50, 0.8, 3);
          this.spawnRing(fx.pos, 4, 46, 0.6, 0xff6b4b);
          break;
        }
        case 'bulle': {
          const m = new THREE.Mesh(
            new THREE.SphereGeometry((fx.size ?? 10) * 1.2, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0x40c4ff, transparent: true, opacity: 0.4, wireframe: true }),
          );
          m.position.copy(p3);
          this.scene.add(m);
          this.rings.push({ mesh: m, life: 0.4, maxLife: 0.4, from: 1, to: 1.15 });
          break;
        }
        case 'fumee':
          this.spawnParticles(p3, 0x9aa0a8, 30, 18, 1.4, 5);
          break;
      }
    }
    gs.fx.length = 0;
  }

  private spawnParticles(p: THREE.Vector3, color: number, n: number, speed: number, life: number, size: number) {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({
        p: p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2)),
        v: new THREE.Vector3(Math.cos(a) * sp, (Math.random() - 0.3) * sp * 0.3, Math.sin(a) * sp),
        life: life * (0.5 + Math.random() * 0.5), maxLife: life,
        color: c, size,
      });
    }
  }

  private spawnRing(pos: V2, from: number, to: number, life: number, color: number) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(pos.x, 1.5, pos.y);
    m.scale.setScalar(from);
    this.scene.add(m);
    this.rings.push({ mesh: m, life, maxLife: life, from, to });
  }

  private updateEffects(dt: number) {
    // particules
    const posA = this.pGeo.getAttribute('position') as THREE.BufferAttribute;
    const colA = this.pGeo.getAttribute('color') as THREE.BufferAttribute;
    let n = 0;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i];
      pt.life -= dt;
      if (pt.life <= 0) { this.particles.splice(i, 1); continue; }
      pt.p.addScaledVector(pt.v, dt);
      pt.v.multiplyScalar(1 - 2.2 * dt);
      const f = pt.life / pt.maxLife;
      posA.setXYZ(n, pt.p.x, pt.p.y, pt.p.z);
      colA.setXYZ(n, pt.color.r * f, pt.color.g * f, pt.color.b * f);
      n++;
    }
    this.pGeo.setDrawRange(0, n);
    posA.needsUpdate = true;
    colA.needsUpdate = true;

    // rayons
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= dt;
      if (b.life <= 0) {
        this.scene.remove(b.line);
        b.line.geometry.dispose();
        (b.line.material as THREE.Material).dispose();
        this.beams.splice(i, 1);
      } else {
        (b.line.material as THREE.LineBasicMaterial).opacity = b.maxOpacity * Math.min(1, b.life / 0.1);
      }
    }

    // anneaux / volumes
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      if (r.life <= 0) {
        this.scene.remove(r.mesh);
        r.mesh.geometry.dispose();
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
        continue;
      }
      const f = 1 - r.life / r.maxLife;
      const s = r.from + (r.to - r.from) * f;
      r.mesh.scale.setScalar(s);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (r.life / r.maxLife);
    }
  }

  // ---------- Caméra ----------
  private updateCamera(gs: GameState, dt: number, tactical: boolean) {
    let target: V2;
    if (tactical) {
      target = this.camPos;
    } else {
      const ship = gs.ships.find(s => s.id === gs.playerShipId && s.alive);
      if (ship) {
        target = ship.pos;
        this.camPos = { ...ship.pos };
      } else {
        target = this.camPos;
      }
    }
    const want = new THREE.Vector3(target.x, this.camH, target.y + this.camH * 0.22);
    this.camCur.lerp(want, Math.min(1, 6 * dt));
    this.camera.position.copy(this.camCur);
    this.camera.lookAt(this.camCur.x, 0, this.camCur.z - this.camH * 0.22);
  }

  // ---------- Visée & sélection ----------
  private updateAim(gs: GameState, aimWorld: V2, tactical: boolean) {
    const ship = gs.ships.find(s => s.id === gs.playerShipId && s.alive);
    if (!ship || tactical) { this.aimGroup.visible = false; }
    else {
      this.aimGroup.visible = true;
      const a = Math.atan2(aimWorld.y - ship.pos.y, aimWorld.x - ship.pos.x);
      this.aimGroup.position.set(ship.pos.x, 1, ship.pos.y);
      const r = ship.radius + 7;
      this.aimArc.rotation.z = -a;
      if (this.aimArcRadius !== r) {
        // ne reconstruit la géométrie que si le rayon change (changement de vaisseau)
        this.aimArcRadius = r;
        this.aimArc.geometry.dispose();
        this.aimArc.geometry = new THREE.RingGeometry(r, r + 0.9, 24, 1, -Math.PI / 5, (Math.PI * 2) / 5);
      }
      this.aimArrow.position.set(Math.cos(a) * (r + 3), 0, Math.sin(a) * (r + 3));
      this.aimArrow.rotation.y = -a;
      this.aimArrow.rotation.z = -Math.PI / 2;
    }

    // anneaux de sélection (cache réutilisé pour éviter les fuites de géométrie)
    const selected = gs.selection
      .map(id => gs.ships.find(x => x.id === id && x.alive))
      .filter((s): s is NonNullable<typeof s> => !!s);
    while (this.selRings.children.length < selected.length) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1, 1.35, 24),
        new THREE.MeshBasicMaterial({ color: 0x6dff8a, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      this.selRings.add(ring);
    }
    this.selRings.children.forEach((ring, i) => {
      const s = selected[i];
      ring.visible = !!s;
      if (s) {
        ring.position.set(s.pos.x, 0.5, s.pos.y);
        ring.scale.setScalar(s.radius + 3);
      }
    });
  }
}

// ---------- Fond étoilé ----------
function makeStarfield(count: number, spread: number, y: number, size: number): THREE.Points {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * spread * 2;
    pos[i * 3 + 1] = y - Math.random() * 40;
    pos[i * 3 + 2] = (Math.random() - 0.5) * spread * 2;
    const b = 0.3 + Math.random() * 0.7;
    const tint = Math.random();
    col[i * 3] = b * (tint < 0.1 ? 1 : 0.85);
    col[i * 3 + 1] = b * 0.9;
    col[i * 3 + 2] = b * (tint > 0.9 ? 1 : 0.92);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: false, depthWrite: false }));
}
