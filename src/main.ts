// ============ COBALT SECTOR — point d'entrée & boucle de jeu ============
import {
  GameState, MatchConfig, SIM_DT, V2, dist, clamp, StructType, GadgetId,
  structById, shipById, planetById, PIRATE_TEAM, areAllied, OrderKind, PlanFilter, Stance,
} from './core';
import { SHIP_CLASSES, DOCK_RANGE, MINES, GADGET_ORDER, MODES, STRUCTS, GUARD_COST, PLANET_UPGRADE_COST } from './data';
import { newGame } from './world';
import {
  simTick, playerShip, playerMine, dropMine, toggleMode, tryJump, activateGadget,
  takeControlNearest, placeStructure, canPlaceStructure, fireShipWeapon,
  tryBuyShip, tryBuyUpgrade, tryBuyWeapon, tryBuyGadget, tryUpgradeStation,
  missileSlot, lockTick, lockRelease, lockCancel, nearestIncomingMissile, enemyLockingShip,
  colossusLockTick, colossusSalveRelease, colossusWorldBreaker, colossusStatus,
  proposeAlliance, breakAlliance, requestFocus, acceptOffer, refuseOffer, buyGuards,
  tryUpgradePlanet, requestDefend,
} from './sim';
import { setFleetMission, removeFromFleet } from './orders';
import { canDetect } from './entities';
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
let leftHeldT = 0;                 // durée d'appui du clic gauche
let pendingShot: { t: number; aim: V2 } | null = null;   // tir de clic bref, différé

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
    case 'fleetCreate': return createFleet(gs, team, own(a.ids)) ? null : 'Sélectionnez au moins 2 vaisseaux';
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
    renderer.camH = clamp(renderer.camH * Math.exp(input.wheel * 0.0012), 48, 950);
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
      // maintien : le tir continu ne démarre qu'après un très court délai,
      // pour que le premier clic d'un double-clic ne parte pas tout seul
      leftHeldT = input.leftDown ? leftHeldT + dt : 0;
      const holdFire = input.leftDown && !input.dblHold && leftHeldT > 0.14 && !hud.ctxOpen && !buildMode;
      curFire = input.down('Space') || holdFire;
      if (curFire) {
        if (!mpMode) fireShipWeapon(gs, ship, 0, aim);
        pendingShot = null;
      }
      // clic bref : tir différé de 0,22 s, annulé si un double-clic suit
      if (pendingShot) {
        pendingShot.t -= dt;
        if (input.dblHold || input.leftDown) pendingShot = null;
        else if (pendingShot.t <= 0) {
          if (mpMode) curFire = true;
          else fireShipWeapon(gs, ship, 0, pendingShot.aim);
          pendingShot = null;
        }
      }
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

  // ---------- Clic gauche : sélection / placement ----------
  for (const c of input.clicks) {
    if (hud.ctxOpen) { hud.closeCtxMenu(); continue; }
    if (buildMode) {
      const pos = renderer.worldFromScreen(c.x, c.y);
      const err = cmd('place', { stype: buildMode, pos });
      if (err) { sfx.error(); hud.flashHint(err); }
      else { sfx.buy(); buildMode = null; }
      continue;
    }
    // vue action : clic simple = tir (différé pour laisser sa chance au double-clic)
    if (!tactical && !c.dbl) {
      pendingShot = { t: 0.22, aim: renderer.worldFromScreen(c.x, c.y) };
      continue;
    }
    const picked = renderer.pickEntity(gs, c.x, c.y, visibleSet);
    if (picked != null) {
      const s = shipById(gs, picked);
      if (s && s.team === gs.playerTeam) {
        const g4 = gs;
        if (tactical && c.triple) {
          // triple-clic : tous les vaisseaux de ce type
          g4.selection = g4.ships.filter(x => x.alive && x.team === g4.playerTeam && x.cls === s.cls).map(x => x.id);
        } else if (tactical && c.dbl && s.fleetId != null) {
          // double-clic : toute la flotte
          const f = g4.fleets.find(f2 => f2.id === s.fleetId);
          g4.selection = f ? fleetShips(g4, f).map(x => x.id) : [picked];
        } else if (c.ctrl) {
          if (!g4.selection.includes(picked)) g4.selection.push(picked);
          else g4.selection = g4.selection.filter(id => id !== picked);
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

  // ---------- Rectangle de sélection ----------
  if (input.dragStart && input.dragEnd && !buildMode && (tactical || input.dblHold)) {
    hud.setSelectBox({
      x0: Math.min(input.dragStart.x, input.dragEnd.x), y0: Math.min(input.dragStart.y, input.dragEnd.y),
      x1: Math.max(input.dragStart.x, input.dragEnd.x), y1: Math.max(input.dragStart.y, input.dragEnd.y),
    });
  } else {
    hud.setSelectBox(null);
  }
  if (input.dragDone && !buildMode && (tactical || input.dragDone.fromDouble)) {
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

  // ---------- Clic droit : plan (positions/objectif) ou ordres contextuels ----------
  for (const c of input.rightClicks) {
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
    if (ids.length < 2) { hud.flashHint('Sélectionnez au moins 2 vaisseaux (hors amiral).'); sfx.error(); return; }
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
    // le serveur simule ; ici : estime légère entre deux instantanés
    if (gs.status === 'playing') {
      for (const sh of gs.ships) { sh.pos.x += sh.vel.x * elapsed; sh.pos.y += sh.vel.y * elapsed; }
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
  gs = snap;
  hud.bind(gs);
  setAllianceCheck((a, b) => areAlliedFn(gs!, a, b));
  gs.selection = prevSel.filter(id => gs!.ships.some(sh => sh.id === id));
  const flag = gs.ships.find(sh => sh.alive && sh.isFlagship && sh.team === gs!.playerTeam);
  gs.playerShipId = flag?.id ?? -1;
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
  gs = null;
  paused = false;
  introT = 0;
  mpFirstSnap = true;
  document.getElementById('intro')!.classList.add('hidden');
  hud.hideLobby();
  hud.showMenu();
  if (msg) mpFooter(msg);
}

async function mpConnect(addr: string): Promise<boolean> {
  net = new Net();
  net.onLobby = info => hud.showLobby(info);
  net.onStart = () => startNetGame();
  net.onError = msg => mpFooter(msg);
  net.onHint = msg => hud.flashHint(msg);
  net.onClosed = () => leaveMp('Connexion au serveur perdue.');
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

hud.onMpQuick = async (name, addr) => {
  mpFooter('Connexion…');
  if (await mpConnect(addr)) { net!.quick(name, hud.getCfg()); mpFooter('Connecté — salon public.'); }
};
hud.onMpCreate = async (name, addr) => {
  mpFooter('Connexion…');
  if (await mpConnect(addr)) { net!.create(name, hud.getCfg()); mpFooter('Salon créé.'); }
};
hud.onMpJoin = async (name, addr, code) => {
  if (!code) { mpFooter('Entrez le code du salon.'); return; }
  mpFooter('Connexion…');
  if (await mpConnect(addr)) { net!.join(code, name); }
};
hud.onMpStart = () => net?.start();
hud.onMpLeave = () => leaveMp();

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
