// ============ COBALT SECTOR — point d'entrée & boucle de jeu ============
import {
  GameState, MatchConfig, SIM_DT, V2, dist, clamp, turnToward, StructType, GadgetId,
  structById, shipById, planetById, PIRATE_TEAM, areAllied, OrderKind, PlanFilter, Stance,
} from './core';
import {
  SHIP_CLASSES, DOCK_RANGE, MINES, GADGET_ORDER, MODES, STRUCTS, GUARD_COST, PLANET_UPGRADE_COST,
  OUTPOST_UPGRADE_PRICE, OUTPOST_MAX_LEVEL,
} from './data';
import { newGame } from './world';
import {
  simTick, playerShip, playerMine, dropMine, toggleMode, tryJump, activateGadget,
  takeControlNearest, placeStructure, canPlaceStructure, fireShipWeapon,
  tryBuyShip, tryBuyUpgrade, tryBuyWeapon, tryBuyGadget, tryUpgradeStation, tryBuyStationUpgrade, tryUpgradeOutpost,
  missileSlot, lockTick, lockRelease, lockCancel, nearestIncomingMissile, enemyLockingShip,
  colossusLockTick, colossusSalveRelease, colossusWorldBreaker, colossusStatus,
  proposeAlliance, breakAlliance, requestFocus, acceptOffer, refuseOffer, buyGuards,
  tryUpgradePlanet, requestDefend,
} from './sim';
import { setFleetMission, removeFromFleet } from './orders';
import { canDetect, speedMult } from './entities';
import { createFleet, disbandFleet, issueOrder, fleetShips } from './orders';
import { Renderer3D } from './render3d';
import { HUD } from './hud';
import { Input } from './input';
import { initAudio, playFx, sfx, engineLevel } from './sfx';
import { Net } from './net';
import { cmd, setCmdExec } from './bus';
import { setAllianceCheck } from './entities';
import {
  missileFireCmd, salveFireCmd, flagshipOf,
} from './sim';
import { areAllied as areAlliedFn } from './core';

const canvas = document.getElementById('c3d') as HTMLCanvasElement;
const hud = new HUD();
const input = new Input(document.getElementById('app')!);
let renderer: Renderer3D | null = null;

let gs: GameState | null = null;
let paused = false;
let buildMode: StructType | null = null;
let overShown = false;
let lastCfg: MatchConfig | null = null;
let accumulator = 0;
let lastTime = performance.now();
let lockWasReady = false;
let lockTickT = 0;
let missileWarnT = 0;
let lockWarnT = 0;
let prevNova = -1;
let planMode: 'off' | 'staging' | 'objective' = 'off';
let sirenT = 0;
let net: Net | null = null;
let mpMode = false;
let mpLockT = 0;
let mpSalveTargets: number[] = [];
let mpFirstSnap = true;
let curThrust = { x: 0, y: 0 };
let curFire = false;
let curFireE = false;
let introT = 0;                    // intro hypersaut en cours (>0)
let introStars: { a: number; r: number; sp: number }[] = [];
// multijoueur : écart position affichée ↔ serveur, résorbé en douceur (anti-saccades)
const mpErr = new Map<number, { x: number; y: number }>();
// jeton de session multijoueur : survit au rechargement de la page et permet de
// retrouver sa place dans une partie en cours après une coupure de connexion
const mpToken = (() => {
  let t = localStorage.getItem('cobalt.token');
  if (!t) {
    t = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    localStorage.setItem('cobalt.token', t);
  }
  return t;
})();
let rejoinTries = 0;

window.addEventListener('resize', () => renderer?.resize());
// l'audio ne peut démarrer qu'après un geste utilisateur
window.addEventListener('pointerdown', () => initAudio(), { once: true });
window.addEventListener('keydown', () => initAudio(), { once: true });

// ================================================================
//  DÉMARRAGE / FIN
// ================================================================
hud.onStart = cfg => startGame(cfg);
hud.onReplay = () => {
  if (mpMode) { leaveMp(); return; }
  if (lastCfg) startGame({ ...lastCfg, seed: Math.floor(Math.random() * 1e9) });
};
hud.onQuitToMenu = () => {
  if (mpMode) { leaveMp(); return; }
  gs = null; paused = false;
  introT = 0;
  document.getElementById('intro')!.classList.add('hidden');
  hud.showMenu();
};
hud.onResume = () => { paused = false; hud.showPause(false); };

/** Exécution locale des commandes du bus (mode solo). */
function localExec(name: string, a: any): string | null {
  if (!gs) return 'Aucune partie';
  const team = gs.playerTeam;
  const own = (ids: number[]) => (ids ?? []).filter((id: number) => shipById(gs!, id)?.team === team);
  switch (name) {
    case 'buyShip': return tryBuyShip(gs, team, a.cls, !!a.pilot);
    case 'buyUpgrade': return tryBuyUpgrade(gs, team, a.id);
    case 'buyWeapon': return tryBuyWeapon(gs, team, a.wid);
    case 'buyGadget': return tryBuyGadget(gs, team, a.gid);
    case 'upgradeStation': return tryUpgradeStation(gs, team);
    case 'stationUp': return tryBuyStationUpgrade(gs, team, a.id);
    case 'outpostUp': return tryUpgradeOutpost(gs, team, a.structId);
    case 'place': return placeStructure(gs, team, a.stype, a.pos);
    case 'planetUp': return tryUpgradePlanet(gs, team, a.planetId);
    case 'guards': return buyGuards(gs, team, a.targetId);
    case 'gadget': return activateGadget(gs, team, a.gid, a.targetId);
    case 'mode': {
      const f = playerShip(gs);
      if (!f) return 'Aucun vaisseau';
      if (a.mode === 'saut') return tryJump(gs, f);
      toggleMode(gs, f, a.mode);
      return null;
    }
    case 'takeControl': return takeControlNearest(gs);
    case 'mine': {
      const f = playerShip(gs);
      return f && dropMine(gs, f, a.aim) ? null : 'Aucune mine disponible';
    }
    case 'order': issueOrder(gs, own(a.ids), a.order); return null;
    case 'protect': {
      for (const id of own(a.ids)) {
        const sh = shipById(gs, id);
        if (sh) { removeFromFleet(gs, sh); sh.order = { kind: 'orbit', targetId: a.targetId }; }
      }
      return null;
    }
    case 'fleetCreate': return createFleet(gs, team, own(a.ids)) ? null : 'Sélectionnez au moins 1 vaisseau';
    case 'fleetDisband': { const f = gs.fleets.find(x => x.id === a.fleetId && x.team === team); if (f) disbandFleet(gs, f.id); return null; }
    case 'fleetMission': { const f = gs.fleets.find(x => x.id === a.fleetId && x.team === team); if (f) setFleetMission(gs, f, a.mission); return null; }
    case 'fleetFormation': { const f = gs.fleets.find(x => x.id === a.fleetId && x.team === team); if (f) f.formation = a.frm; return null; }
    case 'fleetStance': { const f = gs.fleets.find(x => x.id === a.fleetId && x.team === team); if (f) f.stance = a.stance as Stance; return null; }
    case 'planFilter': gs.plans[team].filter = a.filter; return null;
    case 'planObjective': gs.plans[team].objective = a.pos; gs.plans[team].armed = false; return null;
    case 'planArm': gs.plans[team].armed = true; return null;
    case 'planClear': {
      gs.plans[team] = { filter: 'tout', objective: null, armed: false };
      for (const f of gs.fleets) {
        if (f.team === team && f.mission.kind === 'plan') setFleetMission(gs, f, { kind: 'guard', pos: shipById(gs, f.leaderId)?.pos });
      }
      return null;
    }
    case 'missileFire': return missileFireCmd(gs, team, a.targetId);
    case 'salveFire': return salveFireCmd(gs, team, a.targets);
    case 'breaker': { const f = playerShip(gs); return f ? colossusWorldBreaker(gs, f, a.aim) : 'Aucun vaisseau'; }
    case 'diploPropose': return proposeAlliance(gs, team, a.team);
    case 'diploBreak': breakAlliance(gs, team, a.team); return null;
    case 'diploFocus': return requestFocus(gs, team, a.team, a.target);
    case 'diploDefend': return requestDefend(gs, team, a.team);
    case 'offerAccept': acceptOffer(gs, a.id); return null;
    case 'offerRefuse': refuseOffer(gs, a.id); return null;
    default: return `Commande inconnue : ${name}`;
  }
}

function startGame(cfg: MatchConfig) {
  lastCfg = cfg;
  mpMode = false;
  setCmdExec(localExec);
  gs = newGame(cfg);
  hud.bind(gs);
  hud.enterGame();
  hud.hideGameOver();
  overShown = false;
  paused = false;
  buildMode = null;
  visibleSet = new Set();
  visT = 0;
  accumulator = 0;
  lockWasReady = false;
  prevNova = -1;
  planMode = 'off';
  sirenT = 0;
  input.endFrame();
  if (!renderer) renderer = new Renderer3D(canvas);
  else renderer.reset();
  const ship = playerShip(gs);
  if (ship) renderer.camPos = { ...ship.pos };
  renderer.camH = 130;

  // intro hypersaut : étoiles qui défilent, flash, et on surgit à la base
  introT = 2.6;
  introStars = Array.from({ length: 260 }, () => ({
    a: Math.random() * Math.PI * 2,
    r: 20 + Math.random() * 500,
    sp: 0.6 + Math.random() * 1.6,
  }));
  document.getElementById('intro')!.classList.remove('hidden');
  sfx.hyper();
}

/** Une frame de l'animation d'hypersaut (canvas 2D plein écran). */
function drawIntro(dt: number) {
  const cv = document.getElementById('introCanvas') as HTMLCanvasElement;
  if (cv.width !== window.innerWidth) { cv.width = window.innerWidth; cv.height = window.innerHeight; }
  const ctx = cv.getContext('2d')!;
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;
  ctx.fillStyle = 'rgba(2,3,10,0.5)';
  ctx.fillRect(0, 0, W, H);
  const speed = 1 + (2.6 - introT) * 3;   // accélère au fil du saut
  for (const st of introStars) {
    st.r += st.sp * speed * dt * 260;
    if (st.r > Math.hypot(W, H) * 0.6) { st.r = 10 + Math.random() * 60; st.a = Math.random() * Math.PI * 2; }
    const x1 = cx + Math.cos(st.a) * st.r;
    const y1 = cy + Math.sin(st.a) * st.r * 0.85;
    const tail = Math.min(st.r * 0.35, 24 + speed * 22);
    const x0 = cx + Math.cos(st.a) * (st.r - tail);
    const y0 = cy + Math.sin(st.a) * (st.r - tail) * 0.85;
    const b2 = Math.min(1, st.r / 260);
    ctx.strokeStyle = `rgba(${180 + b2 * 75}, ${210 + b2 * 45}, 255, ${0.25 + b2 * 0.7})`;
    ctx.lineWidth = 1 + b2 * 1.6;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
}

// ================================================================
//  ENTRÉES
// ================================================================
function handleInput(dt: number) {
  if (!gs || !renderer) return;
  const tactical = renderer.isTactical();
  const ship = playerShip(gs);
  const aim = renderer.worldFromScreen(input.mouseX, input.mouseY);

  // ---------- Échap ----------
  if (input.pressed('Escape')) {
    if (hud.ctxOpen) hud.closeCtxMenu();
    else if (planMode !== 'off') { planMode = 'off'; }
    else if (buildMode) { buildMode = null; }
    else if (hud.buildOpen || hud.shopOpen || hud.diploOpen) hud.closePanels();
    else { paused = !paused; hud.showPause(paused); }
  }
  if (paused) return;

  // ---------- Zoom ----------
  if (input.wheel !== 0) {
    // large champ de vision — encore plus au commandes du Colosse
    const maxH = ship?.cls === 'colosse' ? 1600 : 1250;
    renderer.camH = clamp(renderer.camH * Math.exp(input.wheel * 0.0012), 48, maxH);
  }

  // ---------- Déplacement : vaisseau (vue action) ou carte (vue tactique) ----------
  const dir = { x: 0, y: 0 };
  if (input.down('KeyD')) dir.x += 1;
  if (input.down('KeyA')) dir.x -= 1;   // Q en AZERTY
  if (input.down('KeyS')) dir.y += 1;
  if (input.down('KeyW')) dir.y -= 1;   // Z en AZERTY
  if (tactical) {
    const speed = renderer.camH * 1.1;
    renderer.camPos.x += dir.x * speed * dt;
    renderer.camPos.y += dir.y * speed * dt;
  } else if (ship && ship.empT <= 0 && ship.jumpT <= 0) {
    curThrust = { x: dir.x, y: dir.y };
    if (dir.x !== 0 || dir.y !== 0) {
      const l = Math.hypot(dir.x, dir.y);
      const def = SHIP_CLASSES[ship.cls];
      ship.vel.x += (dir.x / l) * def.accel * dt;
      ship.vel.y += (dir.y / l) * def.accel * dt;
    }
  } else {
    curThrust = { x: 0, y: 0 };
  }

  // ---------- Tir & verrouillage missile ----------
  // Le COLOSSE a ses propres commandes : rayons automatiques,
  // A = salve multi-cibles, E = Brise-Monde
  if (!tactical && ship && ship.cls === 'colosse') {
    if (input.down('KeyQ')) {
      const st = colossusLockTick(gs, ship, dt);
      if (mpMode) {
        // en multi, la progression du verrouillage est tenue localement
        mpLockT = Math.min(1.5, mpLockT + dt);
        ship.lockT = mpLockT;
        st.progress = mpLockT / 1.5;
        st.ready = mpLockT >= 1.5;
      }
      mpSalveTargets = st.targets;
      renderer.setMultiLock(st);
      if (st.targets.length > 0) {
        lockTickT -= dt;
        if (!st.ready && lockTickT <= 0) { sfx.lockTick(); lockTickT = 0.14; }
        if (st.ready && !lockWasReady) sfx.lockOn();
        lockWasReady = st.ready;
      }
    } else {
      if ((mpMode ? mpLockT : ship.lockT) >= 1.5 && mpSalveTargets.length > 0) {
        const err = cmd('salveFire', { targets: mpSalveTargets });
        if (!err) sfx.shoot('missile');
      }
      if (!mpMode && ship.lockT > 0) lockCancel(ship);
      mpLockT = 0;
      mpSalveTargets = [];
      lockWasReady = false;
      renderer.setMultiLock(null);
    }
    if (input.pressed('KeyE')) {
      const err = cmd('breaker', { aim });
      if (err) { sfx.error(); hud.flashHint(err); } else sfx.bigBoom();
    }
  }

  const hasMissile = ship ? missileSlot(ship) >= 0 : false;
  let locking = false;
  if (!tactical && ship && ship.cls !== 'colosse') {
    // A maintenu : verrouillage missile (bloque les autres armes pendant la charge)
    if (input.down('KeyQ') && hasMissile) {
      locking = true;
      const st = lockTick(gs, ship, aim, dt);
      if (mpMode && st) {
        mpLockT = Math.min(1.2, mpLockT + dt);
        ship.lockT = mpLockT;
        st.progress = mpLockT / 1.2;
        st.ready = mpLockT >= 1.2;
      }
      renderer.setLockState(st);
      if (st && st.targetId >= 0) {
        lockTickT -= dt;
        if (!st.ready && lockTickT <= 0) { sfx.lockTick(); lockTickT = 0.16; }
        if (st.ready && !lockWasReady) sfx.lockOn();
        lockWasReady = st.ready;
      } else {
        lockWasReady = false;
      }
    } else {
      if (ship.lockT > 0 && !input.down('KeyQ')) {
        // A relâché : tire si verrouillé (validation côté simulation/serveur)
        const ready = (mpMode ? mpLockT : ship.lockT) >= 1.2;
        const tid = ship.lockTargetId;
        if (ready && tid >= 0) {
          if (!cmd('missileFire', { targetId: tid })) sfx.shoot('missile');
        }
        if (!mpMode) lockCancel(ship);
        lockWasReady = false;
      }
      mpLockT = 0;
      renderer.setLockState(null);
    }

    if (!locking) {
      // le tir est sur ESPACE uniquement : le clic gauche ne sert plus qu'à sélectionner
      curFire = input.down('Space');
      if (curFire && !mpMode) fireShipWeapon(gs, ship, 0, aim);
      if (!mpMode && input.down('KeyQ') && !hasMissile) fireShipWeapon(gs, ship, 1, aim);  // A en AZERTY
      curFireE = input.down('KeyE');
      if (!mpMode && curFireE) fireShipWeapon(gs, ship, 2, aim);
    }
  } else if (!ship || tactical) {
    renderer.setLockState(null);
    if (ship && ship.lockT > 0 && ship.id === gs.playerShipId && ship.cls !== 'colosse') lockCancel(ship);
  }

  // ---------- Minage manuel ----------
  if (!mpMode && ship && input.down('KeyF')) {
    const res = playerMine(gs, dt);
    if (res && Math.random() < dt * 3) sfx.mine();
  }

  // ---------- Mines larguées ----------
  for (const c of input.middleClicks) {
    const target = renderer.worldFromScreen(c.x, c.y);
    if (!cmd('mine', { aim: target })) sfx.mine();
    else sfx.error();
  }

  // ---------- Modes (& é " ') ----------
  const modeKeys = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];
  modeKeys.forEach((code, i) => {
    if (!input.pressed(code) || !ship) return;
    const m = MODES[i];
    const err = cmd('mode', { mode: m.id });
    if (err) { sfx.error(); hud.flashHint(err); } else sfx.ui();
  });

  // ---------- Gadgets (( - è _ ç) ----------
  GADGET_ORDER.forEach((gid, i) => {
    const code = `Digit${5 + i}`;
    if (!input.pressed(code)) return;
    activateGadgetSmart(gid, aim);
  });
  hud.onBadge = (kind, id) => {
    if (!gs) return;
    const s = playerShip(gs);
    if (kind === 'mode' && s) {
      const err = cmd('mode', { mode: id });
      if (err) { sfx.error(); hud.flashHint(err); }
    } else if (kind === 'gadget') {
      activateGadgetSmart(id as GadgetId, renderer!.worldFromScreen(input.mouseX, input.mouseY));
    }
  };

  // ---------- Divers ----------
  if (input.pressed('KeyC')) {
    const err = cmd('takeControl', {});
    if (err) { sfx.error(); hud.flashHint(err); } else sfx.ui();
  }
  if (input.pressed('KeyB')) hud.toggleBuild(gs);
  if (input.pressed('KeyJ')) hud.toggleDiplo(gs);
  // la boutique se ferme toute seule quand on s'éloigne de la station
  if (hud.shopOpen && ship) {
    const st = structById(gs, gs.teams[gs.playerTeam].stationId);
    if (!st || dist(ship.pos, st.pos) > DOCK_RANGE * 2.2) hud.closePanels();
  }

  // ---------- Sélection par type (T : filtre cyclique ; en tactique, double-clic = même classe) ----------
  if (input.pressed('KeyT') && gs.selection.length > 0) {
    const g3 = gs;
    const classes = [...new Set(g3.selection
      .map(id => shipById(g3, id)?.cls)
      .filter((c): c is NonNullable<typeof c> => !!c))];
    if (classes.length > 1) {
      const first = classes[0];
      g3.selection = g3.selection.filter(id => shipById(g3, id)?.cls === first);
      hud.flashHint(`Sélection : ${SHIP_CLASSES[first].nom} uniquement (T pour cycler).`);
      sfx.ui();
    } else if (classes.length === 1) {
      // recycle : re-sélectionne tous les vaisseaux du même type à l'écran
      const cls = classes[0];
      gs.selection = gs.ships.filter(s2 => s2.alive && s2.team === gs!.playerTeam && s2.cls === cls).map(s2 => s2.id);
      hud.flashHint(`Tous vos ${SHIP_CLASSES[cls].nom}s sélectionnés.`);
      sfx.ui();
    }
  }

  // ---------- Mode plan (P) ----------
  if (input.pressed('KeyP')) {
    planMode = planMode === 'off' ? 'staging' : 'off';
    sfx.ui();
  }
  if (input.pressed('Enter') && gs.plans[gs.playerTeam].objective) {
    cmd('planArm', {});
    hud.flashHint('PLAN EXÉCUTÉ — toutes les flottes avancent sur l\'objectif.');
    sfx.buy();
  }
  if (input.pressed('KeyU')) {
    const st = structById(gs, gs.teams[gs.playerTeam].stationId);
    if (ship && st && dist(ship.pos, st.pos) < DOCK_RANGE * 1.8) hud.toggleShop(gs);
    else hud.flashHint('Approchez-vous de votre station pour ouvrir la boutique (U).');
  }

  // ---------- Clic gauche : sélection (le tir est sur Espace) ----------
  for (const c of input.clicks) {
    // un clic hors d'un menu (contextuel ou circulaire) referme les deux
    if (hud.ctxOpen || hud.radialKind === 'selection') {
      hud.closeCtxMenu();
      if (hud.radialKind === 'selection') hud.hideRadial();
      continue;
    }
    if (buildMode) {
      const pos = renderer.worldFromScreen(c.x, c.y);
      const err = cmd('place', { stype: buildMode, pos });
      if (err) { sfx.error(); hud.flashHint(err); }
      else { sfx.buy(); buildMode = null; }
      continue;
    }
    const picked = renderer.pickEntity(gs, c.x, c.y, visibleSet);
    if (picked != null) {
      const s = shipById(gs, picked);
      if (s && s.team === gs.playerTeam) {
        const g4 = gs;
        const sameClass = (pred: (x: (typeof g4.ships)[number]) => boolean) =>
          g4.ships.filter(x => x.alive && x.team === g4.playerTeam && x.cls === s.cls && pred(x)).map(x => x.id);
        const wholeFleet = (): number[] => {
          const f = g4.fleets.find(f2 => f2.id === s.fleetId);
          return f ? fleetShips(g4, f).map(x => x.id) : [picked];
        };
        if (c.ctrl) {
          if (!g4.selection.includes(picked)) g4.selection.push(picked);
          else g4.selection = g4.selection.filter(id => id !== picked);
        } else if (c.triple) {
          // tactique : 3 clics = tout le type ; classique : 3 clics = toute sa flotte
          g4.selection = tactical ? sameClass(() => true) : wholeFleet();
        } else if (c.dbl) {
          // tactique : 2 clics = toute sa flotte ;
          // classique : 2 clics = les mêmes vaisseaux de sa flotte (hors flotte : les mêmes sans flotte)
          if (tactical) {
            g4.selection = wholeFleet();
          } else if (s.fleetId != null) {
            const f = g4.fleets.find(f2 => f2.id === s.fleetId);
            g4.selection = f ? fleetShips(g4, f).filter(x => x.cls === s.cls).map(x => x.id) : [picked];
          } else {
            g4.selection = sameClass(x => x.fleetId == null);
          }
        } else {
          g4.selection = [picked];
        }
        sfx.ui();
        continue;
      }
    }
    // clic dans le vide : désélectionne
    if (!c.ctrl) gs.selection = [];
  }

  // ---------- Rectangle de sélection (le glisser sélectionne dans les deux vues) ----------
  if (input.dragStart && input.dragEnd && !buildMode) {
    hud.setSelectBox({
      x0: Math.min(input.dragStart.x, input.dragEnd.x), y0: Math.min(input.dragStart.y, input.dragEnd.y),
      x1: Math.max(input.dragStart.x, input.dragEnd.x), y1: Math.max(input.dragStart.y, input.dragEnd.y),
    });
  } else {
    hud.setSelectBox(null);
  }
  if (input.dragDone && !buildMode) {
    const r = input.dragDone;
    const picked: number[] = [];
    for (const s of gs.ships) {
      if (!s.alive || s.team !== gs.playerTeam) continue;
      const p = renderer.screenFromWorld(s.pos);
      if (p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1) picked.push(s.id);
    }
    if (picked.length > 0) {
      gs.selection = r.ctrl ? [...new Set([...gs.selection, ...picked])] : picked;
      sfx.ui();
    } else if (!r.ctrl) {
      gs.selection = [];
    }
  }

  // ---------- Clic droit : radial (double/Alt), plan, ou ordres contextuels ----------
  for (const c of input.rightClicks) {
    if (hud.radialKind === 'selection') hud.hideRadial();
    if ((c.dbl || input.down('AltLeft')) && planMode === 'off'
      && gs.selection.some(id => shipById(gs!, id))) {
      // le menu circulaire de sélection n'existe que s'il y a des vaisseaux sélectionnés
      openSelectionRadial(c.x, c.y);
      continue;
    }
    if (planMode !== 'off') {
      const pos = renderer.worldFromScreen(c.x, c.y);
      if (planMode === 'objective') {
        cmd('planObjective', { pos });
        planMode = 'staging';
        hud.flashHint('Objectif défini — ENTRÉE pour lancer l\'assaut.');
        sfx.buy();
      } else {
        // position de mise en place pour les flottes ARMÉES sélectionnées
        const fleets = new Set<number>();
        for (const id of gs.selection) {
          const sh = shipById(gs, id);
          if (sh?.fleetId != null) {
            const f = gs.fleets.find(f2 => f2.id === sh.fleetId);
            if (f && f.team === gs.playerTeam
              && fleetShips(gs, f).some(x => SHIP_CLASSES[x.cls].power > 3)) fleets.add(f.id);
          }
        }
        if (fleets.size === 0) {
          hud.flashHint('Sélectionnez une flotte ARMÉE pour lui donner une position de plan.');
          sfx.error();
        } else {
          for (const fid of fleets) cmd('fleetMission', { fleetId: fid, mission: { kind: 'plan', pos } });
          sfx.ui();
        }
      }
      continue;
    }
    openOrderMenu(c.x, c.y);
  }

  // ---------- Fantôme de construction + fermeture auto ----------
  if (buildMode) {
    const err = canPlaceStructure(gs, gs.playerTeam, buildMode, aim);
    renderer.setGhost(aim, STRUCTS[buildMode].radius + 10, err === null);
    // trop loin de toute structure amie : on referme
    const g2 = gs;
    const near = g2.structures.some(st => st.alive && st.team === g2.playerTeam &&
      dist(st.pos, ship?.pos ?? aim) < (st.stype === 'station' ? 480 : 360));
    if (!near) {
      buildMode = null;
      renderer.setGhost(null, 0, false);
      hud.flashHint('Construction annulée : trop loin de votre territoire.');
    }
  } else {
    renderer.setGhost(null, 0, false);
    if (hud.buildOpen && ship) {
      const g2 = gs;
      const near = g2.structures.some(st => st.alive && st.team === g2.playerTeam &&
        dist(st.pos, ship.pos) < (st.stype === 'station' ? 480 : 360));
      if (!near) hud.closePanels();
    }
  }

  // ---------- Boutons de la barre tactique ----------
  hud.onFleetCreate = () => {
    if (!gs) return;
    const ids = gs.selection.filter(id => id !== gs!.playerShipId);
    if (ids.length < 1) { hud.flashHint('Sélectionnez au moins 1 vaisseau (hors amiral).'); sfx.error(); return; }
    const err = cmd('fleetCreate', { ids });
    if (!err) sfx.buy(); else { sfx.error(); hud.flashHint(err); }
  };
  hud.onFleetDisband = () => {
    if (!gs) return;
    const fleetIds = new Set<number>();
    for (const id of gs.selection) {
      const s = shipById(gs, id);
      if (s?.fleetId != null && gs.fleets.find(f => f.id === s.fleetId)?.team === gs.playerTeam) fleetIds.add(s.fleetId);
    }
    if (fleetIds.size === 0) { hud.flashHint('Sélectionnez une flotte à dissoudre.'); return; }
    for (const id of fleetIds) cmd('fleetDisband', { fleetId: id });
    sfx.ui();
  };
  hud.onFormation = frm => {
    if (!gs) return;
    let done = false;
    for (const id of gs.selection) {
      const s = shipById(gs, id);
      const f = s?.fleetId != null ? gs.fleets.find(f => f.id === s.fleetId) : null;
      if (f && f.team === gs.playerTeam) { cmd('fleetFormation', { fleetId: f.id, frm }); done = true; }
    }
    if (done) sfx.ui(); else hud.flashHint('Sélectionnez une flotte pour changer sa formation.');
  };
  hud.onFleetSelect = fleetId => {
    if (!gs || !renderer) return;
    const f = gs.fleets.find(f => f.id === fleetId);
    if (!f) return;
    gs.selection = fleetShips(gs, f).map(s => s.id);
    const lead = shipById(gs, f.leaderId);
    if (lead) renderer.camPos = { ...lead.pos };
    sfx.ui();
  };
  hud.onFleetMission = kind => {
    if (!gs) return;
    const fleets = new Set<number>();
    for (const id of gs.selection) {
      const sh = shipById(gs, id);
      if (sh?.fleetId != null) {
        const f = gs.fleets.find(f => f.id === sh.fleetId);
        if (f && f.team === gs.playerTeam) fleets.add(f.id);
      }
    }
    if (fleets.size === 0) { hud.flashHint('Sélectionnez une flotte pour lui assigner une mission.'); sfx.error(); return; }
    for (const fid of fleets) cmd('fleetMission', { fleetId: fid, mission: { kind } });
    sfx.buy();
  };
}

function activateGadgetSmart(gid: GadgetId, aim: V2) {
  if (!gs || !renderer) return;
  let targetId: number | undefined;
  if (gid === 'frappe') {
    // cible : l'ennemi (ou la planète) le plus proche du curseur
    let bd = 120;
    for (const s of gs.ships) {
      if (!s.alive || s.team === gs.playerTeam || areAllied(gs, gs.playerTeam, s.team)) continue;
      const d = dist(s.pos, aim);
      if (d < bd) { bd = d; targetId = s.id; }
    }
    for (const st of gs.structures) {
      if (!st.alive || st.team === gs.playerTeam || areAllied(gs, gs.playerTeam, st.team)) continue;
      const d = dist(st.pos, aim);
      if (d < bd) { bd = d; targetId = st.id; }
    }
    for (const pl of gs.planets) {
      if (!pl.alive) continue;
      const d = dist(pl.pos, aim) - pl.radius;
      if (d < bd) { bd = d; targetId = pl.id; }
    }
  }
  const err = cmd('gadget', { gid, targetId });
  if (err) { sfx.error(); hud.flashHint(err); } else sfx.buy();
}

// ================================================================
//  MENUS CIRCULAIRES — sélection, station à l'approche, corps au survol
// ================================================================
let hoverPlanetId = -1;

function openSelectionRadial(sx: number, sy: number) {
  if (!gs || !renderer) return;
  const g = gs;
  const sel = g.selection.filter(id => shipById(g, id));
  if (sel.length === 0) return;
  const worldPos = renderer.worldFromScreen(sx, sy);
  const orderables = sel.filter(id => id !== g.playerShipId);
  hud.closeCtxMenu();   // le 1er clic du double a pu ouvrir le menu classique : le radial le remplace
  const items: Parameters<typeof hud.showRadial>[3] = [];

  // --- actions contextuelles sur ce qui est sous le curseur (tout le menu classique y est) ---
  const picked = renderer.pickEntity(g, sx, sy, visibleSet);
  const pShip = picked != null ? shipById(g, picked) : undefined;
  const pStruct = picked != null ? structById(g, picked) : undefined;
  const pPlanet = picked != null ? planetById(g, picked) : undefined;
  const pRoid = picked != null ? g.roids.find(r => r.id === picked && r.alive) : undefined;
  const pCloud = picked != null ? g.clouds.find(cc => cc.id === picked && cc.alive) : undefined;
  const pWreck = picked != null ? g.wrecks.find(w => w.id === picked && w.alive) : undefined;
  const hostile = (team: number) => team !== g.playerTeam && !areAllied(g, g.playerTeam, team);
  if (orderables.length > 0) {
    const foeId = (pShip && hostile(pShip.team)) ? pShip.id
      : (pStruct && hostile(pStruct.team)) ? pStruct.id
      : (pPlanet && pPlanet.owner >= 0 && hostile(pPlanet.owner)) ? pPlanet.id : null;
    if (foeId != null) {
      items.push({ ic: 'crosshair', label: 'Attaquer', cb: () => cmd('order', { ids: orderables, order: { kind: 'attack', targetId: foeId } }) });
    }
    if (pShip && pShip.team === g.playerTeam && !orderables.includes(pShip.id)) {
      items.push({ ic: 'shield', label: 'Escorter', cb: () => cmd('order', { ids: orderables, order: { kind: 'escort', targetId: pShip.id } }) });
    }
    if (pRoid || pCloud) {
      const mid = (pRoid ?? pCloud)!.id;
      items.push({ ic: 'pick', label: 'Miner ici', cb: () => cmd('order', { ids: orderables, order: { kind: 'mine', targetId: mid } }) });
    }
    if (pWreck) {
      items.push({ ic: 'box', label: 'Récup. épave', cb: () => cmd('order', { ids: orderables, order: { kind: 'salvage', targetId: pWreck.id } }) });
    }
    if (pPlanet && pPlanet.owner < 0 && orderables.some(id => SHIP_CLASSES[shipById(g, id)!.cls].canColonize)) {
      items.push({ ic: 'flag', label: 'Coloniser', cb: () => cmd('order', { ids: orderables, order: { kind: 'colonize', targetId: pPlanet.id } }) });
    }
    if (pPlanet && pPlanet.owner === g.playerTeam) {
      items.push({ ic: 'route', label: 'Commercer', cb: () => cmd('order', { ids: orderables, order: { kind: 'trade', targetId: pPlanet.id } }) });
    }
    const bodyToProtect = (pStruct && pStruct.team === g.playerTeam) ? pStruct
      : (pPlanet && pPlanet.owner === g.playerTeam) ? pPlanet : null;
    const armedSel = orderables.filter(id => {
      const sh = shipById(g, id);
      return sh && SHIP_CLASSES[sh.cls].power > 3;
    });
    if (bodyToProtect && armedSel.length > 0) {
      items.push({ ic: 'orbit', label: 'Protéger corps', cb: () => cmd('protect', { ids: armedSel, targetId: bodyToProtect.id }) });
    }
    if (pStruct && pStruct.team === g.playerTeam && pStruct.stype === 'avantposte' && pStruct.level < OUTPOST_MAX_LEVEL) {
      items.push({
        ic: 'plus', label: `Améliorer AP (${OUTPOST_UPGRADE_PRICE[pStruct.level]})`,
        cb: () => { const e2 = cmd('outpostUp', { structId: pStruct.id }); if (e2) { sfx.error(); hud.flashHint(e2); } else sfx.buy(); },
      });
    }
    items.push({ ic: 'plus', label: 'Créer flotte', cb: () => hud.onFleetCreate() });
  }
  items.push({
    ic: 'pick', label: 'Missions', sub: [
      { ic: 'pick', label: 'Minage auto', cb: () => hud.onFleetMission('mine_auto') },
      { ic: 'route', label: 'Commerce', cb: () => hud.onFleetMission('trade_auto') },
      { ic: 'star', label: 'Protéger amiral', cb: () => hud.onFleetMission('protect') },
      { ic: 'heart', label: 'Patr. civile', cb: () => hud.onFleetMission('patrol_civil') },
    ],
  });
  items.push({
    ic: 'shield', label: 'Patrouilles', sub: [
      { ic: 'shield', label: 'Intérieure', cb: () => hud.onFleetMission('patrol_in') },
      { ic: 'shield', label: 'Bordure', cb: () => hud.onFleetMission('patrol_border') },
      { ic: 'shield', label: 'Extérieure', cb: () => hud.onFleetMission('patrol_out') },
    ],
  });
  items.push({
    ic: 'map', label: 'Formation', sub: [
      { label: 'Ligne', cb: () => hud.onFormation('ligne') },
      { label: 'Coin', cb: () => hud.onFormation('coin') },
      { label: 'Arc', cb: () => hud.onFormation('cercle') },
      { label: 'Colonne', cb: () => hud.onFormation('colonne') },
    ],
  });
  items.push({
    ic: 'crosshair', label: 'Doctrine', sub: [
      { ic: 'crosshair', label: 'À vue', cb: () => hud.onStance('feu') },
      { ic: 'shield', label: 'Défense', cb: () => hud.onStance('defense') },
      { ic: 'ban', label: 'Ne pas tirer', cb: () => hud.onStance('paix') },
    ],
  });
  items.push({ ic: 'arrow', label: 'Venir ici', cb: () => cmd('order', { ids: orderables, order: { kind: 'move', pos: worldPos } }) });
  items.push({ ic: 'shield', label: 'Garder ici', cb: () => cmd('order', { ids: orderables, order: { kind: 'guard', pos: worldPos } }) });
  items.push({ ic: 'home', label: 'Retour station', cb: () => cmd('order', { ids: orderables, order: { kind: 'dock' } }) });
  items.push({ ic: 'x', label: 'Dissoudre', cb: () => hud.onFleetDisband() });
  hud.showRadial('selection', sx, sy, items, `${sel.length} vsx`);
}

/** Radiaux automatiques : station à l'approche du vaisseau, corps au survol du curseur.
 *  En vue tactique (ou fort dézoom), ils sont masqués : le clic droit classique prend le relais. */
function updateRadials(aim: V2) {
  if (!gs || !renderer) return;
  const ship = playerShip(gs);
  const kind = hud.radialKind;
  // vue tactique / fort dézoom : les menus circulaires AUTOMATIQUES se masquent —
  // celui du double clic droit reste permis (il est explicite, et bien pratique sur la carte)
  if (renderer.isTactical() || renderer.camH > 200) {
    if (kind && kind !== 'selection') hud.hideRadial();
    return;
  }
  if (kind === 'selection') return;   // fermé par clic / action

  // --- station : menu qui apparaît quand on s'amarre ---
  const st = structById(gs, gs.teams[gs.playerTeam].stationId);
  if (ship && st) {
    const d = dist(ship.pos, st.pos);
    if (d < 95 && kind === '') {
      const p2 = renderer.screenFromWorld(st.pos);
      hud.showRadial('station', p2.x, p2.y, [
        { ic: 'box', label: 'Boutique', cb: () => hud.toggleShop(gs!) },
        { ic: 'home', label: 'Construire', cb: () => hud.toggleBuild(gs!) },
        { ic: 'link', label: 'Diplomatie', cb: () => hud.toggleDiplo(gs!) },
        { ic: 'plus', label: 'Améliorer', cb: () => { const e2 = cmd('upgradeStation', {}); if (e2) { sfx.error(); hud.flashHint(e2); } else sfx.buy(); } },
        { ic: 'orbit', label: 'Garde', cb: () => { const e2 = cmd('guards', { targetId: st.id }); if (e2) { sfx.error(); hud.flashHint(e2); } else sfx.buy(); } },
      ], 'STATION');
    } else if (kind === 'station') {
      if (d > 130) hud.hideRadial();
      else { const p2 = renderer.screenFromWorld(st.pos); hud.moveRadial(p2.x, p2.y); }
    }
  } else if (kind === 'station') {
    hud.hideRadial();
  }

  // --- corps céleste : mini-menu au survol du curseur ---
  if (kind === '' || kind.startsWith('hover')) {
    let target: typeof gs.planets[number] | null = null;
    for (const pl of gs.planets) {
      if (!pl.alive) continue;
      const d = dist(aim, pl.pos);
      if (kind === `hover:${pl.id}` ? d < pl.radius + 70 : d < pl.radius + 24) { target = pl; break; }
    }
    if (!target && kind.startsWith('hover')) { hud.hideRadial(); hoverPlanetId = -1; return; }
    if (target && kind !== `hover:${target.id}`) {
      hoverPlanetId = target.id;
      const pl = target;
      const items: Parameters<typeof hud.showRadial>[3] = [];
      if (pl.owner === gs.playerTeam) {
        items.push({ ic: 'plus', label: 'Renforcer', disabled: pl.colonyHpMax >= 1200, cb: () => { const e2 = cmd('planetUp', { planetId: pl.id }); if (e2) { sfx.error(); hud.flashHint(e2); } } });
        items.push({ ic: 'orbit', label: 'Garde', cb: () => { const e2 = cmd('guards', { targetId: pl.id }); if (e2) { sfx.error(); hud.flashHint(e2); } } });
      } else if (pl.owner < 0) {
        // colonisation : appelle un transporteur disponible
        const colon = gs.ships.find(sh => sh.alive && sh.team === gs!.playerTeam && SHIP_CLASSES[sh.cls].canColonize && sh.order.kind !== 'colonize');
        items.push({
          ic: 'flag', label: colon ? 'Coloniser' : 'Aucun transporteur', disabled: !colon,
          cb: () => { if (colon) cmd('order', { ids: [colon.id], order: { kind: 'colonize', targetId: pl.id } }); },
        });
      } else if (!areAllied(gs, gs.playerTeam, pl.owner)) {
        // attaque : les vaisseaux qui vous suivent + flottes de protection
        const followers = gs.ships.filter(sh => sh.alive && sh.team === gs!.playerTeam
          && sh.order.kind === 'escort' && sh.order.targetId === gs!.playerShipId).map(sh => sh.id);
        for (const f of gs.fleets) {
          if (f.team === gs.playerTeam && f.mission.kind === 'protect') {
            for (const sh of fleetShips(gs, f)) followers.push(sh.id);
          }
        }
        items.push({
          ic: 'crosshair', label: followers.length ? `Attaquer (${followers.length})` : 'Aucune escorte', disabled: !followers.length,
          cb: () => { if (followers.length) cmd('order', { ids: followers, order: { kind: 'attack', targetId: pl.id } }); },
        });
      }
      if (items.length > 0) {
        const p2 = renderer.screenFromWorld(pl.pos);
        hud.showRadial(`hover:${pl.id}`, p2.x, p2.y, items, pl.name.toUpperCase().slice(0, 8));
      }
    } else if (target && kind === `hover:${target.id}`) {
      const p2 = renderer.screenFromWorld(target.pos);
      hud.moveRadial(p2.x, p2.y);
    }
  }
}

// ---------- Menu d'ordres (clic droit) ----------
function openOrderMenu(sx: number, sy: number) {
  if (!gs || !renderer) return;
  const pos = renderer.worldFromScreen(sx, sy);
  const picked = renderer.pickEntity(gs, sx, sy, visibleSet);
  const orderables = gs.selection.filter(id => id !== gs!.playerShipId && shipById(gs!, id));
  const items: { label: string; cb: () => void; ic?: string }[] = [];
  let title = 'ORDRES';

  const pickedShip = picked != null ? shipById(gs, picked) : undefined;
  const pickedStruct = picked != null ? structById(gs, picked) : undefined;
  const pickedPlanet = picked != null ? planetById(gs, picked) : undefined;
  const pickedRoid = picked != null ? gs.roids.find(r => r.id === picked && r.alive) : undefined;
  const pickedCloud = picked != null ? gs.clouds.find(c => c.id === picked && c.alive) : undefined;
  const pickedWreck = picked != null ? gs.wrecks.find(w => w.id === picked && w.alive) : undefined;

  if (orderables.length > 0) {
    title = `${orderables.length} VAISSEAU(X)`;
    // cibles ennemies (jamais les alliés)
    const hostile = (team: number) => team !== gs!.playerTeam && !areAllied(gs!, gs!.playerTeam, team);
    if (pickedShip && hostile(pickedShip.team)) {
      items.push({ label: `Attaquer ${SHIP_CLASSES[pickedShip.cls].nom}`, ic: 'crosshair', cb: () => cmd('order', { ids: orderables, order: { kind: 'attack', targetId: pickedShip.id } }) });
    }
    if (pickedStruct && hostile(pickedStruct.team)) {
      items.push({ label: 'Attaquer la structure', ic: 'crosshair', cb: () => cmd('order', { ids: orderables, order: { kind: 'attack', targetId: pickedStruct.id } }) });
    }
    if (pickedPlanet && pickedPlanet.owner >= 0 && hostile(pickedPlanet.owner)) {
      items.push({ label: `Attaquer la colonie ${pickedPlanet.name}`, ic: 'crosshair', cb: () => cmd('order', { ids: orderables, order: { kind: 'attack', targetId: pickedPlanet.id } }) });
    }
    // escorte d'un allié / d'une flotte
    if (pickedShip && pickedShip.team === gs.playerTeam && !orderables.includes(pickedShip.id)) {
      items.push({ label: `Escorter ${SHIP_CLASSES[pickedShip.cls].nom}`, ic: 'shield', cb: () => cmd('order', { ids: orderables, order: { kind: 'escort', targetId: pickedShip.id } }) });
    }
    // minage
    if (pickedRoid || pickedCloud) {
      const id = (pickedRoid ?? pickedCloud)!.id;
      items.push({ label: 'Miner ici', ic: 'pick', cb: () => cmd('order', { ids: orderables, order: { kind: 'mine', targetId: id } }) });
    }
    // planètes
    if (pickedPlanet) {
      if (pickedPlanet.owner < 0) {
        const hasTransporter = orderables.some(id => SHIP_CLASSES[shipById(gs!, id)!.cls].canColonize);
        if (hasTransporter) {
          items.push({ label: `Coloniser ${pickedPlanet.name}`, ic: 'flag', cb: () => cmd('order', { ids: orderables, order: { kind: 'colonize', targetId: pickedPlanet.id } }) });
        }
      } else if (pickedPlanet.owner === gs.playerTeam) {
        items.push({ label: `Commercer avec ${pickedPlanet.name}`, ic: 'route', cb: () => cmd('order', { ids: orderables, order: { kind: 'trade', targetId: pickedPlanet.id } }) });
      }
    }
    if (pickedWreck) {
      items.push({ label: `Récupérer l'épave`, ic: 'box', cb: () => cmd('order', { ids: orderables, order: { kind: 'salvage', targetId: pickedWreck.id } }) });
    }
    // toujours possibles
    // protéger un corps possédé : les vaisseaux armés quittent leur flotte et montent la garde
    const bodyToProtect = (pickedStruct && pickedStruct.team === gs.playerTeam) ? pickedStruct
      : (pickedPlanet && pickedPlanet.owner === gs.playerTeam) ? pickedPlanet : null;
    const armedSel = orderables.filter(id => {
      const sh = shipById(gs!, id);
      return sh && SHIP_CLASSES[sh.cls].power > 3;
    });
    if (bodyToProtect && armedSel.length > 0) {
      items.push({
        label: 'Protéger ce corps', ic: 'shield',
        cb: () => { cmd('protect', { ids: armedSel, targetId: bodyToProtect.id }); sfx.ui(); },
      });
    }
    items.push({ label: 'Déplacer ici', ic: 'arrow', cb: () => cmd('order', { ids: orderables, order: { kind: 'move', pos } }) });
    items.push({ label: 'Garder la position', ic: 'shield', cb: () => cmd('order', { ids: orderables, order: { kind: 'guard', pos } }) });
    items.push({ label: 'Retour à la station', ic: 'home', cb: () => cmd('order', { ids: orderables, order: { kind: 'dock' } }) });
  }
  // recruter une garde orbitale / renforcer la colonie d'un corps possédé
  const guardable = (pickedStruct && pickedStruct.team === gs.playerTeam)
    ? pickedStruct
    : (pickedPlanet && pickedPlanet.owner === gs.playerTeam) ? pickedPlanet : null;
  if (guardable) {
    const st = structById(gs, gs.teams[gs.playerTeam].stationId);
    const cost = GUARD_COST[st?.level ?? 1];
    items.push({
      label: `Recruter une garde orbitale (${cost})`, ic: 'orbit',
      cb: () => {
        const err = cmd('guards', { targetId: guardable.id });
        if (err) { sfx.error(); hud.flashHint(err); } else sfx.buy();
      },
    });
  }
  if (pickedPlanet && pickedPlanet.owner === gs.playerTeam && pickedPlanet.colonyHpMax < 1200) {
    items.push({
      label: `Renforcer la colonie (${PLANET_UPGRADE_COST})`, ic: 'plus',
      cb: () => {
        const err = cmd('planetUp', { planetId: pickedPlanet.id });
        if (err) { sfx.error(); hud.flashHint(err); } else sfx.buy();
      },
    });
  }
  if (pickedStruct && pickedStruct.team === gs.playerTeam && pickedStruct.stype === 'avantposte'
    && pickedStruct.level < OUTPOST_MAX_LEVEL) {
    items.push({
      label: `Améliorer l'avant-poste (${OUTPOST_UPGRADE_PRICE[pickedStruct.level]}) — niv. ${pickedStruct.level}`, ic: 'plus',
      cb: () => {
        const err = cmd('outpostUp', { structId: pickedStruct.id });
        if (err) { sfx.error(); hud.flashHint(err); } else sfx.buy();
      },
    });
  }
  if (items.length === 0 && pickedPlanet) {
    title = pickedPlanet.name.toUpperCase();
    const ownerTxt = pickedPlanet.owner >= 0 ? `Colonie ${gs.teams[pickedPlanet.owner].name}` : 'Neutre — colonisable (transporteur requis)';
    items.push({ label: ownerTxt, cb: () => {} });
  }
  if (items.length === 0) return;
  hud.openCtxMenu(sx, sy, title, items);
}

// ================================================================
//  VISIBILITÉ (capteurs de l'équipe du joueur)
// ================================================================
let visibleSet = new Set<number>();
let visT = 0;
function updateVisibility(dt: number) {
  if (!gs) return;
  visT -= dt;
  if (visT > 0) return;
  visT = 0.25;
  visibleSet = new Set();
  for (const s of gs.ships) {
    if (!s.alive || s.team === gs.playerTeam) continue;
    if (canDetect(gs, gs.playerTeam, s)) visibleSet.add(s.id);
  }
}

// ================================================================
//  INDICE CONTEXTUEL
// ================================================================
function computeHint(): string {
  if (!gs || !renderer) return '';
  if (buildMode) return `Clic : placer — ${buildMode} · Échap : annuler`;
  const ship = playerShip(gs);
  if (!ship) return '';
  const st = structById(gs, gs.teams[gs.playerTeam].stationId);
  if (st && dist(ship.pos, st.pos) < DOCK_RANGE) return 'Amarré : vente & réparation automatiques · U : boutique';
  const nearRoid = gs.roids.some(r => r.alive && dist(r.pos, ship.pos) < 60);
  const nearCloud = gs.clouds.some(c => c.alive && dist(c.pos, ship.pos) < c.radius + 15);
  if (nearRoid || nearCloud) return 'F (maintenir) : miner';
  if (renderer.isTactical() && gs.selection.length === 0) return 'Glisser : sélectionner vos vaisseaux · Clic droit : donner un ordre';
  return '';
}

// ================================================================
//  BOUCLE PRINCIPALE
// ================================================================
hud.onBuildPick = stype => { buildMode = stype; };
hud.onDiploPropose = team => {
  if (!gs) return;
  const err = cmd('diploPropose', { team });
  if (err) { sfx.error(); hud.flashHint(err); } else sfx.ui();
};
hud.onDiploBreak = team => {
  if (!gs) return;
  cmd('diploBreak', { team });
  sfx.ui();
};
hud.onDiploFocus = (team, target) => {
  if (!gs) return;
  const err = cmd('diploFocus', { team, target });
  if (err) { sfx.error(); hud.flashHint(err); } else sfx.ui();
};
hud.onOfferAccept = id => { if (gs) { cmd('offerAccept', { id }); sfx.buy(); } };
hud.onStance = stance => {
  if (!gs) return;
  let n = 0;
  for (const id of gs.selection) {
    const sh = shipById(gs, id);
    const f = sh?.fleetId != null ? gs.fleets.find(f2 => f2.id === sh.fleetId) : null;
    if (f && f.team === gs.playerTeam) { cmd('fleetStance', { fleetId: f.id, stance }); n++; }
  }
  if (n > 0) { hud.flashHint(`Doctrine appliquée : ${stance === 'feu' ? 'attaque à vue' : stance === 'defense' ? 'défense' : 'ne pas tirer'}.`); sfx.ui(); }
  else hud.flashHint('Sélectionnez une flotte pour changer sa doctrine.');
};
hud.onPlanToggle = () => { planMode = planMode === 'off' ? 'staging' : 'off'; sfx.ui(); };
hud.onPlanObjective = () => { planMode = 'objective'; sfx.ui(); };
hud.onPlanFilter = f => { if (gs) { cmd('planFilter', { filter: f }); sfx.ui(); } };
hud.onPlanClear = () => {
  if (!gs) return;
  cmd('planClear', {});
  planMode = 'off';
  hud.flashHint('Plan effacé.');
  sfx.ui();
};
hud.onDiploDefend = team => {
  if (!gs) return;
  const err = cmd('diploDefend', { team });
  if (err) { sfx.error(); hud.flashHint(err); } else sfx.ui();
};
hud.onOfferRefuse = id => { if (gs) { cmd('offerRefuse', { id }); sfx.ui(); } };

function frame(now: number) {
  requestAnimationFrame(frame);
  const elapsed = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  // multijoueur : applique le dernier instantané du serveur
  if (mpMode && net) {
    const snap = net.poll();
    if (snap) applySnap(snap);
  }

  if (!gs || !renderer) {
    // multijoueur : l'intro tourne en attendant le premier instantané
    if (mpMode && introT > 0) { introT -= elapsed; drawIntro(elapsed); }
    input.endFrame();
    return;
  }

  // intro hypersaut : le monde attend la sortie du saut
  if (introT > 0) {
    introT -= elapsed;
    drawIntro(elapsed);
    if (introT <= 0) {
      document.getElementById('intro')!.classList.add('hidden');
      hud.flashScreen();
      sfx.bigBoom();
      const ship0 = playerShip(gs);
      if (ship0) gs.fx.push({ type: 'saut', pos: { ...ship0.pos } });
    }
    input.endFrame();
    return;
  }

  // après la fin de partie, seuls les boutons de l'écran de fin restent actifs
  if (gs.status === 'playing') handleInput(elapsed);

  if (mpMode) {
    // le serveur simule ; ici : estime entre deux instantanés + résorption douce de l'écart
    if (gs.status === 'playing') {
      // PRÉDICTION LOCALE de notre vaisseau : la poussée est déjà appliquée par handleInput,
      // mais sans traînée ni plafond de vitesse la vitesse dérivait entre deux instantanés —
      // d'où les saccades en virage. On reproduit ici la physique exacte du serveur.
      const own = gs.ships.find(sh2 => sh2.id === gs!.playerShipId);
      if (own && own.empT <= 0 && own.jumpT <= 0) {
        const def = SHIP_CLASSES[own.cls];
        own.vel.x *= Math.max(0, 1 - 1.1 * elapsed);   // même DRAG que la sim
        own.vel.y *= Math.max(0, 1 - 1.1 * elapsed);
        const maxV = def.speed * speedMult(gs, own);
        const v = Math.hypot(own.vel.x, own.vel.y);
        if (v > maxV) { own.vel.x *= maxV / v; own.vel.y *= maxV / v; }
        if (v > 6) own.heading = turnToward(own.heading, Math.atan2(own.vel.y, own.vel.x), def.turn * elapsed);
      }
      const decay = Math.exp(-9 * elapsed);   // l'écart fond en ~0,25 s
      for (const sh of gs.ships) {
        sh.pos.x += sh.vel.x * elapsed; sh.pos.y += sh.vel.y * elapsed;
        const e = mpErr.get(sh.id);
        if (e) {
          const k = 1 - decay;
          sh.pos.x -= e.x * k; sh.pos.y -= e.y * k;
          e.x *= decay; e.y *= decay;
          if (Math.abs(e.x) + Math.abs(e.y) < 0.05) mpErr.delete(sh.id);
        }
      }
      for (const pr of gs.projectiles) { pr.pos.x += pr.vel.x * elapsed; pr.pos.y += pr.vel.y * elapsed; }
      gs.t += elapsed;
      if (gs.alertT > 0) gs.alertT -= elapsed;
      // envoi des entrées (30 Hz max)
      const aimNow = renderer.worldFromScreen(input.mouseX, input.mouseY);
      net?.sendInput({ thrust: curThrust, aim: aimNow, fire: curFire, fireE: curFireE, mineF: input.down('KeyF') });
    }
  } else if (!paused && gs.status === 'playing') {
    accumulator += elapsed;
    while (accumulator >= SIM_DT) {
      simTick(gs, SIM_DT);
      accumulator -= SIM_DT;
    }
  }

  updateVisibility(elapsed);

  // point d'écoute : le vaisseau du joueur (ou la caméra en vue tactique)
  const listener = playerShip(gs)?.pos ?? renderer.camPos;
  playFx(gs, listener);

  // ronronnement moteur
  const pShip = playerShip(gs);
  engineLevel(pShip && gs.status === 'playing' && !paused
    ? Math.min(1, Math.hypot(pShip.vel.x, pShip.vel.y) / SHIP_CLASSES[pShip.cls].speed) * 0.9
    : 0);

  // alarmes missile : bips accélérés quand un missile approche, tonalité quand on est verrouillé
  if (pShip) {
    const md = nearestIncomingMissile(gs, pShip.id);
    if (md >= 0) {
      missileWarnT -= elapsed;
      if (missileWarnT <= 0) {
        const urgency = clamp(1 - md / 320, 0, 1);
        sfx.missileWarn(urgency);
        missileWarnT = 0.12 + (1 - urgency) * 0.55;
      }
    }
    if (enemyLockingShip(gs, pShip.id)) {
      lockWarnT -= elapsed;
      if (lockWarnT <= 0) { sfx.lockWarn(); lockWarnT = 0.55; }
    }
  }

  // départ de la supernova : flash + détonation sourde
  if (prevNova < 0 && gs.supernovaWave >= 0) {
    hud.flashScreen();
    sfx.bigBoom();
  }
  prevNova = gs.supernovaWave;

  // sirène quand VOTRE station est attaquée (au plus toutes les 12 s)
  sirenT -= elapsed;
  const myStation = structById(gs, gs.teams[gs.playerTeam].stationId);
  if (myStation && gs.t - myStation.lastDmgT < 0.5 && sirenT <= 0) {
    sirenT = 12;
    sfx.siren();
    window.setTimeout(() => sfx.siren(), 1100);
    gs.alertText = 'VOTRE STATION EST ATTAQUÉE';
    gs.alertT = 4.5;
  }

  // halos rouges : planètes à portée du Brise-Monde quand il est prêt
  const pShip2 = playerShip(gs);
  if (pShip2 && pShip2.cls === 'colosse') {
    const cs = colossusStatus(gs, pShip2);
    const ready = cs.briseCd <= 0 && pShip2.energy >= cs.briseEnergy;
    renderer.setBreakerTargets(ready
      ? gs.planets.filter(pl => pl.alive && pl.dyingT === 0 && dist(pl.pos, pShip2.pos) < 430)
          .map(pl => ({ x: pl.pos.x, y: pl.pos.y, r: pl.radius }))
      : []);
  } else {
    renderer.setBreakerTargets([]);
  }

  // marqueurs et état du plan (vue tactique)
  if (renderer.isTactical()) {
    const stagings = gs.fleets
      .filter(f => f.team === gs!.playerTeam && f.mission.kind === 'plan' && f.mission.pos)
      .map(f => f.mission.pos!);
    renderer.setPlanMarkers(stagings, gs.plans[gs.playerTeam].objective, gs.plans[gs.playerTeam].armed);
    hud.setPlanUI(planMode, gs.plans[gs.playerTeam].armed,
      planMode === 'objective' ? 'Clic droit : placer l\'objectif'
      : planMode === 'staging' ? `Clic droit : position de flotte · ${stagings.length} posée(s) · ENTRÉE : GO`
      : gs.plans[gs.playerTeam].armed ? 'PLAN EN COURS' : '');
  } else {
    renderer.setPlanMarkers([], null, false);
    hud.setPlanUI(planMode, gs.plans[gs.playerTeam].armed, '');
  }

  const aim = renderer.worldFromScreen(input.mouseX, input.mouseY);
  if (gs.status === 'playing' && !paused && introT <= 0) updateRadials(aim);
  else if (hud.radialKind) hud.hideRadial(true);
  // solo : le rendu extrapole du reliquat de pas fixe (gomme l'effet « fantôme ») ;
  // multi : l'estime avance déjà les positions à chaque frame, rien à ajouter
  renderer.extrapolate = (!mpMode && !paused && gs.status === 'playing') ? accumulator : 0;
  renderer.update(gs, elapsed, visibleSet, aim);
  hud.update(gs, {
    tactical: renderer.isTactical(),
    visible: visibleSet,
    buildMode,
    hint: computeHint(),
  });

  if (gs.status === 'over' && !overShown) {
    overShown = true;
    sfx.alarm();
    hud.showGameOver(gs);
  }

  input.endFrame();
}

// ================================================================
//  MULTIJOUEUR — connexion, lobby, instantanés
// ================================================================
function mpFooter(msg: string) {
  const f = document.getElementById('menu-footer');
  if (f) f.textContent = msg;
}

function applySnap(snap: GameState) {
  const prevSel = gs?.selection ?? [];
  // lissage : on ne téléporte pas les vaisseaux, on converge vers l'état serveur
  const oldPos = new Map<number, { x: number; y: number }>();
  if (gs) for (const sh of gs.ships) oldPos.set(sh.id, { x: sh.pos.x, y: sh.pos.y });
  gs = snap;
  (gs as unknown as { mpNames?: Record<number, string> }).mpNames = net?.names;
  hud.bind(gs);
  setAllianceCheck((a, b) => areAlliedFn(gs!, a, b));
  gs.selection = prevSel.filter(id => gs!.ships.some(sh => sh.id === id));
  const flag = gs.ships.find(sh => sh.alive && sh.isFlagship && sh.team === gs!.playerTeam);
  gs.playerShipId = flag?.id ?? -1;
  // anti-saccades : la position AFFICHÉE ne bouge pas à l'arrivée d'un instantané —
  // on note l'écart avec le serveur et on le résorbe en douceur à chaque frame.
  // Écart énorme (saut spatial, réapparition) : téléportation instantanée, sans lissage.
  for (const sh of gs.ships) {
    const op = oldPos.get(sh.id);
    if (!op) { mpErr.delete(sh.id); continue; }
    const ex = op.x - sh.pos.x, ey = op.y - sh.pos.y;
    if (Math.hypot(ex, ey) > 90) { mpErr.delete(sh.id); continue; }
    mpErr.set(sh.id, { x: ex, y: ey });
    sh.pos.x += ex; sh.pos.y += ey;
  }
  for (const id of [...mpErr.keys()]) {
    if (!gs.ships.some(sh => sh.id === id)) mpErr.delete(id);
  }
  // conserve la progression de verrouillage locale (visuel)
  if (flag && input.down('KeyQ')) flag.lockT = mpLockT;
  if (mpFirstSnap && renderer && flag) {
    renderer.camPos = { ...flag.pos };
    mpFirstSnap = false;
  }
}

function leaveMp(msg = '') {
  net?.leave();
  net = null;
  mpMode = false;
  rejoinTries = 0;
  mpErr.clear();
  gs = null;
  paused = false;
  introT = 0;
  mpFirstSnap = true;
  document.getElementById('intro')!.classList.add('hidden');
  hud.hideLobby();
  hud.showMenu();
  if (msg) mpFooter(msg);
}

/** Coupure réseau : en pleine partie on tente la reconnexion, sinon retour menu. */
function onNetClosed() {
  if (mpMode && gs && gs.status === 'playing') attemptRejoin();
  else leaveMp('Connexion au serveur perdue.');
}

/** Retente de récupérer sa place dans la partie (jeton de session) pendant ~15 s. */
async function attemptRejoin() {
  if (!mpMode) return;
  if (rejoinTries >= 8) { leaveMp('Reconnexion impossible — partie quittée.'); return; }
  rejoinTries++;
  hud.flashHint(`Connexion perdue — reconnexion ${rejoinTries}/8…`);
  await new Promise(r => window.setTimeout(r, 1600));
  if (!mpMode) return;
  net = new Net();
  net.token = mpToken;
  net.onLobby = info => hud.showLobby(info);
  net.onStart = () => { rejoinTries = 0; startNetGame(); hud.flashHint('Reconnecté — bon retour, amiral !'); };
  net.onError = msg => leaveMp(msg);
  net.onHint = msg => hud.flashHint(msg);
  net.onClosed = onNetClosed;
  try {
    await net.connect(autoAddr());
    net.rejoin();
  } catch {
    attemptRejoin();
  }
}

async function mpConnect(addr: string): Promise<boolean> {
  net = new Net();
  net.token = mpToken;
  net.onLobby = info => hud.showLobby(info);
  net.onStart = () => startNetGame();
  net.onError = msg => mpFooter(msg);
  net.onHint = msg => hud.flashHint(msg);
  net.onClosed = onNetClosed;
  try {
    await net.connect(addr);
    return true;
  } catch (e) {
    mpFooter((e as Error).message);
    net = null;
    return false;
  }
}

function startNetGame() {
  mpMode = true;
  mpFirstSnap = true;
  mpErr.clear();
  setCmdExec((n, a) => { net?.cmd(n, a); return null; });
  gs = null;
  overShown = false;
  paused = false;
  buildMode = null;
  planMode = 'off';
  visibleSet = new Set();
  visT = 0;
  lockWasReady = false;
  mpLockT = 0;
  input.endFrame();
  if (!renderer) renderer = new Renderer3D(canvas);
  else renderer.reset();
  renderer.camH = 130;
  hud.hideLobby();
  hud.enterGame();
  hud.hideGameOver();
  introT = 2.6;
  introStars = Array.from({ length: 260 }, () => ({
    a: Math.random() * Math.PI * 2,
    r: 20 + Math.random() * 500,
    sp: 0.6 + Math.random() * 1.6,
  }));
  document.getElementById('intro')!.classList.remove('hidden');
  sfx.hyper();
}

/** Le serveur multijoueur vit sur la même machine que le site. */
function autoAddr(): string {
  if (location.protocol === 'https:') return `wss://${location.host}/ws`;
  return `ws://${location.hostname}:17771`;
}

hud.onMpQuick = async name => {
  mpFooter('Connexion…');
  // partie rapide : réglages standards tirés au sort côté client
  const cfg: MatchConfig = {
    seed: Math.floor(Math.random() * 1e9), playerColorIdx: 0, aiCount: 3,
    personaChoice: 'aleatoire', starChoice: 'aleatoire', difficulty: 'normal',
  };
  if (await mpConnect(autoAddr())) { net!.quick(name, cfg); mpFooter('Recherche de joueurs…'); }
};
hud.onMpCreate = async (name, isPublic) => {
  mpFooter('Connexion…');
  if (await mpConnect(autoAddr())) { net!.create(name, hud.getCfg(), isPublic); mpFooter('Salon créé.'); }
};
hud.onMpJoin = async (name, code) => {
  if (!code) { mpFooter('Entrez le code du salon.'); return; }
  mpFooter('Connexion…');
  if (await mpConnect(autoAddr())) { net!.join(code, name); }
};
hud.onMpStart = () => net?.start();
hud.onMpLeave = () => leaveMp();

// ---- « X joueurs en ligne » sur l'écran d'accueil ----
// Interroge le serveur multijoueur via une mini-connexion WebSocket éphémère
// (même chemin que le jeu : passe les proxys HTTPS sans configuration en plus).
function refreshOnlineCount() {
  const tag = document.getElementById('menu-tagline');
  const menuShown = !document.getElementById('menu')!.classList.contains('hidden');
  if (!tag || !menuShown || mpMode) return;
  try {
    const probe = new WebSocket(autoAddr());
    const kill = window.setTimeout(() => probe.close(), 4000);
    probe.onopen = () => probe.send(JSON.stringify({ t: 'count' }));
    probe.onmessage = ev => {
      try {
        const m = JSON.parse(String(ev.data));
        if (m.t === 'count') {
          const n = Math.max(0, Number(m.n) || 0);
          tag.textContent = `Stratégie & action spatiale — ${n} joueur${n > 1 ? 's' : ''} en ligne`;
        }
      } catch { /* réponse illisible : devise générique conservée */ }
      window.clearTimeout(kill);
      probe.close();
    };
    probe.onerror = () => window.clearTimeout(kill);
  } catch { /* serveur absent (dev local) : devise générique conservée */ }
}
refreshOnlineCount();
window.setInterval(refreshOnlineCount, 45_000);

hud.showMenu();
requestAnimationFrame(frame);

// Hook de debug (console navigateur) : __cobalt.step(30) avance la partie de 30 s.
(window as any).__cobalt = {
  get gs() { return gs; },
  get hud() { return hud; },
  get renderer() { return renderer; },
  get net() { return net; },
  /** Pompe manuelle de frames (tests sans rAF). */
  pump(n = 1) { for (let i = 0; i < n; i++) frame(performance.now()); return gs ? `t=${gs.t.toFixed(1)}` : 'pas de gs'; },
  step(seconds = 1) {
    if (!gs || !renderer) return 'aucune partie en cours';
    const n = Math.max(1, Math.floor(seconds / SIM_DT));
    for (let i = 0; i < n; i++) simTick(gs, SIM_DT);
    visT = 0;
    updateVisibility(0.3);
    playFx(gs, playerShip(gs)?.pos ?? renderer.camPos);
    renderer.update(gs, SIM_DT, visibleSet, { x: 0, y: 0 });
    hud.update(gs, { tactical: renderer.isTactical(), visible: visibleSet, buildMode, hint: computeHint() });
    if (gs.status === 'over' && !overShown) { overShown = true; hud.showGameOver(gs); }
    return `t=${gs.t.toFixed(1)}s status=${gs.status}`;
  },
};
