// ============ COBALT SECTOR — constructeurs de maillages low-poly ============
import * as THREE from 'three';
import type { ShipClassId, StructType, PlanetType, StarType } from './core';
import { PLANET_TYPES } from './data';

// ---------- Matériaux ----------
const matCache = new Map<string, THREE.MeshStandardMaterial>();
export function mat(color: number, opts: { emissive?: number; emissiveIntensity?: number; metalness?: number; transparent?: boolean; opacity?: number } = {}): THREE.MeshStandardMaterial {
  const key = `${color}|${opts.emissive ?? 0}|${opts.emissiveIntensity ?? 0}|${opts.metalness ?? 0}|${opts.opacity ?? 1}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color, flatShading: true, roughness: 0.75,
      metalness: opts.metalness ?? 0.25,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
    });
    m.userData.shared = true; // matériau du cache : ne jamais le disposer
    matCache.set(key, m);
  }
  return m;
}
const HULL_DARK = 0x2b3442;
const HULL_MID = 0x46536b;
const HULL_LIGHT = 0x6b7a94;

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0, ry = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z); mesh.rotation.y = ry;
  return mesh;
}
function cone(r: number, h: number, seg: number, m: THREE.Material, x = 0, y = 0, z = 0, rz = -Math.PI / 2): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), m);
  mesh.position.set(x, y, z); mesh.rotation.z = rz; // pointe vers +X par défaut
  return mesh;
}
function cyl(rt: number, rb: number, h: number, seg: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.position.set(x, y, z);
  return mesh;
}

/** Flamme moteur (repérée par name pour l'animation). */
function engineFlame(color: number, x: number, z = 0, size = 1): THREE.Mesh {
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.9 * size, 2.6 * size, 4),
    mat(color, { emissive: color, emissiveIntensity: 2.2, transparent: true, opacity: 0.9 }),
  );
  flame.rotation.z = Math.PI / 2;
  flame.position.set(x, 0, z);
  flame.name = 'flame';
  return flame;
}

// ================================================================
//  VAISSEAUX (orientés vers +X, ~unité = mètre du monde)
// ================================================================
export function buildShip(cls: ShipClassId, teamColor: number): THREE.Group {
  const g = new THREE.Group();
  const accent = mat(teamColor, { emissive: teamColor, emissiveIntensity: 0.25 });
  const dark = mat(HULL_DARK);
  const mid = mat(HULL_MID);
  const light = mat(HULL_LIGHT);
  const glow = mat(0x7adfff, { emissive: 0x7adfff, emissiveIntensity: 1.6 });

  switch (cls) {
    case 'corvette': {
      g.add(box(6.5, 1.6, 2.6, mid));
      g.add(cone(1.3, 3, 4, accent, 4.6));
      g.add(box(2.4, 1, 5.6, dark, -0.6));
      g.add(box(2.2, 0.7, 1.4, accent, -0.4, 0.9, 0));
      g.add(box(1.5, 0.5, 7.2, accent, -1.8, 0, 0));
      g.add(cyl(0.4, 0.6, 1.2, 6, glow, -3.4, 0, 1.6));
      g.add(cyl(0.4, 0.6, 1.2, 6, glow, -3.4, 0, -1.6));
      g.add(engineFlame(0x7adfff, -4.4, 0, 0.9));
      break;
    }
    case 'chasseur': {
      // fuselage effilé de type intercepteur delta
      g.add(box(7, 1.0, 1.3, mid));
      g.add(cone(0.7, 3.2, 4, accent, 4.9));
      // verrière
      const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.75, 6, 4),
        mat(0x9fdcff, { emissive: 0x2a6f8f, emissiveIntensity: 0.5, metalness: 0.5 }));
      canopy.position.set(1.4, 0.75, 0);
      canopy.scale.set(1.9, 0.65, 0.85);
      g.add(canopy);
      // aile delta : plaque triangulaire pleine, pointe vers l'avant
      const wing = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 3.7, 0.26, 3), mat(HULL_DARK));
      wing.rotation.y = Math.PI / 6;      // pointe du triangle vers +X
      wing.scale.set(1.35, 1, 1.05);
      wing.position.set(-1, -0.15, 0);
      g.add(wing);
      // liserés de couleur d'équipe le long des bords de fuite
      g.add(box(3.6, 0.34, 0.6, accent, -1.3, 0, 1.75, 0.42));
      g.add(box(3.6, 0.34, 0.6, accent, -1.3, 0, -1.75, -0.42));
      // dérives jumelles inclinées
      const finL = box(1.5, 1.5, 0.16, accent, -2.9, 0.8, 1.1);
      finL.rotation.x = -0.35;
      const finR = box(1.5, 1.5, 0.16, accent, -2.9, 0.8, -1.1);
      finR.rotation.x = 0.35;
      g.add(finL, finR);
      // nacelles moteur
      g.add(cyl(0.42, 0.55, 1.6, 6, light, -3, 0, 0.75));
      g.add(cyl(0.42, 0.55, 1.6, 6, light, -3, 0, -0.75));
      g.add(engineFlame(0xffd27a, -4.1, 0.75, 0.65));
      g.add(engineFlame(0xffd27a, -4.1, -0.75, 0.65));
      break;
    }
    case 'bombardier': {
      g.add(box(7, 2.2, 4, mid));
      g.add(box(3, 1.4, 6.5, dark, -1));
      g.add(cone(1.8, 2.6, 4, accent, 4.6));
      g.add(cyl(0.9, 0.9, 1.6, 6, dark, 0.6, -1.2, 2.2));
      g.add(cyl(0.9, 0.9, 1.6, 6, dark, 0.6, -1.2, -2.2));
      g.add(box(4, 0.6, 1.6, accent, -0.6, 1.4, 0));
      g.add(engineFlame(0xff8c42, -4.2, 1.4, 1.1));
      g.add(engineFlame(0xff8c42, -4.2, -1.4, 1.1));
      break;
    }
    case 'croiseur': {
      g.add(box(13, 2.6, 4.2, mid));
      g.add(box(6, 1.8, 6.5, dark, -2));
      g.add(cone(2, 4, 4, accent, 8.4));
      g.add(box(4.5, 2, 2.6, light, 0.5, 2, 0));
      g.add(box(1.8, 1.2, 1.2, accent, 2, 3.2, 0));
      // batteries latérales
      for (const side of [-1, 1]) {
        g.add(cyl(0.5, 0.5, 1.4, 6, accent, 2.5, 1.2, side * 2.4));
        g.add(cyl(0.5, 0.5, 1.4, 6, accent, -1, 1.2, side * 2.4));
      }
      g.add(box(2.5, 0.8, 8.5, accent, -4.5, 0, 0));
      g.add(engineFlame(0x7adfff, -7.6, 0, 1.5));
      g.add(engineFlame(0x7adfff, -7.2, 0, 2.2));
      g.add(engineFlame(0x7adfff, -7.2, 0, -2.2));
      break;
    }
    case 'mineur': {
      g.add(box(5.5, 2.4, 3.4, mid));
      // foreuse avant
      const drill = cone(1.6, 3, 6, mat(0xc8a86b, { metalness: 0.6 }), 4.2);
      drill.name = 'drill';
      g.add(drill);
      g.add(box(3.2, 1.6, 4.6, dark, -0.5));
      g.add(box(1.6, 2, 1.6, accent, -0.5, 1.8, 0));
      g.add(cyl(0.9, 0.9, 2, 6, light, -2.4, 0, 1.6));
      g.add(cyl(0.9, 0.9, 2, 6, light, -2.4, 0, -1.6));
      g.add(engineFlame(0x7adfff, -3.4, 0, 0.7));
      break;
    }
    case 'cargo': {
      g.add(box(3.5, 2, 3, mid, 3));
      g.add(cone(1.2, 1.8, 4, accent, 5.4));
      // conteneurs
      const colors = [0xc86b4b, 0x6bc8a0, 0xc8b84b];
      for (let i = 0; i < 3; i++) {
        g.add(box(2.6, 2, 3.4, mat(colors[i], { metalness: 0.1 }), 0.8 - i * 3, 0, 0));
      }
      g.add(box(9, 0.5, 0.8, dark, -2.2, -1, 0));
      g.add(engineFlame(0xffd27a, -7, 0, 0.9));
      break;
    }
    case 'transporteur': {
      g.add(box(7, 2.6, 3.6, mid));
      const dome = new THREE.Mesh(new THREE.SphereGeometry(1.8, 6, 4), accent);
      dome.position.set(1, 1.4, 0); dome.scale.y = 0.7;
      g.add(dome);
      g.add(cone(1.5, 2.4, 6, light, 4.6));
      g.add(box(3, 1.4, 5.6, dark, -1.5));
      g.add(box(1.2, 0.6, 6.6, accent, -2.5, 0.6, 0));
      g.add(engineFlame(0x7adfff, -4.2, 0.4, 1));
      break;
    }
    case 'raider': {
      g.add(box(5.5, 1.2, 1.6, dark));
      g.add(cone(0.8, 3, 3, mat(0x9aa0a8, { metalness: 0.5 }), 4));
      // ailes asymétriques déchiquetées
      g.add(box(2, 0.4, 4.4, mat(0x5a6068), -1, 0, 1, 0.3));
      g.add(box(2.4, 0.4, 3.4, mat(0x5a6068), -1.4, 0, -1.4, -0.2));
      g.add(box(0.8, 1.4, 0.3, mat(0xb03030, { emissive: 0xb03030, emissiveIntensity: 0.6 }), -1.8, 0.6, 0.6));
      g.add(engineFlame(0xff4b4b, -3.2, 0, 0.7));
      break;
    }
  }
  return g;
}

// ================================================================
//  STRUCTURES
// ================================================================
export function buildStructure(stype: StructType, teamColor: number): THREE.Group {
  const g = new THREE.Group();
  const accent = mat(teamColor, { emissive: teamColor, emissiveIntensity: 0.35 });
  const dark = mat(HULL_DARK);
  const mid = mat(HULL_MID);
  const light = mat(HULL_LIGHT);

  switch (stype) {
    case 'station': {
      g.add(cyl(9, 11, 6, 8, mid, 0, 0, 0));
      g.add(cyl(5, 5, 9, 8, light, 0, 2, 0));
      g.add(cyl(2.5, 2.5, 12, 6, accent, 0, 3, 0));
      // anneau rotatif
      const ring = new THREE.Mesh(new THREE.TorusGeometry(16, 1.6, 6, 10), accent);
      ring.rotation.x = Math.PI / 2;
      ring.name = 'ring';
      g.add(ring);
      // bras
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        g.add(box(10, 1.6, 2, dark, Math.cos(a) * 10, 0, Math.sin(a) * 10, -a));
      }
      // balises lumineuses
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        g.add(box(1, 3.5, 1, mat(0xffd84b, { emissive: 0xffd84b, emissiveIntensity: 1.4 }), Math.cos(a) * 14, 2, Math.sin(a) * 14));
      }
      break;
    }
    case 'avantposte': {
      g.add(cyl(5, 7, 5, 6, mid));
      g.add(cyl(2, 3, 7, 6, dark, 0, 3, 0));
      const turret = new THREE.Mesh(new THREE.SphereGeometry(3, 6, 4), accent);
      turret.position.y = 7; turret.name = 'turret';
      g.add(turret);
      g.add(box(1.2, 1.2, 6, dark, 0, 7, 0));
      break;
    }
    case 'mine': {
      g.add(cyl(4.5, 6, 5, 6, mid));
      const drill = cone(2.4, 6, 6, mat(0xc8a86b, { metalness: 0.6 }), 0, -4, 0, Math.PI);
      drill.name = 'drill';
      g.add(drill);
      g.add(box(2, 4, 2, accent, 0, 4, 0));
      g.add(box(7, 0.6, 1.4, dark, 0, 2, 0));
      break;
    }
    case 'satellite': {
      g.add(box(2.2, 2.2, 2.2, light));
      const panel = mat(0x2b5fa8, { emissive: 0x2b5fa8, emissiveIntensity: 0.4, metalness: 0.6 });
      g.add(box(7, 0.2, 2.6, panel, 0, 0, 4));
      g.add(box(7, 0.2, 2.6, panel, 0, 0, -4));
      const dish = cone(1.6, 1.4, 8, accent, 0, 2, 0, Math.PI);
      g.add(dish);
      break;
    }
  }
  return g;
}

// ================================================================
//  PLANÈTES — icosaèdre déformé + couleurs par sommet
// ================================================================
export function buildPlanet(ptype: PlanetType, radius: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  const def = PLANET_TYPES[ptype];
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  const colors: number[] = [];
  const cA = new THREE.Color(def.colors[0]);
  const cB = new THREE.Color(def.colors[1]);
  const cC = new THREE.Color(def.colors[2]);
  // bruit déterministe basé sur la POSITION (la géométrie est non indexée :
  // les sommets partagés doivent bouger ensemble, sinon la surface se déchire)
  const randAt = (x: number, y: number, z: number) => {
    const v = Math.sin(seed * 12.9898 + x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return v - Math.floor(v);
  };
  for (let i = 0; i < posAttr.count; i++) {
    const px = posAttr.getX(i), py = posAttr.getY(i), pz = posAttr.getZ(i);
    const r = randAt(Math.round(px * 100) / 100, Math.round(py * 100) / 100, Math.round(pz * 100) / 100);
    const bump = 1 + (r - 0.5) * (ptype === 'gazeuse' || ptype === 'oceanique' ? 0.04 : 0.14);
    posAttr.setXYZ(i, px * bump, py * bump, pz * bump);
    const c = r < 0.4 ? cA : r < 0.75 ? cB : cC;
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0.05 });
  const sphere = new THREE.Mesh(geo, m);
  sphere.name = 'globe';
  g.add(sphere);

  if (def.hasRing) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 1.7, radius * 0.16, 4, 24),
      mat(0xb8a888, { transparent: true, opacity: 0.75 }),
    );
    ring.rotation.x = Math.PI / 2 + 0.25;
    g.add(ring);
  }

  // anneau de possession (activé/coloré par le rendu)
  const owner = new THREE.Mesh(
    new THREE.RingGeometry(radius * 1.25, radius * 1.38, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide }),
  );
  owner.rotation.x = -Math.PI / 2;
  owner.name = 'ownerRing';
  g.add(owner);
  return g;
}

// ================================================================
//  ASTÉROÏDES, GAZ, ÉPAVES
// ================================================================
export function buildRoid(rtype: 'roche' | 'minerai', radius: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.DodecahedronGeometry(radius, 0);
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  // bruit par position (géométrie non indexée : cf. buildPlanet)
  const randAt = (x: number, y: number, z: number) => {
    const v = Math.sin(seed * 91.17 + x * 113.5 + y * 271.9 + z * 57.3) * 24634.63;
    return v - Math.floor(v);
  };
  const rand = (i: number) => {
    const x = Math.sin(seed * 91.17 + i * 45.13) * 24634.63;
    return x - Math.floor(x);
  };
  for (let i = 0; i < posAttr.count; i++) {
    const px = posAttr.getX(i), py = posAttr.getY(i), pz = posAttr.getZ(i);
    const b = 0.75 + randAt(Math.round(px * 100) / 100, Math.round(py * 100) / 100, Math.round(pz * 100) / 100) * 0.5;
    posAttr.setXYZ(i, px * b, py * b, pz * b);
  }
  geo.computeVertexNormals();
  const rock = new THREE.Mesh(geo, mat(rtype === 'minerai' ? 0x6b5f4a : 0x5a616b, { metalness: 0.1 }));
  g.add(rock);
  if (rtype === 'minerai') {
    // cristaux dorés
    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(new THREE.OctahedronGeometry(radius * 0.28, 0), mat(0xffd84b, { emissive: 0xffb830, emissiveIntensity: 0.8 }));
      const a = rand(i + 20) * Math.PI * 2, b2 = rand(i + 40) * Math.PI - Math.PI / 2;
      c.position.set(Math.cos(a) * Math.cos(b2) * radius * 0.85, Math.sin(b2) * radius * 0.85, Math.sin(a) * Math.cos(b2) * radius * 0.85);
      g.add(c);
    }
  }
  return g;
}

export function buildCloud(radius: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({
    color: 0x4bcf8a, emissive: 0x2a8f5a, emissiveIntensity: 0.35,
    transparent: true, opacity: 0.16, flatShading: true, depthWrite: false,
  });
  const rand = (i: number) => { const x = Math.sin(seed * 31.7 + i * 17.3) * 15731.7; return x - Math.floor(x); };
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * (0.3 + rand(i) * 0.4), 0), m);
    const a = rand(i + 10) * Math.PI * 2;
    s.position.set(Math.cos(a) * radius * 0.5 * rand(i + 5), (rand(i + 30) - 0.5) * 6, Math.sin(a) * radius * 0.5 * rand(i + 5));
    g.add(s);
  }
  return g;
}

export function buildWreck(radius: number): THREE.Group {
  const g = new THREE.Group();
  const m = mat(0x3a4048, { metalness: 0.5 });
  const glow = mat(0xffd84b, { emissive: 0xffd84b, emissiveIntensity: 1 });
  g.add(box(radius * 1.6, radius * 0.5, radius * 0.7, m, 0, 0, 0, 0.4));
  g.add(box(radius * 0.9, radius * 0.4, radius * 1.1, m, radius * 0.5, 0, radius * 0.4, -0.7));
  g.add(box(radius * 0.3, radius * 0.3, radius * 0.3, glow, 0, radius * 0.3, 0));
  return g;
}

// ================================================================
//  ASTRES CENTRAUX
// ================================================================
/** Texture radiale du disque d'accrétion (dégradé + stries). */
function accretionTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(128, 128, 30, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,244,214,0.95)');
  grad.addColorStop(0.25, 'rgba(255,190,80,0.85)');
  grad.addColorStop(0.55, 'rgba(255,110,40,0.55)');
  grad.addColorStop(0.85, 'rgba(160,40,20,0.2)');
  grad.addColorStop(1, 'rgba(80,10,5,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  // stries orbitales
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 26; i++) {
    const r = 34 + Math.random() * 92;
    ctx.strokeStyle = `rgba(0,0,0,${0.12 + Math.random() * 0.25})`;
    ctx.lineWidth = 1 + Math.random() * 2;
    ctx.beginPath();
    ctx.arc(128, 128, r, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2 + 2);
    ctx.stroke();
  }
  return new THREE.CanvasTexture(c);
}

export function buildStarBody(starType: StarType, radius: number, color: number): THREE.Group {
  const g = new THREE.Group();
  if (starType === 'trou_noir') {
    const hole = new THREE.Mesh(new THREE.SphereGeometry(radius, 28, 18), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    g.add(hole);
    // anneau de photons : liséré incandescent au bord de l'horizon
    const photon = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 1.12, radius * 0.045, 8, 64),
      new THREE.MeshBasicMaterial({ color: 0xfff4d6 }),
    );
    photon.rotation.x = Math.PI / 2;
    photon.name = 'photon';
    g.add(photon);
    // grand disque d'accrétion texturé
    const tex = accretionTexture();
    const disk = new THREE.Mesh(
      new THREE.RingGeometry(radius * 1.2, radius * 4.2, 72),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    );
    disk.rotation.x = -Math.PI / 2;
    disk.name = 'disk';
    g.add(disk);
    // voile incliné (impression de lentille gravitationnelle)
    const disk2 = new THREE.Mesh(
      new THREE.RingGeometry(radius * 1.15, radius * 2.6, 72),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.65, side: THREE.DoubleSide, depthWrite: false }),
    );
    disk2.rotation.x = -Math.PI / 2 + 0.55;
    disk2.name = 'disk2';
    g.add(disk2);
    return g;
  }
  const sun = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius, 2),
    new THREE.MeshBasicMaterial({ color }),
  );
  sun.name = 'sunCore';
  g.add(sun);
  const corona = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius * 1.15, 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25 }),
  );
  corona.name = 'corona';
  g.add(corona);
  if (starType === 'neutron') {
    // pulsar : faisceaux jumeaux inclinés qui balaient l'espace (rotation dans le rendu)
    const beams = new THREE.Group();
    beams.name = 'beams';
    const beamM = new THREE.MeshBasicMaterial({ color: 0xd8f2ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
    const b1 = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.7, radius * 16, 8, 1, true), beamM);
    b1.position.y = radius * 8; b1.rotation.x = Math.PI;
    const b2 = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.7, radius * 16, 8, 1, true), beamM);
    b2.position.y = -radius * 8;
    beams.add(b1, b2);
    beams.rotation.z = 0.5;   // axe magnétique désaxé
    g.add(beams);
    // disque de plasma équatorial
    const pdisk = new THREE.Mesh(
      new THREE.RingGeometry(radius * 1.6, radius * 3.4, 48),
      new THREE.MeshBasicMaterial({ color: 0x7adfff, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
    );
    pdisk.rotation.x = -Math.PI / 2;
    pdisk.name = 'disk';
    g.add(pdisk);
  }
  return g;
}

// ================================================================
//  DIVERS (projectiles, mines posées)
// ================================================================
export function buildProjectile(color: number, big: boolean): THREE.Mesh {
  const geo = big ? new THREE.OctahedronGeometry(1.6, 0) : new THREE.BoxGeometry(2.2, 0.5, 0.5);
  return new THREE.Mesh(geo, mat(color, { emissive: color, emissiveIntensity: 2.4 }));
}

export function buildMineMesh(color: number): THREE.Group {
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(2, 0), mat(0x3a4048, { metalness: 0.6 }));
  g.add(core);
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.7, 6, 4), mat(color, { emissive: color, emissiveIntensity: 2 }));
  light.position.y = 1.6; light.name = 'blink';
  g.add(light);
  return g;
}
