// ============ COBALT SECTOR — point d'entrée & boucle de jeu ============
import {
  GameState, MatchConfig, SIM_DT, V2, dist, clamp, StructType, GadgetId,
  structById, shipById, planetById, PIRATE_TEAM, areAllied, OrderKind,
} from './core';
import { SHIP_CLASSES, DOCK_RANGE, MINES, GADGET_ORDER, MODES, STRUCTS } from './data';
import { newGame } from './world';
import {
  simTick, playerShip, playerMine, dropMine, toggleMode, tryJump, activateGadget,
  takeControlNearest, placeStructure, canPlaceStructure, fireShipWeapon,
  missileSlot, lockTick, lockRelease, lockCancel, nearestIncomingMissile, enemyLockingShip,
  proposeAlliance, breakAlliance, requestFocus, acceptOffer, refuseOffer,
} from './sim';
import { setFleetMission } from './orders';
import { canDetect } from './entities';
import { createFleet, disbandFleet, issueOrder, fleetShips } from './orders';
import { Renderer3D } from './render3d';
import { HUD } from './hud';
import { Input } from './input';
import { initAudio, playFx, sfx, engineLevel } from './sfx';

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

window.addEventListener('resize', () => renderer?.resize());
// l'audio ne peut démarrer qu'après un geste utilisateur
window.addEventListener('pointerdown', () => initAudio(), { once: true });
window.addEventListener('keydown', () => initAudio(), { once: true });

// ================================================================
//  DÉMARRAGE / FIN
// ================================================================
hud.onStart = cfg => startGame(cfg);
hud.onReplay = () => { if (lastCfg) startGame({ ...lastCfg, seed: Math.floor(Math.random() * 1e9) }); };
hud.onQuitToMenu = () => {
  gs = null; paused = false;
  hud.showMenu();
};
hud.onResume = () => { paused = false; hud.showPause(false); };

function startGame(cfg: MatchConfig) {
  lastCfg = cfg;
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
  input.endFrame();
  if (!renderer) renderer = new Renderer3D(canvas);
  else renderer.reset();
  const ship = playerShip(gs);
  if (ship) renderer.camPos = { ...ship.pos };
  renderer.camH = 130;
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
    if (dir.x !== 0 || dir.y !== 0) {
      const l = Math.hypot(dir.x, dir.y);
      const def = SHIP_CLASSES[ship.cls];
      ship.vel.x += (dir.x / l) * def.accel * dt;
      ship.vel.y += (dir.y / l) * def.accel * dt;
    }
  }

  // ---------- Tir & verrouillage missile ----------
  const hasMissile = ship ? missileSlot(ship) >= 0 : false;
  let locking = false;
  if (!tactical && ship) {
    // A maintenu : verrouillage missile (bloque les autres armes pendant la charge)
    if (input.down('KeyQ') && hasMissile) {
      locking = true;
      const st = lockTick(gs, ship, aim, dt);
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
      if (ship.lockT > 0 && ship.id === gs.playerShipId && !input.down('KeyQ')) {
        // A relâché : tire si verrouillé
        if (lockRelease(gs, ship)) sfx.shoot('missile');
        lockWasReady = false;
      }
      renderer.setLockState(null);
    }

    if (!locking) {
      if (input.down('Space') || (input.leftDown && !input.dblHold && !hud.ctxOpen && !buildMode)) {
        fireShipWeapon(gs, ship, 0, aim);
      }
      if (input.down('KeyQ') && !hasMissile) fireShipWeapon(gs, ship, 1, aim);  // A en AZERTY
      if (input.down('KeyE')) fireShipWeapon(gs, ship, 2, aim);
    }
  } else {
    renderer.setLockState(null);
    if (ship && ship.lockT > 0 && ship.id === gs.playerShipId) lockCancel(ship);
  }

  // ---------- Minage manuel ----------
  if (ship && input.down('KeyF')) {
    const res = playerMine(gs, dt);
    if (res && Math.random() < dt * 3) sfx.mine();
  }

  // ---------- Mines larguées ----------
  for (const c of input.middleClicks) {
    const target = renderer.worldFromScreen(c.x, c.y);
    if (ship && dropMine(gs, ship, target)) sfx.mine();
    else sfx.error();
  }

  // ---------- Modes (& é " ') ----------
  const modeKeys = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];
  modeKeys.forEach((code, i) => {
    if (!input.pressed(code) || !ship) return;
    const m = MODES[i];
    if (m.id === 'saut') {
      const err = tryJump(gs!, ship);
      if (err) { sfx.error(); hud.flashHint(err); }
    } else {
      toggleMode(gs!, ship, m.id as 'croisiere' | 'radar' | 'espion');
      sfx.ui();
    }
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
      if (id === 'saut') {
        const err = tryJump(gs, s);
        if (err) { sfx.error(); hud.flashHint(err); }
      } else toggleMode(gs, s, id as 'croisiere' | 'radar' | 'espion');
    } else if (kind === 'gadget') {
      activateGadgetSmart(id as GadgetId, renderer!.worldFromScreen(input.mouseX, input.mouseY));
    }
  };

  // ---------- Divers ----------
  if (input.pressed('KeyC')) {
    const err = takeControlNearest(gs);
    if (err) { sfx.error(); hud.flashHint(err); } else sfx.ui();
  }
  if (input.pressed('KeyB')) hud.toggleBuild(gs);
  if (input.pressed('KeyJ')) hud.toggleDiplo(gs);
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
      const err = placeStructure(gs, gs.playerTeam, buildMode, pos);
      if (err) { sfx.error(); hud.flashHint(err); }
      else { sfx.buy(); buildMode = null; }
      continue;
    }
    // en vue action, la sélection se fait au DOUBLE-clic (le clic simple tire) ;
    // en vue tactique, le clic simple suffit
    if (!tactical && !c.dbl) continue;
    const picked = renderer.pickEntity(gs, c.x, c.y, visibleSet);
    if (picked != null) {
      const s = shipById(gs, picked);
      if (s && s.team === gs.playerTeam) {
        if (c.ctrl) {
          if (!gs.selection.includes(picked)) gs.selection.push(picked);
          else gs.selection = gs.selection.filter(id => id !== picked);
        } else {
          gs.selection = [picked];
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

  // ---------- Clic droit : ordres contextuels ----------
  for (const c of input.rightClicks) {
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
    const f = createFleet(gs, gs.playerTeam, ids);
    if (f) sfx.buy();
  };
  hud.onFleetDisband = () => {
    if (!gs) return;
    const fleetIds = new Set<number>();
    for (const id of gs.selection) {
      const s = shipById(gs, id);
      if (s?.fleetId != null && gs.fleets.find(f => f.id === s.fleetId)?.team === gs.playerTeam) fleetIds.add(s.fleetId);
    }
    if (fleetIds.size === 0) { hud.flashHint('Sélectionnez une flotte à dissoudre.'); return; }
    for (const id of fleetIds) disbandFleet(gs, id);
    sfx.ui();
  };
  hud.onFormation = frm => {
    if (!gs) return;
    let done = false;
    for (const id of gs.selection) {
      const s = shipById(gs, id);
      const f = s?.fleetId != null ? gs.fleets.find(f => f.id === s.fleetId) : null;
      if (f && f.team === gs.playerTeam) { f.formation = frm as any; done = true; }
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
    for (const fid of fleets) {
      const f = gs.fleets.find(f => f.id === fid)!;
      setFleetMission(gs, f, { kind: kind as OrderKind });
    }
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
  const err = activateGadget(gs, gs.playerTeam, gid, targetId);
  if (err) { sfx.error(); hud.flashHint(err); } else sfx.buy();
}

// ---------- Menu d'ordres (clic droit) ----------
function openOrderMenu(sx: number, sy: number) {
  if (!gs || !renderer) return;
  const pos = renderer.worldFromScreen(sx, sy);
  const picked = renderer.pickEntity(gs, sx, sy, visibleSet);
  const orderables = gs.selection.filter(id => id !== gs!.playerShipId && shipById(gs!, id));
  const items: { label: string; cb: () => void }[] = [];
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
      items.push({ label: `⚔ Attaquer ${SHIP_CLASSES[pickedShip.cls].nom}`, cb: () => issueOrder(gs!, orderables, { kind: 'attack', targetId: pickedShip.id }) });
    }
    if (pickedStruct && hostile(pickedStruct.team)) {
      items.push({ label: `⚔ Attaquer la structure`, cb: () => issueOrder(gs!, orderables, { kind: 'attack', targetId: pickedStruct.id }) });
    }
    if (pickedPlanet && pickedPlanet.owner >= 0 && hostile(pickedPlanet.owner)) {
      items.push({ label: `⚔ Attaquer la colonie ${pickedPlanet.name}`, cb: () => issueOrder(gs!, orderables, { kind: 'attack', targetId: pickedPlanet.id }) });
    }
    // escorte d'un allié / d'une flotte
    if (pickedShip && pickedShip.team === gs.playerTeam && !orderables.includes(pickedShip.id)) {
      items.push({ label: `🛡 Escorter ${SHIP_CLASSES[pickedShip.cls].nom}`, cb: () => issueOrder(gs!, orderables, { kind: 'escort', targetId: pickedShip.id }) });
    }
    // minage
    if (pickedRoid || pickedCloud) {
      const id = (pickedRoid ?? pickedCloud)!.id;
      items.push({ label: `⛏ Miner ici`, cb: () => issueOrder(gs!, orderables, { kind: 'mine', targetId: id }) });
    }
    // planètes
    if (pickedPlanet) {
      if (pickedPlanet.owner < 0) {
        const hasTransporter = orderables.some(id => SHIP_CLASSES[shipById(gs!, id)!.cls].canColonize);
        if (hasTransporter) {
          items.push({ label: `🏳 Coloniser ${pickedPlanet.name}`, cb: () => issueOrder(gs!, orderables, { kind: 'colonize', targetId: pickedPlanet.id }) });
        }
      } else if (pickedPlanet.owner === gs.playerTeam) {
        items.push({ label: `⇄ Commercer avec ${pickedPlanet.name}`, cb: () => issueOrder(gs!, orderables, { kind: 'trade', targetId: pickedPlanet.id }) });
      }
    }
    if (pickedWreck) {
      items.push({ label: `♻ Récupérer l'épave`, cb: () => issueOrder(gs!, orderables, { kind: 'salvage', targetId: pickedWreck.id }) });
    }
    // toujours possibles
    items.push({ label: '➤ Déplacer ici', cb: () => issueOrder(gs!, orderables, { kind: 'move', pos }) });
    items.push({ label: '⚓ Garder la position', cb: () => issueOrder(gs!, orderables, { kind: 'guard', pos }) });
    items.push({ label: '🏠 Retour à la station', cb: () => issueOrder(gs!, orderables, { kind: 'dock' }) });
  } else if (pickedPlanet) {
    title = pickedPlanet.name.toUpperCase();
    const ownerTxt = pickedPlanet.owner >= 0 ? `Colonie ${gs.teams[pickedPlanet.owner].name}` : 'Neutre — colonisable (transporteur requis)';
    items.push({ label: ownerTxt, cb: () => {} });
  } else {
    return; // rien à proposer
  }
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
  const err = proposeAlliance(gs, gs.playerTeam, team);
  if (err) { sfx.error(); hud.flashHint(err); } else sfx.ui();
};
hud.onDiploBreak = team => {
  if (!gs) return;
  breakAlliance(gs, gs.playerTeam, team);
  sfx.ui();
};
hud.onDiploFocus = (team, target) => {
  if (!gs) return;
  const err = requestFocus(gs, gs.playerTeam, team, target);
  if (err) { sfx.error(); hud.flashHint(err); } else sfx.ui();
};
hud.onOfferAccept = id => { if (gs) { acceptOffer(gs, id); sfx.buy(); } };
hud.onOfferRefuse = id => { if (gs) { refuseOffer(gs, id); sfx.ui(); } };

function frame(now: number) {
  requestAnimationFrame(frame);
  const elapsed = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  if (!gs || !renderer) { input.endFrame(); return; }

  // après la fin de partie, seuls les boutons de l'écran de fin restent actifs
  if (gs.status === 'playing') handleInput(elapsed);

  if (!paused && gs.status === 'playing') {
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

hud.showMenu();
requestAnimationFrame(frame);

// Hook de debug (console navigateur) : __cobalt.step(30) avance la partie de 30 s.
(window as any).__cobalt = {
  get gs() { return gs; },
  get hud() { return hud; },
  get renderer() { return renderer; },
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
