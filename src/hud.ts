// ============ COBALT SECTOR — HUD, menus, panneaux (DOM) ============
import {
  GameState, MatchConfig, StarType, PersonaId, StructType, GadgetId, V2, dist, len,
  sectorName, territoryOwner, NO_TEAM, PIRATE_TEAM, structById, PlanetType, areAllied, allyKey,
} from './core';
import {
  TEAM_DEFS, PIRATE_DEF, NEUTRAL_CSS, STARS, STAR_LIST, PERSONAS, PERSONA_LIST,
  SHIP_CLASSES, BUYABLE_SHIPS, WEAPONS, UPGRADES, GADGETS, GADGET_ORDER, MODES, STRUCTS,
  STATION_UPGRADE_PRICE, STATION_LEVEL_DESC, MINES, DOCK_RANGE, RES_PRICE, ALLIANCE_DURATION,
} from './data';
import {
  tryBuyShip, tryBuyUpgrade, tryBuyWeapon, tryBuyGadget, tryUpgradeStation, playerShip, teamScore,
} from './sim';
import { fleetShips, missionLabel } from './orders';
import { sfx } from './sfx';

const $ = (id: string) => document.getElementById(id)!;

// ---------- Icônes SVG style « ligne » (aucun emoji dans l'interface) ----------
const IC = (inner: string) =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
export const ICONS: Record<string, string> = {
  plus: IC('<path d="M12 5v14M5 12h14"/>'),
  x: IC('<path d="M18 6 6 18M6 6l12 12"/>'),
  shield: IC('<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"/>'),
  crosshair: IC('<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
  pick: IC('<path d="M3 21L14 10M9 5c4-2.5 9-.5 11 4M9 5l10 4"/>'),
  route: IC('<path d="M5 19h9a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h9"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="7" r="1.6"/>'),
  star: IC('<path d="M12 3l2.6 5.6 6 .7-4.5 4 1.2 5.9L12 16.4 6.7 19.2l1.2-5.9-4.5-4 6-.7z"/>'),
  heart: IC('<path d="M12 20s-7-4.5-9-9c-1.2-3 1-7 4.5-7 2 0 3.5 1 4.5 2.7C13 5 14.5 4 16.5 4 20 4 22.2 8 21 11c-2 4.5-9 9-9 9z"/>'),
  map: IC('<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14"/>'),
  target: IC('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'),
  trash: IC('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  wind: IC('<path d="M3 8h9a2.5 2.5 0 1 0-2.5-2.5M3 12h13a2.5 2.5 0 1 1-2.5 2.5M3 16h7"/>'),
  radar: IC('<path d="M12 12l5.5-5.5M12 4a8 8 0 1 1-8 8"/><circle cx="12" cy="12" r="1.5"/>'),
  eyeoff: IC('<path d="M3 3l18 18M10.5 5.2C15 4 19.5 7 21 12c-.5 1.6-1.4 3-2.6 4.2M6.2 6.2C4.3 7.6 2.8 9.6 2 12c1.5 5 6 8 10 7 1.2-.2 2.3-.7 3.3-1.3"/>'),
  orbit: IC('<circle cx="12" cy="12" r="3"/><path d="M19.5 9.5A8.5 8.5 0 1 1 9.5 4.5"/>'),
  cloud: IC('<path d="M6 18h11a4 4 0 0 0 0-8 6 6 0 0 0-11.3-1A4.5 4.5 0 0 0 6 18z"/>'),
  ghost: IC('<path d="M5 21V11a7 7 0 0 1 14 0v10l-2.3-2-2.4 2-2.3-2-2.3 2-2.4-2z"/><circle cx="9.5" cy="11" r="1"/><circle cx="14.5" cy="11" r="1"/>'),
  rocket: IC('<path d="M12 3c3 2 4 6 4 9l2.5 3.5-3.5-1c-1 2-2 3-3 4-1-1-2-2-3-4l-3.5 1L8 12c0-3 1-7 4-9z"/>'),
  link: IC('<path d="M9 15l6-6M8 12l-2 2a3.5 3.5 0 0 0 5 5l2-2M16 12l2-2a3.5 3.5 0 0 0-5-5l-2 2"/>'),
  refresh: IC('<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>'),
  radio: IC('<circle cx="12" cy="12" r="1.8"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>'),
  flag: IC('<path d="M5 21V4h11l-2 4 2 4H5"/>'),
  home: IC('<path d="M4 11l8-7 8 7v9h-5v-6h-6v6H4z"/>'),
  arrow: IC('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  box: IC('<path d="M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8"/>'),
  ban: IC('<circle cx="12" cy="12" r="8"/><path d="M6.3 6.3l11.4 11.4"/>'),
  check: IC('<path d="M4 13l5 5L20 7"/>'),
};
const MODE_ICONS: Record<string, string> = { croisiere: ICONS.wind, radar: ICONS.radar, espion: ICONS.eyeoff, saut: ICONS.orbit };
const GADGET_ICONS: Record<string, string> = { fumee: ICONS.cloud, camouflage: ICONS.ghost, bouclier_orbital: ICONS.shield, frappe: ICONS.crosshair, soutien: ICONS.rocket };
const AZERTY_DIGITS = ['&', 'é', '"', "'", '(', '-', 'è', '_', 'ç'];

export class HUD {
  onStart: (cfg: MatchConfig) => void = () => {};
  onReplay: () => void = () => {};
  onQuitToMenu: () => void = () => {};
  onResume: () => void = () => {};
  onBadge: (kind: 'mode' | 'gadget', id: string) => void = () => {};
  onBuildPick: (stype: StructType) => void = () => {};
  onFleetCreate: () => void = () => {};
  onFleetDisband: () => void = () => {};
  onFormation: (frm: string) => void = () => {};
  onFleetSelect: (fleetId: number) => void = () => {};

  private cfg: MatchConfig = {
    seed: Math.floor(Math.random() * 1e9),
    playerColorIdx: 1, aiCount: 3, personaChoice: 'aleatoire', starChoice: 'aleatoire', difficulty: 'normal',
  };
  private radarCtx: CanvasRenderingContext2D;
  private sweep = 0;
  private shopTab = 'vaisseaux';
  private gs: GameState | null = null;
  private helpFrom: 'menu' | 'pause' = 'menu';
  private fleetListSig = '';
  private diploSig = '';
  private offersSig = '';
  private curAlert = '';
  private alertRevealT = 0;
  private flashUntil = 0;
  diploOpen = false;
  onFleetMission: (kind: string) => void = () => {};
  onStance: (stance: string) => void = () => {};
  onPlanToggle: () => void = () => {};
  onPlanObjective: () => void = () => {};
  onPlanFilter: (f: string) => void = () => {};
  onPlanClear: () => void = () => {};
  onDiploDefend: (team: number) => void = () => {};
  onDiploPropose: (team: number) => void = () => {};
  onDiploBreak: (team: number) => void = () => {};
  onDiploFocus: (team: number, target: number) => void = () => {};
  onOfferAccept: (id: number) => void = () => {};
  onOfferRefuse: (id: number) => void = () => {};

  constructor() {
    this.radarCtx = ($('radar') as HTMLCanvasElement).getContext('2d')!;
    this.buildMenu();
    this.wireStatic();
  }

  bind(gs: GameState) { this.gs = gs; }

  // ================================================================
  //  MENU PRINCIPAL
  // ================================================================
  private buildMenu() {
    // couleurs
    const colorBox = $('opt-color');
    TEAM_DEFS.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = 'opt-chip color-chip' + (i === this.cfg.playerColorIdx ? ' sel' : '');
      b.style.background = t.cssColor;
      b.style.color = t.cssColor;
      b.title = t.name;
      b.onclick = () => { this.cfg.playerColorIdx = i; this.refreshChips(colorBox, i); sfx.ui(); };
      colorBox.appendChild(b);
    });
    // nb IA
    this.makeChips($('opt-ai'), ['1', '2', '3'], 2, i => this.cfg.aiCount = i + 1);
    // personnalités
    const personaLabels = ['Aléatoire', ...PERSONA_LIST.map(p => PERSONAS[p].nom)];
    this.makeChips($('opt-persona'), personaLabels, 0, i => {
      this.cfg.personaChoice = i === 0 ? 'aleatoire' : PERSONA_LIST[i - 1];
    });
    // étoiles
    const starLabels = ['Aléatoire', ...STAR_LIST.map(s => STARS[s].nom)];
    this.makeChips($('opt-star'), starLabels, 0, i => {
      this.cfg.starChoice = i === 0 ? 'aleatoire' : STAR_LIST[i - 1];
    });
    // difficulté
    this.makeChips($('opt-diff'), ['Facile', 'Normal', 'Difficile'], 1, i => {
      this.cfg.difficulty = (['facile', 'normal', 'difficile'] as const)[i];
    });

    $('btn-start').onclick = () => {
      this.cfg.seed = Math.floor(Math.random() * 1e9);
      sfx.buy();
      this.onStart({ ...this.cfg });
    };
    $('btn-help').onclick = () => { this.helpFrom = 'menu'; this.fillHelp(); $('menu-box').classList.add('hidden'); $('help-box').classList.remove('hidden'); sfx.ui(); };
    $('btn-help-close').onclick = () => {
      $('help-box').classList.add('hidden');
      $('menu-box').classList.remove('hidden');
      if (this.helpFrom === 'pause') {
        // retour à l'écran de pause par-dessus la partie en cours
        $('menu').classList.add('hidden');
        $('pause').classList.remove('hidden');
        this.helpFrom = 'menu';
      }
      sfx.ui();
    };
  }

  private makeChips(box: HTMLElement, labels: string[], sel: number, cb: (i: number) => void) {
    labels.forEach((l, i) => {
      const b = document.createElement('button');
      b.className = 'opt-chip' + (i === sel ? ' sel' : '');
      b.textContent = l;
      b.onclick = () => { cb(i); this.refreshChips(box, i); sfx.ui(); };
      box.appendChild(b);
    });
  }
  private refreshChips(box: HTMLElement, sel: number) {
    [...box.children].forEach((c, i) => c.classList.toggle('sel', i === sel));
  }

  private fillHelp() {
    $('help-content').innerHTML = `
      <h4>PILOTAGE (AZERTY natif)</h4>
      <span class="kbd">Z</span><span class="kbd">Q</span><span class="kbd">S</span><span class="kbd">D</span> déplacer le vaisseau ·
      <span class="kbd">Clic gauche</span>/<span class="kbd">Espace</span> arme principale ·
      <span class="kbd">A</span> (maintenir) verrouillage missile — relâcher quand le réticule est vert ·
      <span class="kbd">E</span> arme secondaire ·
      <span class="kbd">Clic molette</span> larguer une mine ·
      <span class="kbd">F</span> miner (maintenir près d'un astéroïde/nuage) ·
      <span class="kbd">C</span> prendre le contrôle du vaisseau allié le plus proche
      <h4>MODES & GADGETS</h4>
      <span class="kbd">&amp;</span><span class="kbd">é</span><span class="kbd">"</span><span class="kbd">'</span> modes (croisière, radar, espion, saut) ·
      <span class="kbd">(</span><span class="kbd">-</span><span class="kbd">è</span>… gadgets débloqués à la station
      <h4>STRATÉGIE</h4>
      <span class="kbd">Molette</span> zoomer/dézoomer — dézoomez à fond pour la <b>vue tactique</b> ·
      <span class="kbd">Double-clic</span> sélectionner (double-clic + glisser = rectangle, Ctrl = ajouter) ·
      <span class="kbd">J</span> diplomatie (alliances, cibles communes) ·
      <span class="kbd">Clic droit</span> menu d'ordres (attaquer, miner, escorter, coloniser…) ·
      En vue tactique : <span class="kbd">ZQSD</span> déplace la carte, panneau à droite pour créer des <b>flottes</b> et choisir les <b>formations</b>
      <h4>ÉCONOMIE</h4>
      <span class="kbd">B</span> construire (avant-poste, mine, satellite) ·
      <span class="kbd">U</span> boutique de la station (vaisseaux, armes, améliorations) ·
      Vendez roche/minerai/gaz en vous amarrant à votre station · Colonisez les planètes avec un <b>transporteur</b> ·
      Récupérez les épaves en volant dessus
      <h4>RÈGLES</h4>
      Détruisez la <b>station</b> ennemie pour éliminer une équipe. Si la vôtre tombe, c'est perdu.
      À votre mort : réapparition en corvette à la base (améliorations conservées, cargaison perdue).
      Le bouclier se recharge sur l'énergie ; sans énergie ni bouclier, la coque ne se répare plus.
      Gare aux <b>pirates gris</b> : ils chassent les vaisseaux civils mais fuient les flottes armées.`;
  }

  showMenu() {
    $('menu').classList.remove('hidden');
    $('hud').classList.add('hidden');
    $('tacticalbar').classList.add('hidden');
    $('gameover').classList.add('hidden');
    $('pause').classList.add('hidden');
    $('spyvignette').classList.add('hidden');
    this.closePanels();
  }

  enterGame() {
    $('menu').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('gameover').classList.add('hidden');
    $('pause').classList.add('hidden');
    this.closePanels();
    this.fleetListSig = '';
    this.diploSig = '';
    this.offersSig = '';
    this.curAlert = '';
    $('diplo-offers').innerHTML = '';
    this.buildBadges();
  }

  // ================================================================
  //  BADGES (modes + gadgets)
  // ================================================================
  private buildBadges() {
    const box = $('bottomcenter');
    box.innerHTML = '';
    box.style.pointerEvents = 'auto';
    MODES.forEach((m, i) => {
      box.appendChild(this.makeBadge(String(i + 1), MODE_ICONS[m.id] ?? '', m.nom, () => this.onBadge('mode', m.id), `badge-mode-${m.id}`, m.desc));
    });
    GADGET_ORDER.forEach((gid, i) => {
      const g = GADGETS[gid];
      box.appendChild(this.makeBadge(String(5 + i), GADGET_ICONS[gid] ?? '', g.nom, () => this.onBadge('gadget', gid), `badge-gadget-${gid}`, g.desc));
    });
  }

  private makeBadge(key: string, icon: string, name: string, cb: () => void, id: string, tooltip: string): HTMLElement {
    const b = document.createElement('div');
    b.className = 'badge';
    b.id = id;
    b.title = `${name} — ${tooltip}`;
    b.innerHTML = `<span class="b-key">${key}</span><span class="b-icon">${icon}</span><span class="b-name">${name}</span><div class="b-cd" style="height:0"></div>`;
    b.onclick = cb;
    return b;
  }

  private updateBadges(gs: GameState) {
    const ship = playerShip(gs);
    const team = gs.teams[gs.playerTeam];
    MODES.forEach(m => {
      const el = document.getElementById(`badge-mode-${m.id}`);
      if (!el) return;
      el.classList.toggle('active', !!ship && ship.mode === m.id);
      el.classList.toggle('locked', !ship);
      if (m.id === 'saut') {
        const ready = !!ship && ship.energy >= ship.energyMax * 0.85;
        el.classList.toggle('oncd', !ready);
        (el.querySelector('.b-cd') as HTMLElement).style.height = ready ? '0' : '100%';
      }
    });
    GADGET_ORDER.forEach(gid => {
      const el = document.getElementById(`badge-gadget-${gid}`);
      if (!el) return;
      const owned = team.gadgets.includes(gid);
      el.classList.toggle('locked', !owned);
      if (owned) {
        const cdEnd = team.gadgetCd[gid] ?? 0;
        const left = Math.max(0, cdEnd - gs.t);
        const frac = left > 0 ? Math.min(1, left / GADGETS[gid].cd) : 0;
        el.classList.toggle('oncd', left > 0);
        (el.querySelector('.b-cd') as HTMLElement).style.height = `${frac * 100}%`;
      }
    });
  }

  // ================================================================
  //  MISE À JOUR HUD
  // ================================================================
  update(gs: GameState, opts: { tactical: boolean; visible: Set<number>; buildMode: StructType | null; hint: string }) {
    const ship = playerShip(gs);
    const team = gs.teams[gs.playerTeam];

    // barres
    if (ship) {
      this.setBar('bar-hull', 'txt-hull', ship.hull, ship.hullMax);
      this.setBar('bar-shield', 'txt-shield', ship.shield, ship.shieldMax);
      this.setBar('bar-energy', 'txt-energy', ship.energy, ship.energyMax);
      const cls = SHIP_CLASSES[ship.cls];
      $('txt-ship').textContent = `${cls.nom}${ship.mineCount > 0 ? ` · ${ship.mineCount} mine(s) ${MINES[ship.mineType!]?.nom.split(' ').pop() ?? ''}` : ''}`;
      $('txt-cargo').textContent =
        `${Math.floor(ship.cargo.roche)} roche · ${Math.floor(ship.cargo.minerai)} minerai · ${Math.floor(ship.cargo.gaz)} gaz ` +
        `(${Math.floor(ship.cargo.roche + ship.cargo.minerai + ship.cargo.gaz)}/${ship.cargoMax})`;
    } else {
      this.setBar('bar-hull', 'txt-hull', 0, 1);
      this.setBar('bar-shield', 'txt-shield', 0, 1);
      this.setBar('bar-energy', 'txt-energy', 0, 1);
      $('txt-ship').textContent = `réapparition dans ${Math.max(0, team.respawnT).toFixed(1)} s…`;
    }
    $('txt-credits').textContent = `${Math.floor(team.credits)}`;

    // haut-centre : secteur, GPS, territoire
    const pos = ship ? ship.pos : { x: 0, y: 0 };
    $('sectorname').textContent = sectorName(pos);
    $('gps').textContent = `X:${Math.round(pos.x)}  Y:${Math.round(pos.y)}`;
    const owner = territoryOwner(gs, pos);
    const dot = $('territory-dot');
    const label = $('territory-label');
    if (owner === NO_TEAM) { dot.style.background = NEUTRAL_CSS; label.textContent = 'Espace neutre'; }
    else { dot.style.background = TEAM_DEFS[owner].cssColor; label.textContent = `Territoire ${TEAM_DEFS[owner].name}`; }

    // haut-droite
    const mm = Math.floor(gs.t / 60), ss = Math.floor(gs.t % 60);
    $('clock').textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    const starDef = STARS[gs.map.starType];
    $('star-info').textContent = `${gs.map.starName} — ${starDef.desc}`;
    this.updateScores(gs);

    if (gs.map.supernovaAt > 0 && gs.supernovaWave < 0) {
      $('supernova-warn').classList.remove('hidden');
      const left = Math.max(0, gs.map.supernovaAt - gs.t);
      $('supernova-t').textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    } else {
      $('supernova-warn').classList.add('hidden');
    }

    // badges, log, alerte
    this.updateBadges(gs);
    this.updateLog(gs);
    const alert = $('alert');
    if (gs.alertT > 0 && gs.alertText) {
      // séquence radio : allumage, souffle statique, puis le texte s'affiche
      if (this.curAlert !== gs.alertText) {
        this.curAlert = gs.alertText;
        this.alertRevealT = performance.now() + 950;
        sfx.radioOn();
        window.setTimeout(() => sfx.bipbip(), 120);
        window.setTimeout(() => sfx.radioStatic(), 420);
      }
      alert.classList.remove('hidden');
      const now = performance.now();
      if (now < this.alertRevealT) {
        alert.textContent = '- - TRANSMISSION - -';
        alert.classList.add('radio-noise');
        alert.style.color = '';
      } else {
        alert.classList.remove('radio-noise');
        alert.style.color = gs.alertColor;
        const shown = Math.min(this.curAlert.length, Math.floor((now - this.alertRevealT) / 20) + 1);
        alert.textContent = this.curAlert.slice(0, shown);
      }
    } else {
      alert.classList.add('hidden');
      this.curAlert = '';
    }

    if (Date.now() > this.flashUntil) $('hint-bar').textContent = opts.hint;
    this.updateOffers(gs);
    if (this.diploOpen) this.refreshDiplo(gs);

    // vignette espion
    $('spyvignette').classList.toggle('hidden', !(ship && ship.mode === 'espion'));

    // barre tactique
    $('tacticalbar').classList.toggle('hidden', !opts.tactical);
    if (opts.tactical) this.updateFleetList(gs);

    this.drawRadar(gs, opts.visible);
  }

  private setBar(barId: string, txtId: string, v: number, max: number) {
    ($(barId) as HTMLElement).style.width = `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
    $(txtId).textContent = `${Math.ceil(Math.max(0, v))}/${Math.round(max)}`;
  }

  private updateScores(gs: GameState) {
    const box = $('team-scores');
    box.innerHTML = '';
    for (const id of gs.activeTeams) {
      const t = gs.teams[id];
      const ships = gs.ships.filter(s => s.alive && s.team === id).length;
      const planets = gs.planets.filter(p => p.alive && p.owner === id).length;
      const row = document.createElement('div');
      row.className = 'ts-row' + (t.alive ? '' : ' ts-dead');
      const you = id === gs.playerTeam ? ' (vous)' : ` · ${PERSONAS[t.persona].nom}`;
      row.innerHTML = `<span>${t.name}${you} — ${ships} vsx · ${planets} col.</span><span class="ts-dot" style="background:${t.cssColor}"></span>`;
      box.appendChild(row);
    }
  }

  private updateLog(gs: GameState) {
    const box = $('msglog');
    box.innerHTML = '';
    const recent = gs.log.slice(-7).reverse();
    for (const l of recent) {
      const age = gs.t - l.t;
      if (age > 14) continue;
      const div = document.createElement('div');
      div.className = 'log-line';
      div.style.borderLeftColor = l.color;
      div.style.opacity = String(Math.max(0.25, 1 - age / 14));
      div.textContent = l.text;
      box.appendChild(div);
    }
  }

  // ================================================================
  //  RADAR
  // ================================================================
  private drawRadar(gs: GameState, visible: Set<number>) {
    const ctx = this.radarCtx;
    const W = 220, C = W / 2, RANGE = 640;
    const ship = playerShip(gs);
    const center = ship ? ship.pos : { x: 0, y: 0 };
    ctx.clearRect(0, 0, W, W);

    // anneaux
    ctx.strokeStyle = 'rgba(64,196,255,0.18)';
    ctx.lineWidth = 1;
    for (const r of [0.33, 0.66, 1]) {
      ctx.beginPath(); ctx.arc(C, C, C * r - 2, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(C, 4); ctx.lineTo(C, W - 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(4, C); ctx.lineTo(W - 4, C); ctx.stroke();

    // balayage
    this.sweep += 0.03;
    ctx.save();
    ctx.translate(C, C);
    ctx.rotate(this.sweep);
    const sw = ctx.createLinearGradient(0, 0, C, 0);
    sw.addColorStop(0, 'rgba(64,196,255,0.25)');
    sw.addColorStop(1, 'rgba(64,196,255,0)');
    ctx.fillStyle = sw;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, C - 3, -0.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    const toRadar = (p: V2): [number, number] | null => {
      const dx = p.x - center.x, dy = p.y - center.y;
      const d = Math.hypot(dx, dy);
      if (d > RANGE) return null;
      return [C + (dx / RANGE) * (C - 5), C + (dy / RANGE) * (C - 5)];
    };

    // astres
    for (const b of gs.map.bodies) {
      const q = toRadar(b.pos);
      if (!q) continue;
      ctx.fillStyle = gs.map.starType === 'trou_noir' ? '#ff8c42' : `#${(b.color).toString(16).padStart(6, '0')}`;
      ctx.beginPath(); ctx.arc(q[0], q[1], 4, 0, Math.PI * 2); ctx.fill();
    }
    // planètes
    for (const p of gs.planets) {
      if (!p.alive) continue;
      const q = toRadar(p.pos);
      if (!q) continue;
      ctx.strokeStyle = p.owner >= 0 ? TEAM_DEFS[p.owner].cssColor : NEUTRAL_CSS;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(q[0], q[1], 4, 0, Math.PI * 2); ctx.stroke();
    }
    // astéroïdes
    ctx.fillStyle = 'rgba(150,160,175,0.55)';
    for (const r of gs.roids) {
      if (!r.alive) continue;
      const q = toRadar(r.pos);
      if (q) ctx.fillRect(q[0] - 1, q[1] - 1, 2, 2);
    }
    // nuages
    ctx.fillStyle = 'rgba(107,255,138,0.3)';
    for (const c of gs.clouds) {
      if (!c.alive) continue;
      const q = toRadar(c.pos);
      if (q) { ctx.beginPath(); ctx.arc(q[0], q[1], 3, 0, Math.PI * 2); ctx.fill(); }
    }
    // structures
    for (const st of gs.structures) {
      if (!st.alive) continue;
      const q = toRadar(st.pos);
      if (!q) continue;
      ctx.fillStyle = st.team === PIRATE_TEAM ? PIRATE_DEF.cssColor : TEAM_DEFS[st.team]?.cssColor ?? NEUTRAL_CSS;
      const s = st.stype === 'station' ? 5 : 3;
      ctx.fillRect(q[0] - s / 2, q[1] - s / 2, s, s);
    }
    // météores
    ctx.fillStyle = '#ffb35d';
    for (const mt of gs.meteors) {
      const q = toRadar(mt.pos);
      if (q) { ctx.beginPath(); ctx.arc(q[0], q[1], 2.5, 0, Math.PI * 2); ctx.fill(); }
    }
    // épaves
    ctx.fillStyle = 'rgba(255,216,75,0.8)';
    for (const w of gs.wrecks) {
      if (!w.alive) continue;
      const q = toRadar(w.pos);
      if (q) { ctx.beginPath(); ctx.arc(q[0], q[1], 1.5, 0, Math.PI * 2); ctx.fill(); }
    }
    // vaisseaux
    for (const s of gs.ships) {
      if (!s.alive) continue;
      if (s.team !== gs.playerTeam && !visible.has(s.id)) continue;
      const q = toRadar(s.pos);
      if (!q) continue;
      const color = s.team === PIRATE_TEAM ? PIRATE_DEF.cssColor : TEAM_DEFS[s.team]?.cssColor ?? '#fff';
      ctx.fillStyle = color;
      const r = s.isFlagship ? 3 : 2;
      ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, Math.PI * 2); ctx.fill();
    }
    // joueur au centre
    if (ship) {
      ctx.save();
      ctx.translate(C, C);
      ctx.rotate(ship.heading + Math.PI / 2);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(0, -5); ctx.lineTo(3.5, 4); ctx.lineTo(-3.5, 4);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  // ================================================================
  //  PANNEAUX : CONSTRUCTION & BOUTIQUE
  // ================================================================
  buildOpen = false;
  shopOpen = false;

  toggleBuild(gs: GameState) {
    this.buildOpen = !this.buildOpen;
    if (this.buildOpen) { this.shopOpen = false; $('panel-shop').classList.add('hidden'); this.refreshBuild(gs); }
    $('panel-build').classList.toggle('hidden', !this.buildOpen);
  }

  private refreshBuild(gs: GameState) {
    const box = $('build-list');
    box.innerHTML = '';
    const team = gs.teams[gs.playerTeam];
    (['avantposte', 'mine', 'satellite', 'labo'] as StructType[]).forEach(stype => {
      const def = STRUCTS[stype];
      const item = document.createElement('div');
      const afford = team.credits >= def.prix;
      item.className = 'build-item' + (afford ? '' : ' disabled');
      item.innerHTML = `<span>${def.nom}<span class="s-desc">${def.desc}</span></span><span class="s-price">⬡ ${def.prix}</span>`;
      item.onclick = () => {
        if (!afford) { sfx.error(); return; }
        sfx.ui();
        this.onBuildPick(stype);
        this.toggleBuild(gs);
      };
      box.appendChild(item);
    });
  }

  toggleShop(gs: GameState) {
    this.shopOpen = !this.shopOpen;
    if (this.shopOpen) { this.buildOpen = false; $('panel-build').classList.add('hidden'); this.refreshShop(gs); }
    $('panel-shop').classList.toggle('hidden', !this.shopOpen);
  }

  closePanels() {
    this.buildOpen = false; this.shopOpen = false; this.diploOpen = false;
    $('panel-build').classList.add('hidden');
    $('panel-shop').classList.add('hidden');
    $('panel-diplo').classList.add('hidden');
    this.closeCtxMenu();
  }

  toggleDiplo(gs: GameState) {
    this.diploOpen = !this.diploOpen;
    if (this.diploOpen) {
      this.buildOpen = false; this.shopOpen = false;
      $('panel-build').classList.add('hidden');
      $('panel-shop').classList.add('hidden');
      this.diploSig = '';
      this.refreshDiplo(gs);
    }
    $('panel-diplo').classList.toggle('hidden', !this.diploOpen);
  }

  private refreshDiplo(gs: GameState) {
    const others = gs.activeTeams.filter(id => id !== gs.playerTeam);
    const sig = others.map(id => {
      const t = gs.teams[id];
      return `${id}:${t.alive ? 1 : 0}:${areAllied(gs, gs.playerTeam, id) ? 1 : 0}:${Math.floor(teamScore(gs, id) / 50)}`;
    }).join('|') + `|${Math.floor(gs.teams[gs.playerTeam].credits / 100)}|${Math.floor(gs.t)}`;
    if (sig === this.diploSig) return;
    this.diploSig = sig;
    const box = $('diplo-list');
    box.innerHTML = '';
    for (const id of others) {
      const t = gs.teams[id];
      const allied = areAllied(gs, gs.playerTeam, id);
      const row = document.createElement('div');
      row.className = 'diplo-row';
      const head = document.createElement('div');
      head.className = 'd-head';
      head.innerHTML = `<span class="ts-dot" style="background:${t.cssColor}"></span>` +
        `<b>${t.name}</b> <span class="s-desc">${PERSONAS[t.persona].nom} · score ${teamScore(gs, id)}</span>` +
        `<span class="d-status${allied ? ' allied' : ''}">${t.alive ? (allied ? 'Allié' : 'Neutre') : 'Éliminée'}</span>`;
      row.appendChild(head);
      if (t.alive) {
        const btns = document.createElement('div');
        btns.className = 'd-btns';
        if (!allied) {
          const b = document.createElement('button');
          b.className = 'tb-btn';
          b.innerHTML = ICONS.link + 'Proposer une alliance';
          b.onclick = () => { this.onDiploPropose(id); this.diploSig = ''; };
          btns.appendChild(b);
        } else {
          // durée restante du pacte + renouvellement dans les 2 dernières minutes
          const age = gs.t - (gs.allianceSince[allyKey(gs.playerTeam, id)] ?? 0);
          const left = Math.max(0, ALLIANCE_DURATION - age);
          const timer = document.createElement('span');
          timer.className = 's-desc';
          timer.textContent = `pacte : ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
          btns.appendChild(timer);
          if (left < 120) {
            const rn = document.createElement('button');
            rn.className = 'tb-btn';
            rn.innerHTML = ICONS.refresh + 'Renouveler';
            rn.onclick = () => { this.onDiploPropose(id); this.diploSig = ''; };
            btns.appendChild(rn);
          }
          const bd2 = document.createElement('button');
          bd2.className = 'tb-btn';
          bd2.innerHTML = ICONS.shield + 'Demander de l\'aide';
          bd2.onclick = () => { this.onDiploDefend(id); };
          btns.appendChild(bd2);
          const br = document.createElement('button');
          br.className = 'tb-btn';
          br.innerHTML = ICONS.x + 'Rompre';
          br.onclick = () => { this.onDiploBreak(id); this.diploSig = ''; };
          btns.appendChild(br);
          for (const foe of gs.activeTeams) {
            if (foe === id || foe === gs.playerTeam || !gs.teams[foe].alive) continue;
            if (areAllied(gs, gs.playerTeam, foe)) continue;
            const bf = document.createElement('button');
            bf.className = 'tb-btn';
            bf.innerHTML = ICONS.crosshair + `Cibler ${gs.teams[foe].name}`;
            bf.onclick = () => { this.onDiploFocus(id, foe); this.diploSig = ''; };
            btns.appendChild(bf);
          }
        }
        row.appendChild(btns);
      }
      box.appendChild(row);
    }
  }

  private updateOffers(gs: GameState) {
    const mine = gs.diploOffers.filter(o => o.to === gs.playerTeam);
    const sig = mine.map(o => `${o.id}:${Math.ceil(o.expiresT - gs.t)}`).join('|');
    if (sig === this.offersSig) return;
    this.offersSig = sig;
    const box = $('diplo-offers');
    box.innerHTML = '';
    for (const o of mine) {
      const from = gs.teams[o.from];
      const div = document.createElement('div');
      div.className = 'offer-box';
      const txt = o.type === 'alliance'
        ? `<b style="color:${from.cssColor}">${from.name}</b> vous propose une <b>alliance</b>.`
        : o.type === 'defend'
          ? `<b style="color:${from.cssColor}">${from.name}</b> appelle à l'aide : sa base est <b>attaquée</b> !`
          : `<b style="color:${from.cssColor}">${from.name}</b> vous demande de cibler <b>${gs.teams[o.target ?? 0]?.name}</b>.`;
      div.innerHTML = `<div class="o-title">${ICONS.radio}TRANSMISSION ENTRANTE</div>${txt}`;
      const btns = document.createElement('div');
      btns.className = 'o-btns';
      const ok = document.createElement('button');
      ok.className = 'tb-btn';
      ok.innerHTML = ICONS.check + 'Accepter';
      ok.onclick = () => { this.onOfferAccept(o.id); this.offersSig = ''; };
      const no = document.createElement('button');
      no.className = 'tb-btn';
      no.innerHTML = ICONS.x + 'Refuser';
      no.onclick = () => { this.onOfferRefuse(o.id); this.offersSig = ''; };
      const timer = document.createElement('span');
      timer.className = 'o-timer';
      timer.textContent = `${Math.max(0, Math.ceil(o.expiresT - gs.t))} s`;
      btns.appendChild(ok); btns.appendChild(no); btns.appendChild(timer);
      div.appendChild(btns);
      box.appendChild(div);
    }
  }

  private wireStatic() {
    document.querySelectorAll('.shop-tab').forEach(el => {
      (el as HTMLElement).onclick = () => {
        this.shopTab = (el as HTMLElement).dataset.tab!;
        document.querySelectorAll('.shop-tab').forEach(e2 => e2.classList.toggle('active', e2 === el));
        if (this.gs) this.refreshShop(this.gs);
        sfx.ui();
      };
    });
    $('btn-resume').onclick = () => this.onResume();
    $('btn-quit').onclick = () => this.onQuitToMenu();
    $('btn-pause-help').onclick = () => {
      this.helpFrom = 'pause';
      this.fillHelp();
      $('pause').classList.add('hidden');
      $('menu').classList.remove('hidden');
      $('menu-box').classList.add('hidden');
      $('help-box').classList.remove('hidden');
    };
    $('btn-replay').onclick = () => this.onReplay();
    $('btn-tomenu').onclick = () => this.onQuitToMenu();
    $('btn-fleet-create').onclick = () => this.onFleetCreate();
    $('btn-fleet-disband').onclick = () => this.onFleetDisband();
    document.querySelectorAll('#tb-formations .frm').forEach(el => {
      (el as HTMLElement).onclick = () => this.onFormation((el as HTMLElement).dataset.frm!);
    });
    document.querySelectorAll('#tb-missions .msn').forEach(el => {
      (el as HTMLElement).onclick = () => this.onFleetMission((el as HTMLElement).dataset.msn!);
    });
    document.querySelectorAll('#tb-stances .stc').forEach(el => {
      (el as HTMLElement).onclick = () => this.onStance((el as HTMLElement).dataset.stc!);
    });
    document.querySelectorAll('#tb-plan .pfl').forEach(el => {
      (el as HTMLElement).onclick = () => {
        document.querySelectorAll('#tb-plan .pfl').forEach(e2 => e2.classList.toggle('active', e2 === el));
        this.onPlanFilter((el as HTMLElement).dataset.pfl!);
      };
    });
    $('btn-plan-toggle').onclick = () => this.onPlanToggle();
    $('btn-plan-obj').onclick = () => this.onPlanObjective();
    $('btn-plan-clear').onclick = () => this.onPlanClear();
    // injecte les icônes SVG dans tous les boutons marqués data-ic
    document.querySelectorAll<HTMLElement>('[data-ic]').forEach(el => {
      const ic = ICONS[el.dataset.ic!];
      if (ic) el.innerHTML = ic + el.textContent!.trim();
    });
  }

  refreshShop(gs: GameState) {
    const box = $('shop-list');
    box.innerHTML = '';
    const team = gs.teams[gs.playerTeam];
    const ship = playerShip(gs);
    const station = structById(gs, team.stationId);
    const lvl = station?.level ?? 0;

    const addItem = (html: string, price: number, cb: (() => string | null) | null, opts: { owned?: boolean; lockText?: string } = {}) => {
      const item = document.createElement('div');
      const afford = team.credits >= price;
      item.className = 'shop-item' + (opts.owned ? ' owned' : '') + ((!cb || !afford) && !opts.owned ? ' disabled' : '');
      item.innerHTML = html + (opts.lockText ? `<span class="s-price">${opts.lockText}</span>` : `<span class="s-price">${opts.owned ? '✓' : `⬡ ${price}`}</span>`);
      if (cb && !opts.owned) {
        item.onclick = () => {
          // relit les crédits au moment du clic (ils évoluent panneau ouvert)
          if (team.credits < price) { sfx.error(); return; }
          const err = cb();
          if (err) { sfx.error(); this.flashHint(err); }
          else { sfx.buy(); this.refreshShop(gs); }
        };
      }
      box.appendChild(item);
    };

    if (this.shopTab === 'vaisseaux') {
      for (const cls of BUYABLE_SHIPS) {
        const def = SHIP_CLASSES[cls];
        const locked = lvl < def.unlockLevel;
        const label = `<span>${def.nom} <span class="s-desc">${def.role} — ${def.desc}</span></span>`;
        if (locked) {
          addItem(label, def.prix, null, { lockText: `Station niv. ${def.unlockLevel}` });
        } else {
          // deux actions : piloter ou recruter
          const item = document.createElement('div');
          const afford = team.credits >= def.prix;
          item.className = 'shop-item' + (afford ? '' : ' disabled');
          item.innerHTML = `${label}<span class="s-price">⬡ ${def.prix}</span>`;
          const btns = document.createElement('span');
          btns.style.display = 'flex'; btns.style.gap = '4px';
          const mk = (txt: string, pilot: boolean) => {
            const b = document.createElement('button');
            b.className = 'tb-btn'; b.textContent = txt;
            b.onclick = e => {
              e.stopPropagation();
              const err = tryBuyShip(gs, gs.playerTeam, cls, pilot);
              if (err) { sfx.error(); this.flashHint(err); } else { sfx.buy(); this.refreshShop(gs); }
            };
            return b;
          };
          btns.appendChild(mk('Piloter', true));
          btns.appendChild(mk('Recruter', false));
          item.appendChild(btns);
          box.appendChild(item);
        }
      }
    } else if (this.shopTab === 'armes') {
      if (!ship) return;
      const slots = SHIP_CLASSES[ship.cls].secondarySlots;
      const info = document.createElement('div');
      info.className = 'panel-hint';
      info.textContent = `Emplacements secondaires : ${Math.max(0, ship.weapons.length - 1)}/${slots} (tir avec A / E)`;
      box.appendChild(info);
      for (const wid of ['canon_auto', 'laser', 'stase', 'plasma', 'torpille', 'canon_lourd'] as const) {
        const def = WEAPONS[wid];
        const owned = ship.weapons.some(w => w.wid === wid);
        addItem(`<span>${def.nom} <span class="s-desc">${def.desc} · dégâts ${def.dmg} · portée ${def.range}</span></span>`, def.prix,
          () => tryBuyWeapon(gs, gs.playerTeam, wid), { owned });
      }
    } else if (this.shopTab === 'ameliorations') {
      for (const u of UPGRADES) {
        const cur = team.upgrades[u.id] ?? 0;
        const maxed = cur >= u.prix.length;
        const price = maxed ? 0 : u.prix[cur];
        addItem(`<span>${u.nom} <b>${'▮'.repeat(cur)}${'▯'.repeat(u.prix.length - cur)}</b> <span class="s-desc">${u.desc}</span></span>`,
          price, maxed ? null : () => tryBuyUpgrade(gs, gs.playerTeam, u.id), { owned: maxed });
      }
    } else if (this.shopTab === 'station') {
      if (station && station.level < 3) {
        addItem(`<span>Améliorer la station (niv. ${station.level} → ${station.level + 1}) <span class="s-desc">${STATION_LEVEL_DESC[station.level]}</span></span>`,
          STATION_UPGRADE_PRICE[station.level], () => tryUpgradeStation(gs, gs.playerTeam));
      } else {
        const d = document.createElement('div');
        d.className = 'panel-hint';
        d.textContent = 'Station au niveau maximum.';
        box.appendChild(d);
      }
      for (const gid of GADGET_ORDER) {
        const def = GADGETS[gid];
        const owned = team.gadgets.includes(gid);
        const locked = lvl < def.unlockLevel;
        if (locked && !owned) {
          addItem(`<span>${def.icon} ${def.nom} <span class="s-desc">${def.desc}</span></span>`, def.prix, null, { lockText: `Station niv. ${def.unlockLevel}` });
        } else {
          addItem(`<span>${def.icon} ${def.nom} <span class="s-desc">${def.desc} · recharge ${def.cd}s</span></span>`, def.prix,
            () => tryBuyGadget(gs, gs.playerTeam, gid), { owned });
        }
      }
    }
  }

  flashHint(text: string) {
    $('hint-bar').textContent = text;
    this.flashUntil = Date.now() + 2500;
  }

  /** Flash plein écran (supernova, explosion planétaire). */
  flashScreen() {
    const el = $('flash');
    el.classList.remove('hidden');
    el.classList.add('on');
    window.setTimeout(() => el.classList.remove('on'), 80);
    window.setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ================================================================
  //  VUE TACTIQUE : liste des flottes
  // ================================================================
  private updateFleetList(gs: GameState) {
    const box = $('tb-fleets');
    const mine = gs.fleets.filter(f => f.team === gs.playerTeam);
    // ne reconstruit le DOM que si le contenu change, sinon les onclick meurent
    // entre mousedown et mouseup (lignes recréées à chaque frame)
    const sig = mine.map(f => `${f.id}:${fleetShips(gs, f).length}:${missionLabel(gs, f)}:${f.formation}`).join('|');
    if (sig === this.fleetListSig) return;
    this.fleetListSig = sig;
    box.innerHTML = '';
    if (mine.length === 0) {
      const d = document.createElement('div');
      d.className = 'tb-label';
      d.textContent = 'Aucune flotte. Sélectionnez ≥ 2 vaisseaux puis « Créer flotte ».';
      box.appendChild(d);
      return;
    }
    for (const f of mine) {
      const row = document.createElement('div');
      row.className = 'fleet-row';
      const n = fleetShips(gs, f).length;
      row.innerHTML = `<span>▸ ${f.name} (${n})</span><span class="f-mission">${missionLabel(gs, f)} · ${f.formation}</span>`;
      row.onclick = () => this.onFleetSelect(f.id);
      box.appendChild(row);
    }
  }

  // ================================================================
  //  MENU CONTEXTUEL & RECTANGLE DE SÉLECTION
  // ================================================================
  openCtxMenu(x: number, y: number, title: string, items: { label: string; cb: () => void; ic?: string }[]) {
    const menu = $('ctxmenu');
    menu.innerHTML = `<div class="ctx-title">${title}</div>`;
    for (const it of items) {
      const d = document.createElement('div');
      d.className = 'ctx-item';
      d.innerHTML = (it.ic && ICONS[it.ic] ? ICONS[it.ic] : '') + it.label;
      d.onclick = () => { it.cb(); this.closeCtxMenu(); sfx.ui(); };
      menu.appendChild(d);
    }
    menu.classList.remove('hidden');
    const mw = 190, mh = items.length * 30 + 26;
    menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - mh - 8)}px`;
  }
  closeCtxMenu() { $('ctxmenu').classList.add('hidden'); }
  get ctxOpen(): boolean { return !$('ctxmenu').classList.contains('hidden'); }

  setPlanUI(mode: 'off' | 'staging' | 'objective', armed: boolean, hint: string) {
    $('btn-plan-toggle').classList.toggle('active', mode !== 'off');
    $('btn-plan-obj').classList.toggle('active', mode === 'objective');
    const ph = $('plan-hint');
    ph.textContent = hint;
    ph.style.color = armed ? '#ff4b4b' : '';
  }

  setSelectBox(r: { x0: number; y0: number; x1: number; y1: number } | null) {
    const el = $('selectbox');
    if (!r) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.style.left = `${r.x0}px`; el.style.top = `${r.y0}px`;
    el.style.width = `${r.x1 - r.x0}px`; el.style.height = `${r.y1 - r.y0}px`;
  }

  // ================================================================
  //  PAUSE & FIN DE PARTIE
  // ================================================================
  showPause(show: boolean) {
    $('pause').classList.toggle('hidden', !show);
  }

  showGameOver(gs: GameState) {
    const won = gs.winner === gs.playerTeam;
    const title = $('go-title');
    title.textContent = won ? 'VICTOIRE' : 'DÉFAITE';
    title.className = won ? 'win' : 'lose';
    $('go-reason').textContent = gs.overReason || (won ? '' : `L'équipe ${gs.winner >= 0 ? TEAM_DEFS[gs.winner].name : '?'} l'emporte.`);
    const stats = $('go-stats');
    stats.innerHTML = '';
    const rows = gs.activeTeams
      .map(id => ({ id, t: gs.teams[id], score: teamScore(gs, id) }))
      .sort((a, b) => b.score - a.score);
    for (const r of rows) {
      const div = document.createElement('div');
      div.className = 'gs-row';
      const planets = gs.planets.filter(p => p.alive && p.owner === r.id).length;
      div.innerHTML = `<span class="ts-dot" style="background:${r.t.cssColor}"></span>` +
        `<b>${r.t.name}</b>${r.id === gs.playerTeam ? ' (vous)' : ` — ${PERSONAS[r.t.persona].nom}`}` +
        `<span style="margin-left:auto">${r.t.alive ? '' : '[détruite] '} ${r.t.kills} kills · ${planets} colonies · score ${r.score}</span>`;
      stats.appendChild(div);
    }
    $('gameover').classList.remove('hidden');
  }
  hideGameOver() { $('gameover').classList.add('hidden'); }
}
