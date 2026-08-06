// ============ COBALT SECTOR — simulation (physique, combat, économie, événements) ============
import {
  GameState, Ship, Structure, Planet, V2, v2, add, sub, scale, len, dist, norm, angleOf,
  fromAngle, clamp, turnToward, IDLE, PIRATE_TEAM, NO_TEAM, WORLD_R, addLog, setAlert,
  shipById, structById, planetById, GadgetId, MineType, WeaponId, ShipClassId, StructType, Res,
} from './core';
import {
  WEAPONS, SHIP_CLASSES, STRUCTS, MINES, GADGETS, RES_PRICE, KILL_BOUNTY, WRECK_VALUE,
  PLANET_INCOME, PLANET_INCOME_PERIOD, MINE_INCOME, MINE_INCOME_PERIOD,
  PASSIVE_INCOME, PASSIVE_INCOME_PERIOD, COLONIZE_COST, COLONIZE_TIME, TRADE_PROFIT,
  HULL_REGEN_DELAY, HULL_REGEN_RATE, SHIELD_RECHARGE_RATE, ENERGY_REGEN,
  SALVAGE_RANGE, DOCK_RANGE, MINING_RANGE, MINING_RATE, DIFF_MULT, MINE_RESTOCK_PRICE,
  UPGRADES, STATION_UPGRADE_PRICE, PIRATE_RAID_PERIOD,
} from './data';
import {
  makeShip, makeStructure, makeWreck, makeProjectile, makeMineEnt, applyUpgrades, speedMult,
  isEnemy, nearestShip, nearestStruct, nearestRoid, nearestCloud, canDetect, cargoTotal, addCargo,
} from './entities';
import { removeFromFleet, formationWorldPos, fleetShips } from './orders';
import { thinkTeams, thinkPirates, spawnPirateRaid } from './ai';

const DRAG = 1.1;

// ================================================================
//  TICK PRINCIPAL
// ================================================================
export const SUDDEN_DEATH_T = 1200;   // 20 min : les boucliers des stations tombent
export const TIME_LIMIT_T = 1680;     // 28 min : victoire au score

export function simTick(gs: GameState, dt: number) {
  if (gs.status !== 'playing') return;
  gs.t += dt;
  if (gs.alertT > 0) gs.alertT -= dt;
  if (gs.t - dt < SUDDEN_DEATH_T && gs.t >= SUDDEN_DEATH_T) {
    setAlert(gs, '⚠ MORT SUBITE — BOUCLIERS DES STATIONS HORS-LIGNE', 5);
    addLog(gs, 'Mort subite : les stations ne rechargent plus leurs boucliers.', '#ff8c42');
  }

  updateStarBodies(gs, dt);
  thinkTeams(gs, dt);
  thinkPirates(gs, dt);

  for (const s of gs.ships) if (s.alive) updateShipStatus(gs, s, dt);
  for (const s of gs.ships) if (s.alive) execOrder(gs, s, dt);
  for (const s of gs.ships) if (s.alive) integrate(gs, s, dt);

  updateStructures(gs, dt);
  updatePlanets(gs, dt);
  updateProjectiles(gs, dt);
  updateMines(gs, dt);
  updateSmoke(gs, dt);
  updateWrecks(gs, dt);
  updateStarHazards(gs, dt);
  updateRespawns(gs, dt);
  updatePirateTimer(gs, dt);
  cleanup(gs);
  checkVictory(gs);
}

// ================================================================
//  ASTRES
// ================================================================
function updateStarBodies(gs: GameState, dt: number) {
  const bodies = gs.map.bodies;
  for (const b of bodies) {
    if (b.orbitR > 0) {
      b.phase += b.orbitSpeed * dt;
      b.pos.x = Math.cos(b.phase) * b.orbitR;
      b.pos.y = Math.sin(b.phase) * b.orbitR;
    }
  }
}

function updateStarHazards(gs: GameState, dt: number) {
  const map = gs.map;

  // Chaleur / horizon des événements autour des astres
  for (const s of gs.ships) {
    if (!s.alive) continue;
    for (const b of map.bodies) {
      const d = dist(s.pos, b.pos);
      if (d < map.killRadius) applyDamage(gs, s, 45 * dt, NO_TEAM, true);
    }
    if (map.blackHole) {
      const d = len(s.pos);
      const g = 2600000 / (d * d + 4000);
      const dir = norm(scale(s.pos, -1));
      s.vel = add(s.vel, scale(dir, clamp(g, 0, 55) * dt));
    }
  }

  // Impulsion de l'étoile à neutrons
  if (map.neutronPeriod > 0) {
    gs.neutronT -= dt;
    if (gs.neutronT <= 8 && gs.neutronT + dt > 8) setAlert(gs, '⚡ IMPULSION EMP IMMINENTE', 3);
    if (gs.neutronT <= 0) {
      gs.neutronT = map.neutronPeriod;
      gs.fx.push({ type: 'onde', pos: v2(), size: 700, color: 0x7adfff });
      for (const s of gs.ships) {
        if (!s.alive || len(s.pos) > 700) continue;
        s.energy *= 0.15; s.shield *= 0.25; s.empT = Math.max(s.empT, 1.6);
      }
      addLog(gs, 'Impulsion EMP de l\'étoile à neutrons !', '#7adfff');
    }
  }

  // Supernova
  if (map.supernovaAt > 0 && gs.supernovaWave < 0 && gs.t >= map.supernovaAt) {
    gs.supernovaWave = 0;
    setAlert(gs, '☀ SUPERNOVA !', 6);
    addLog(gs, 'La supergéante explose !', '#ff4b4b');
    gs.fx.push({ type: 'onde', pos: v2(), size: 300, color: 0xff6b4b });
  }
  if (gs.supernovaWave >= 0) {
    gs.supernovaWave += 110 * dt;
    const r = gs.supernovaWave;
    for (const s of gs.ships) if (s.alive && len(s.pos) < r) killShip(gs, s, NO_TEAM);
    for (const st of gs.structures) if (st.alive && len(st.pos) < r) destroyStructure(gs, st, NO_TEAM);
    for (const p of gs.planets) if (p.alive && len(p.pos) < r) { p.alive = false; gs.fx.push({ type: 'explosion', pos: p.pos, size: p.radius * 2 }); }
    for (const rd of gs.roids) if (rd.alive && len(rd.pos) < r) rd.alive = false;
    if (r > WORLD_R * 1.3) endBySupernova(gs);
  }
}

function endBySupernova(gs: GameState) {
  if (gs.status === 'over') return;
  let best = -1, bestScore = -1;
  for (const id of gs.activeTeams) {
    const sc = teamScore(gs, id);
    if (sc > bestScore) { bestScore = sc; best = id; }
  }
  gs.status = 'over';
  gs.winner = best;
  gs.overReason = 'La supernova a consumé le système. Victoire au score.';
}

// ================================================================
//  VAISSEAUX — statut (énergie, boucliers, timers)
// ================================================================
function updateShipStatus(gs: GameState, s: Ship, dt: number) {
  s.stasisT = Math.max(0, s.stasisT - dt);
  s.empT = Math.max(0, s.empT - dt);
  s.cloakT = Math.max(0, s.cloakT - dt);
  s.invulnT = Math.max(0, s.invulnT - dt);
  for (const w of s.weapons) w.cd = Math.max(0, w.cd - dt);

  // saut spatial : canal puis téléportation
  if (s.jumpT > 0) {
    s.jumpT -= dt;
    if (s.jumpT <= 0) {
      const st = structById(gs, gs.teams[s.team]?.stationId ?? -1);
      if (st) {
        gs.fx.push({ type: 'saut', pos: { ...s.pos } });
        s.pos = add(st.pos, fromAngle(gs.rng() * Math.PI * 2, st.radius + 30));
        s.vel = v2();
        gs.fx.push({ type: 'saut', pos: { ...s.pos } });
      }
      s.energy = 0;
    }
  }

  // vaisseau de soutien temporaire
  if (s.supportT > 0) {
    s.supportT -= dt;
    if (s.supportT <= 0) {
      gs.fx.push({ type: 'saut', pos: { ...s.pos } });
      s.alive = false;
      removeFromFleet(gs, s);
      return;
    }
  }

  if (s.empT > 0) return; // désactivé : pas de régénération

  // énergie
  let regen = ENERGY_REGEN * gs.map.energyBonus;
  if (s.mode === 'radar') regen *= 0.6;
  s.energy = clamp(s.energy + regen * dt, 0, s.energyMax);

  // bouclier : puise dans l'énergie
  if (s.shield < s.shieldMax && s.energy > 1) {
    const amt = Math.min(SHIELD_RECHARGE_RATE * dt, s.shieldMax - s.shield, s.energy);
    s.shield += amt;
    s.energy -= amt * 0.6;
  }

  // coque : régén après 25 s sans dégât, seulement si bouclier ou énergie disponible
  if (gs.t - s.lastDmgT > HULL_REGEN_DELAY && s.hull < s.hullMax && (s.shield > 0 || s.energy > 0)) {
    const docked = isDockedAtOwnStation(gs, s);
    s.hull = clamp(s.hull + HULL_REGEN_RATE * (docked ? 5 : 1) * dt, 0, s.hullMax);
  }

  // amarré à sa station : vente auto de la soute + réassort de mines
  if (isDockedAtOwnStation(gs, s)) {
    autoSell(gs, s);
    const team = gs.teams[s.team];
    if (team && s.mineCount < s.mineMax && team.credits >= MINE_RESTOCK_PRICE) {
      s.mineCount++; team.credits -= MINE_RESTOCK_PRICE;
    }
  }
}

export function isDockedAtOwnStation(gs: GameState, s: Ship): boolean {
  const team = gs.teams[s.team];
  if (!team) return false;
  const st = structById(gs, team.stationId);
  return !!st && dist(s.pos, st.pos) < DOCK_RANGE;
}

function autoSell(gs: GameState, s: Ship) {
  const total = cargoTotal(s);
  if (total <= 0) return;
  const team = gs.teams[s.team];
  if (!team) return;
  let credits = 0;
  for (const r of ['roche', 'minerai', 'gaz'] as Res[]) {
    credits += s.cargo[r] * RES_PRICE[r];
    s.cargo[r] = 0;
  }
  team.credits += Math.round(credits);
  if (s.team === gs.playerTeam && s.id === gs.playerShipId) {
    addLog(gs, `Cargaison vendue : +${Math.round(credits)} crédits.`, '#ffd84b');
  }
}

// ================================================================
//  PILOTE AUTOMATIQUE — exécution des ordres
// ================================================================
function execOrder(gs: GameState, s: Ship, dt: number) {
  if (s.id === gs.playerShipId) { playerAssist(gs, s, dt); return; }
  if (s.empT > 0 || s.jumpT > 0) return;
  const o = s.order;
  switch (o.kind) {
    case 'idle': steerStop(s, dt); break;
    case 'move': {
      if (!o.pos || arrive(gs, s, o.pos, dt, 12)) s.order = { ...IDLE };
      break;
    }
    case 'guard': {
      const home = o.pos ?? s.pos;
      const foe = findFoeNear(gs, s, s.pos, SHIP_CLASSES[s.cls].sensor * 0.8);
      if (foe && SHIP_CLASSES[s.cls].power > 3 && dist(home, foe.pos) < 320) {
        combatApproach(gs, s, foe.pos, foePriority(foe), dt);
      } else {
        arrive(gs, s, home, dt, 25);
      }
      break;
    }
    case 'attack': {
      const target = shipById(gs, o.targetId ?? -1) ?? structById(gs, o.targetId ?? -1) ?? planetById(gs, o.targetId ?? -1);
      if (!target || (target.kind === 'planet' && (target.owner < 0 || target.colonyHp <= 0))) { s.order = { ...IDLE }; break; }
      combatApproach(gs, s, target.pos, target, dt);
      break;
    }
    case 'escort': {
      const lead = shipById(gs, o.targetId ?? -1);
      if (!lead) { s.order = { ...IDLE }; break; }
      // si le chef se bat, les escortes armées se battent aussi
      const leadTarget = lead.order.kind === 'attack'
        ? (shipById(gs, lead.order.targetId ?? -1) ?? structById(gs, lead.order.targetId ?? -1) ?? planetById(gs, lead.order.targetId ?? -1))
        : null;
      if (leadTarget && SHIP_CLASSES[s.cls].power > 3 && dist(s.pos, leadTarget.pos) < 380) {
        combatApproach(gs, s, leadTarget.pos, leadTarget, dt);
        break;
      }
      // une escorte attaquée se défend sans quitter la flotte
      if (SHIP_CLASSES[s.cls].power > 3 && gs.t - s.lastDmgT < 4) {
        const foe = findFoeNear(gs, s, s.pos, SHIP_CLASSES[s.cls].sensor * 0.8);
        if (foe) { combatApproach(gs, s, foe.pos, foe, dt); break; }
      }
      const f = gs.fleets.find(f => f.id === s.fleetId);
      if (f && f.leaderId === lead.id) {
        const idx = f.members.indexOf(s.id);
        const slot = formationWorldPos(lead, f.formation, Math.max(idx, 0));
        moveToward(gs, s, slot, dt, len(lead.vel) > 8 ? 0 : 6);
      } else {
        arrive(gs, s, lead.pos, dt, 40);
      }
      break;
    }
    case 'mine': mineBehavior(gs, s, dt); break;
    case 'trade': tradeBehavior(gs, s, dt); break;
    case 'colonize': colonizeBehavior(gs, s, dt); break;
    case 'salvage': {
      const w = gs.wrecks.find(w => w.id === o.targetId && w.alive);
      if (!w) { s.order = { ...IDLE }; break; }
      arrive(gs, s, w.pos, dt, 8);
      break;
    }
    case 'dock': {
      const st = structById(gs, gs.teams[s.team]?.stationId ?? -1);
      if (!st || dist(s.pos, st.pos) < DOCK_RANGE * 0.8) { s.order = { ...IDLE }; break; }
      arrive(gs, s, st.pos, dt, 20);
      break;
    }
    case 'flee': {
      if (!o.pos || arrive(gs, s, o.pos, dt, 30)) s.order = { ...IDLE };
      break;
    }
  }

  // riposte automatique des vaisseaux armés inactifs (les pirates ont leur propre IA)
  if (s.team !== PIRATE_TEAM) {
    if ((o.kind === 'idle' || o.kind === 'move' || o.kind === 'dock') && SHIP_CLASSES[s.cls].power > 3 && s.aiCd <= 0) {
      const foe = findFoeNear(gs, s, s.pos, SHIP_CLASSES[s.cls].sensor * 0.7);
      if (foe) s.order = { kind: 'attack', targetId: foe.id };
      s.aiCd = 0.6;
    }
    s.aiCd -= dt;
  }
}

/** L'amiral du joueur : uniquement l'auto-récupération d'épaves à proximité. */
function playerAssist(gs: GameState, s: Ship, dt: number) {
  for (const w of gs.wrecks) {
    if (!w.alive) continue;
    if (dist(w.pos, s.pos) < SALVAGE_RANGE + s.radius) {
      w.alive = false;
      const team = gs.teams[s.team];
      if (team) team.credits += w.value;
      addLog(gs, `Épave récupérée : +${w.value} crédits.`, '#ffd84b');
      gs.fx.push({ type: 'impact', pos: { ...w.pos }, color: 0xffd84b, size: 8 });
    }
  }
}

function foePriority(foe: Ship | Structure): Ship | Structure { return foe; }

function findFoeNear(gs: GameState, s: Ship, pos: V2, range: number): Ship | null {
  return nearestShip(gs, pos, o => isEnemy(s.team, o.team) && canDetect(gs, s.team, o) && o.smokeT <= 0, range);
}

/** S'approche de la cible et tire avec toutes les armes prêtes. */
function combatApproach(gs: GameState, s: Ship, targetPos: V2, target: Ship | Structure | Planet, dt: number) {
  const def = SHIP_CLASSES[s.cls];
  const mainW = s.weapons[0] ? WEAPONS[s.weapons[0].wid] : null;
  const idealRange = mainW ? mainW.range * 0.72 : 120;
  const d = dist(s.pos, targetPos);

  if (d > idealRange) {
    moveToward(gs, s, targetPos, dt, 0);
  } else {
    // orbite autour de la cible
    const tangent = angleOf(sub(s.pos, targetPos)) + Math.PI / 2 + Math.sin(s.avoidSeed) * 0.4;
    const orbit = add(targetPos, fromAngle(tangent, 0));
    const dir = fromAngle(angleOf(sub(s.pos, targetPos)) + Math.PI / 2, 1);
    s.vel = add(s.vel, scale(dir, def.accel * 0.5 * dt));
    if (d < idealRange * 0.6) {
      const away = norm(sub(s.pos, targetPos));
      s.vel = add(s.vel, scale(away, def.accel * 0.6 * dt));
    }
  }

  // tir
  for (let i = 0; i < s.weapons.length; i++) {
    const w = WEAPONS[s.weapons[i].wid];
    if (d < w.range * 1.05) {
      const targetId = target.kind === 'planet' ? undefined : (target as Ship | Structure).id;
      fireShipWeapon(gs, s, i, targetPos, targetId, target.kind === 'planet' ? target.id : undefined);
    }
  }
}

// ---------- Aides au déplacement ----------
function moveToward(gs: GameState, s: Ship, target: V2, dt: number, stopDist: number) {
  const def = SHIP_CLASSES[s.cls];
  const to = sub(target, s.pos);
  const d = len(to);
  if (d < Math.max(stopDist, 2)) { steerStop(s, dt); return; }
  const dir = norm(to);
  // évitement simple des astres
  const avoid = avoidHazards(gs, s);
  const final = norm(add(dir, avoid));
  s.vel = add(s.vel, scale(final, def.accel * dt));
}

/** Arrivée avec freinage. Retourne true si arrivé. */
function arrive(gs: GameState, s: Ship, target: V2, dt: number, tolerance: number): boolean {
  const d = dist(s.pos, target);
  if (d < tolerance) { steerStop(s, dt); return true; }
  if (d < 60) {
    const def = SHIP_CLASSES[s.cls];
    const dir = norm(sub(target, s.pos));
    const wanted = scale(dir, Math.min(def.speed, d * 1.4));
    const delta = sub(wanted, s.vel);
    s.vel = add(s.vel, scale(delta, Math.min(1, 3 * dt)));
  } else {
    moveToward(gs, s, target, dt, 0);
  }
  return false;
}

function steerStop(s: Ship, dt: number) {
  s.vel = scale(s.vel, Math.max(0, 1 - 3 * dt));
}

function avoidHazards(gs: GameState, s: Ship): V2 {
  let out = v2();
  for (const b of gs.map.bodies) {
    const d = dist(s.pos, b.pos);
    const danger = gs.map.killRadius + 60;
    if (d < danger) {
      out = add(out, scale(norm(sub(s.pos, b.pos)), (danger - d) / danger * 2.5));
    }
  }
  if (gs.map.blackHole) {
    const d = len(s.pos);
    if (d < gs.map.killRadius + 220) out = add(out, scale(norm(s.pos), 2));
  }
  return out;
}

// ---------- Comportements économiques ----------
function mineBehavior(gs: GameState, s: Ship, dt: number) {
  const team = gs.teams[s.team];
  s.miningRes = null;
  if (cargoTotal(s) >= s.cargoMax - 0.5) {
    const st = structById(gs, team?.stationId ?? -1);
    if (!st) { s.order = { ...IDLE }; return; }
    arrive(gs, s, st.pos, dt, DOCK_RANGE * 0.6); // la vente est automatique une fois amarré
    return;
  }
  // cible : astéroïde ou nuage
  let target = gs.roids.find(r => r.id === s.order.targetId && r.alive && r.amount > 0)
    ?? gs.clouds.find(c => c.id === s.order.targetId && c.alive && c.amount > 0);
  if (!target) {
    const near = nearestRoid(gs, s.pos, 900) ?? nearestCloud(gs, s.pos, 900);
    if (!near) { s.order = { ...IDLE }; return; }
    s.order.targetId = near.id;
    target = near;
  }
  const d = dist(s.pos, target.pos);
  const reach = MINING_RANGE + target.radius;
  if (d > reach) { moveToward(gs, s, target.pos, dt, reach * 0.7); return; }
  steerStop(s, dt);
  harvest(gs, s, target, dt);
}

export function harvest(gs: GameState, s: Ship, target: { kind: string; rtype?: 'roche' | 'minerai'; amount: number; pos: V2; alive: boolean }, dt: number) {
  const res: Res = target.kind === 'gas' ? 'gaz' : (target.rtype ?? 'roche');
  const rate = MINING_RATE * (s.cls === 'mineur' ? 1.6 : 1);
  const amt = Math.min(rate * dt, target.amount);
  const taken = addCargo(s, res, amt);
  target.amount -= taken;
  s.miningRes = res;
  if (target.amount <= 0) { target.alive = false; gs.fx.push({ type: 'explosion', pos: target.pos, size: 6, color: 0x8a93a0 }); }
  if (Math.random() < dt * 6) gs.fx.push({ type: 'minage', pos: { ...target.pos }, pos2: { ...s.pos }, color: res === 'gaz' ? 0x6dff8a : res === 'minerai' ? 0xffd84b : 0xc8b8a8 });
}

function tradeBehavior(gs: GameState, s: Ship, dt: number) {
  const team = gs.teams[s.team];
  if (!team) { s.order = { ...IDLE }; return; }
  let planet = planetById(gs, s.order.targetId ?? -1);
  if (!planet || planet.owner !== s.team) {
    planet = gs.planets.find(p => p.alive && p.owner === s.team) ?? undefined as any;
    if (!planet) { s.order = { ...IDLE }; return; }
    s.order.targetId = planet.id;
  }
  if (s.tradePhase === 0) {
    if (dist(s.pos, planet.pos) < planet.radius + 30) { s.tradePhase = 1; gs.fx.push({ type: 'impact', pos: { ...s.pos }, color: 0xffd84b, size: 6 }); }
    else moveToward(gs, s, planet.pos, dt, planet.radius + 20);
  } else {
    const st = structById(gs, team.stationId);
    if (!st) { s.order = { ...IDLE }; return; }
    if (dist(s.pos, st.pos) < DOCK_RANGE) {
      team.credits += TRADE_PROFIT;
      s.tradePhase = 0;
      if (s.team === gs.playerTeam) addLog(gs, `Livraison commerciale : +${TRADE_PROFIT} crédits.`, '#ffd84b');
    } else moveToward(gs, s, st.pos, dt, DOCK_RANGE * 0.5);
  }
}

function colonizeBehavior(gs: GameState, s: Ship, dt: number) {
  const team = gs.teams[s.team];
  const planet = planetById(gs, s.order.targetId ?? -1);
  if (!planet || !team || (planet.owner >= 0 && planet.owner !== s.team)) { s.order = { ...IDLE }; s.colonizeT = 0; return; }
  if (planet.owner === s.team) { s.order = { ...IDLE }; s.colonizeT = 0; return; }
  const d = dist(s.pos, planet.pos);
  if (d > planet.radius + 42) { s.colonizeT = 0; moveToward(gs, s, planet.pos, dt, planet.radius + 30); return; }
  steerStop(s, dt);
  s.colonizeT += dt;
  if (Math.random() < dt * 4) gs.fx.push({ type: 'colonise', pos: { ...planet.pos }, pos2: { ...s.pos }, color: gs.teams[s.team].color });
  if (s.colonizeT >= COLONIZE_TIME) {
    s.colonizeT = 0;
    if (team.credits >= COLONIZE_COST) {
      team.credits -= COLONIZE_COST;
      planet.owner = s.team;
      planet.colonyHp = planet.colonyHpMax;
      addLog(gs, `${team.name} colonise ${planet.name} !`, team.cssColor);
      if (s.team === gs.playerTeam) setAlert(gs, `${planet.name} COLONISÉE`, 2.5);
      s.order = { ...IDLE };
    } else {
      if (s.team === gs.playerTeam) addLog(gs, `Crédits insuffisants pour coloniser (${COLONIZE_COST}).`, '#ff8c42');
      s.order = { ...IDLE };
    }
  }
}

// ================================================================
//  INTÉGRATION PHYSIQUE
// ================================================================
function integrate(gs: GameState, s: Ship, dt: number) {
  const def = SHIP_CLASSES[s.cls];
  const maxV = def.speed * speedMult(gs, s);
  // traînée
  s.vel = scale(s.vel, Math.max(0, 1 - DRAG * dt));
  const v = len(s.vel);
  if (v > maxV) s.vel = scale(s.vel, maxV / v);
  s.pos = add(s.pos, scale(s.vel, dt));

  // cap : suit la direction du déplacement
  if (v > 6) s.heading = turnToward(s.heading, angleOf(s.vel), def.turn * dt);

  // limites du monde
  const d = len(s.pos);
  if (d > WORLD_R) s.pos = scale(s.pos, WORLD_R / d);

  // collisions douces avec astéroïdes / planètes / structures
  for (const r of gs.roids) {
    if (!r.alive) continue;
    pushOut(s, r.pos, r.radius + s.radius);
  }
  for (const p of gs.planets) {
    if (!p.alive) continue;
    pushOut(s, p.pos, p.radius + s.radius + 2);
  }
  for (const st of gs.structures) {
    if (!st.alive) continue;
    pushOut(s, st.pos, st.radius + s.radius);
  }

  // fumée : marqué si dans une zone
  s.smokeT = 0;
  for (const z of gs.smokes) {
    if (dist(s.pos, z.pos) < z.radius) { s.smokeT = 1; break; }
  }
}

function pushOut(s: Ship, center: V2, minD: number) {
  const d = dist(s.pos, center);
  if (d < minD && d > 0.01) {
    const dir = norm(sub(s.pos, center));
    s.pos = add(center, scale(dir, minD));
    const vn = s.vel.x * dir.x + s.vel.y * dir.y;
    if (vn < 0) s.vel = sub(s.vel, scale(dir, vn * 1.4));
  }
}

// ================================================================
//  ARMES
// ================================================================
/** Tire l'arme `slot` vers `aim`. targetId facultatif (beams/homing). Retourne true si le tir part. */
export function fireShipWeapon(gs: GameState, s: Ship, slot: number, aim: V2, targetId?: number, planetId?: number): boolean {
  const ws = s.weapons[slot];
  if (!ws) return false;
  if (s.empT > 0 || s.jumpT > 0) return false;
  if (s.mode === 'croisiere' || s.mode === 'espion') return false;
  const w = WEAPONS[ws.wid];
  if (ws.cd > 0 || s.energy < w.energy) return false;

  ws.cd = w.cd;
  s.energy -= w.energy;
  if (s.cloakT > 0) s.cloakT = 0; // tirer révèle

  const from = add(s.pos, fromAngle(s.heading, s.radius + 2));
  const dir = norm(sub(aim, s.pos));

  if (w.type === 'beam') {
    // cible : id fourni, sinon la plus proche du rayon
    let target: Ship | Structure | Planet | undefined =
      shipById(gs, targetId ?? -1) ?? structById(gs, targetId ?? -1) ?? planetById(gs, planetId ?? -1);
    if (!target) target = beamPick(gs, s, aim, w.range);
    if (target) {
      const hitPos = { ...target.pos };
      dealHit(gs, target, w.dmg, s.team, w.id);
      if (target.kind === 'ship' && w.slowFactor) target.stasisT = Math.max(target.stasisT, w.slowDur ?? 1.5);
      gs.fx.push({ type: 'beam', pos: { ...from }, pos2: hitPos, color: w.color, wid: w.id });
    } else {
      gs.fx.push({ type: 'beam', pos: { ...from }, pos2: add(s.pos, scale(dir, w.range)), color: w.color, wid: w.id });
    }
    return true;
  }

  // projectiles
  const spread = w.spread ?? 0;
  const a = angleOf(dir) + (spread > 0 ? (gs.rng() - 0.5) * 2 * spread : 0);
  const vel = fromAngle(a, w.speed ?? 200);
  const ttl = (w.range / (w.speed ?? 200)) * 1.15;
  let homing: number | null = null;
  if (w.type === 'homing') {
    homing = targetId ?? nearestShip(gs, aim, o => isEnemy(s.team, o.team), 160)?.id
      ?? nearestStruct(gs, aim, o => isEnemy(s.team, o.team), 160)?.id ?? null;
  }
  makeProjectile(gs, s.team, w.id, from, vel, w.dmg, ttl, homing);
  gs.fx.push({ type: 'tir', pos: { ...from }, color: w.color, wid: w.id });
  return true;
}

function beamPick(gs: GameState, s: Ship, aim: V2, range: number): Ship | Structure | undefined {
  const dir = norm(sub(aim, s.pos));
  let best: Ship | Structure | undefined; let bd = Infinity;
  const consider = (e: Ship | Structure) => {
    const to = sub(e.pos, s.pos);
    const d = len(to);
    if (d > range + 10) return;
    const proj = to.x * dir.x + to.y * dir.y;
    if (proj < 0) return;
    const lateral = Math.abs(to.x * dir.y - to.y * dir.x);
    const width = (e.kind === 'ship' ? e.radius : e.radius) + 8;
    if (lateral < width && d < bd) { bd = d; best = e; }
  };
  for (const o of gs.ships) if (o.alive && isEnemy(s.team, o.team)) consider(o);
  for (const o of gs.structures) if (o.alive && isEnemy(s.team, o.team)) consider(o);
  return best;
}

// ================================================================
//  PROJECTILES
// ================================================================
function updateProjectiles(gs: GameState, dt: number) {
  for (const p of gs.projectiles) {
    if (!p.alive) continue;
    p.ttl -= dt;
    if (p.ttl <= 0) { p.alive = false; continue; }

    if (p.homingId != null) {
      const t = shipById(gs, p.homingId) ?? structById(gs, p.homingId);
      if (t) {
        const w = WEAPONS[p.wid];
        const want = norm(sub(t.pos, p.pos));
        const speed = w.speed ?? 120;
        const cur = norm(p.vel);
        const blended = norm(add(scale(cur, 4), want));
        p.vel = scale(blended, speed);
      }
    }
    p.pos = add(p.pos, scale(p.vel, dt));

    // impacts
    const w = WEAPONS[p.wid];
    let hit: Ship | Structure | Planet | null = null;
    for (const s of gs.ships) {
      if (!s.alive || !isEnemy(p.team, s.team)) continue;
      if (dist(s.pos, p.pos) < s.radius + 3) { hit = s; break; }
    }
    if (!hit) {
      for (const st of gs.structures) {
        if (!st.alive || !isEnemy(p.team, st.team)) continue;
        if (dist(st.pos, p.pos) < st.radius + 3) { hit = st; break; }
      }
    }
    if (!hit) {
      for (const pl of gs.planets) {
        if (!pl.alive) continue;
        if (dist(pl.pos, p.pos) < pl.radius + 2) { hit = pl.owner >= 0 && isEnemy(p.team, pl.owner) ? pl : null; if (!hit) p.alive = false; break; }
      }
    }
    if (!hit) {
      for (const r of gs.roids) {
        if (!r.alive) continue;
        if (dist(r.pos, p.pos) < r.radius + 2) { p.alive = false; gs.fx.push({ type: 'impact', pos: { ...p.pos }, color: 0x8a93a0, size: 4 }); break; }
      }
    }
    if (hit) {
      p.alive = false;
      if (w.aoe && w.aoe > 0) {
        areaDamage(gs, p.pos, w.aoe, w.dmg, p.team);
        // areaDamage ignore les planètes : la colonie touchée prend les dégâts directs
        if (hit.kind === 'planet') dealHit(gs, hit, p.dmg, p.team, p.wid);
        gs.fx.push({ type: 'explosion', pos: { ...p.pos }, size: w.aoe, color: w.color });
      } else {
        dealHit(gs, hit, p.dmg, p.team, p.wid);
        gs.fx.push({ type: 'impact', pos: { ...p.pos }, color: w.color, size: 5 });
      }
    }
  }
}

// ================================================================
//  DÉGÂTS & MORT
// ================================================================
export function dealHit(gs: GameState, target: Ship | Structure | Planet, dmg: number, attackerTeam: number, wid?: WeaponId) {
  if (target.kind === 'planet') {
    if (target.owner < 0) return;
    target.colonyHp -= dmg;
    if (target.colonyHp <= 0) {
      const owner = gs.teams[target.owner];
      addLog(gs, `La colonie de ${target.name} est détruite !`, owner?.cssColor ?? '#fff');
      if (target.owner === gs.playerTeam) setAlert(gs, `COLONIE ${target.name.toUpperCase()} PERDUE`, 3);
      target.owner = NO_TEAM;
      target.colonyHp = 0;
      gs.fx.push({ type: 'explosion', pos: { ...target.pos }, size: target.radius, color: 0xff8c42 });
    }
    return;
  }
  applyDamage(gs, target, dmg, attackerTeam);
}

export function applyDamage(gs: GameState, target: Ship | Structure, dmg: number, attackerTeam: number, environmental = false) {
  if (target.kind === 'ship') {
    if (target.invulnT > 0) { gs.fx.push({ type: 'bulle', pos: { ...target.pos }, size: target.radius + 6 }); return; }
    if (target.smokeT > 0 && !environmental) dmg *= 0.55;
    target.lastDmgT = gs.t;
  }
  // bouclier d'abord
  const absorbed = Math.min(target.shield, dmg);
  target.shield -= absorbed;
  const rest = dmg - absorbed;
  if (rest > 0) target.hull -= rest;

  if (target.kind === 'ship') {
    // riposte des unités passives
    if (!environmental && attackerTeam >= 0 && (target.order.kind === 'idle' || target.order.kind === 'guard')) {
      if (SHIP_CLASSES[target.cls].power > 3) {
        const attacker = nearestShip(gs, target.pos, s => s.team === attackerTeam, 400);
        if (attacker) target.order = { kind: 'attack', targetId: attacker.id };
      } else if (target.id !== gs.playerShipId) {
        // les civils fuient vers la station
        const st = structById(gs, gs.teams[target.team]?.stationId ?? -1);
        if (st) target.order = { kind: 'flee', pos: { ...st.pos } };
      }
    }
    if (target.hull <= 0) killShip(gs, target, attackerTeam);
  } else if (target.hull <= 0) {
    destroyStructure(gs, target, attackerTeam);
  }
}

function areaDamage(gs: GameState, pos: V2, radius: number, dmg: number, team: number) {
  for (const s of gs.ships) {
    if (!s.alive || !isEnemy(team, s.team)) continue;
    const d = dist(s.pos, pos);
    if (d < radius + s.radius) applyDamage(gs, s, dmg * (1 - d / (radius + s.radius) * 0.5), team);
  }
  for (const st of gs.structures) {
    if (!st.alive || !isEnemy(team, st.team)) continue;
    const d = dist(st.pos, pos);
    if (d < radius + st.radius) applyDamage(gs, st, dmg, team);
  }
}

export function killShip(gs: GameState, s: Ship, attackerTeam: number) {
  if (!s.alive) return;
  s.alive = false;
  removeFromFleet(gs, s);
  gs.fx.push({ type: 'explosion', pos: { ...s.pos }, size: s.radius * 2.4, color: 0xff8c42 });
  if (s.supportT <= 0) makeWreck(gs, s.pos, WRECK_VALUE[s.cls], s.cls);

  const killer = gs.teams[attackerTeam];
  if (killer && attackerTeam !== s.team) {
    killer.credits += KILL_BOUNTY[s.cls];
    killer.kills++;
  }
  const owner = gs.teams[s.team];
  if (s.isFlagship && owner) {
    owner.respawnT = 4;
    if (s.team === gs.playerTeam) {
      gs.playerShipId = -1;
      setAlert(gs, 'VAISSEAU DÉTRUIT — RÉAPPARITION…', 3.5);
      addLog(gs, 'Votre vaisseau a été détruit. La cargaison est perdue.', '#ff4b4b');
    } else {
      addLog(gs, `L'amiral ${owner.name} a été abattu !`, owner.cssColor);
    }
  }
  if (s.team === PIRATE_TEAM && killer) {
    addLog(gs, `Raider pirate détruit par ${killer.name}.`, '#9aa0a8');
  }
}

export function destroyStructure(gs: GameState, st: Structure, attackerTeam: number) {
  if (!st.alive) return;
  st.alive = false;
  gs.fx.push({ type: 'explosion', pos: { ...st.pos }, size: st.radius * 2.2, color: 0xff6b4b });
  const owner = gs.teams[st.team];
  if (st.stype === 'station' && owner) {
    eliminateTeam(gs, st.team, attackerTeam);
  } else if (owner) {
    addLog(gs, `${STRUCTS[st.stype].nom} ${owner.name} détruit(e).`, owner.cssColor);
    if (st.team === gs.playerTeam) setAlert(gs, 'STRUCTURE PERDUE', 2.5);
  }
}

function eliminateTeam(gs: GameState, teamId: number, attackerTeam: number) {
  const team = gs.teams[teamId];
  if (!team || !team.alive) return;
  team.alive = false;
  addLog(gs, `☠ L'équipe ${team.name} est ÉLIMINÉE !`, team.cssColor);
  setAlert(gs, `ÉQUIPE ${team.name.toUpperCase()} ÉLIMINÉE`, 4);
  // ses vaisseaux explosent, ses structures tombent, ses colonies se libèrent
  for (const s of gs.ships) {
    if (s.alive && s.team === teamId) killShip(gs, s, NO_TEAM);
  }
  for (const st of gs.structures) {
    if (st.alive && st.team === teamId) {
      st.alive = false;
      gs.fx.push({ type: 'explosion', pos: { ...st.pos }, size: st.radius * 1.6, color: 0xff6b4b });
    }
  }
  for (const p of gs.planets) {
    if (p.alive && p.owner === teamId) { p.owner = NO_TEAM; p.colonyHp = 0; }
  }
}

// ================================================================
//  STRUCTURES (tourelles, revenus)
// ================================================================
function updateStructures(gs: GameState, dt: number) {
  for (const st of gs.structures) {
    if (!st.alive) continue;
    const def = STRUCTS[st.stype];
    st.fireCd = Math.max(0, st.fireCd - dt);

    // bouclier des structures (coupé en mort subite)
    if (st.shield < st.shieldMax && gs.t < SUDDEN_DEATH_T) st.shield = clamp(st.shield + 4 * dt, 0, st.shieldMax);

    // tourelle
    if (def.weaponDmg > 0 && st.fireCd <= 0) {
      const foe = nearestShip(gs, st.pos, s => isEnemy(st.team, s.team) && s.smokeT <= 0 && s.cloakT <= 0, def.weaponRange);
      if (foe) {
        st.fireCd = def.weaponCd;
        const dir = norm(sub(foe.pos, st.pos));
        makeProjectile(gs, st.team, 'canon', add(st.pos, scale(dir, st.radius + 2)), scale(dir, 280), def.weaponDmg + st.level * 2, def.weaponRange / 280 * 1.1, null);
        gs.fx.push({ type: 'tir', pos: { ...st.pos }, color: 0xffd27a, wid: 'canon' });
      }
    }

    // revenus
    const team = gs.teams[st.team];
    if (!team || !team.alive) continue;
    const mult = team.isAI ? DIFF_MULT[gs.cfg.difficulty] : 1;
    st.incomeT += dt;
    if (st.stype === 'station' && st.incomeT >= PASSIVE_INCOME_PERIOD) {
      st.incomeT = 0;
      team.credits += Math.round(PASSIVE_INCOME * mult);
    }
    if (st.stype === 'mine' && st.incomeT >= MINE_INCOME_PERIOD) {
      st.incomeT = 0;
      const nearRoid = gs.roids.some(r => r.alive && dist(r.pos, st.pos) < 150);
      if (nearRoid) team.credits += Math.round(MINE_INCOME * mult);
    }
  }
}

function updatePlanets(gs: GameState, dt: number) {
  for (const p of gs.planets) {
    if (!p.alive || p.owner < 0) continue;
    const team = gs.teams[p.owner];
    if (!team || !team.alive) { p.owner = NO_TEAM; continue; }
    // la colonie se répare lentement
    p.colonyHp = clamp(p.colonyHp + 2 * dt, 0, p.colonyHpMax);
    p.incomeT += dt;
    if (p.incomeT >= PLANET_INCOME_PERIOD) {
      p.incomeT = 0;
      const mult = team.isAI ? DIFF_MULT[gs.cfg.difficulty] : 1;
      team.credits += Math.round(PLANET_INCOME * mult);
      if (p.owner === gs.playerTeam) addLog(gs, `${p.name} : +${PLANET_INCOME} crédits.`, '#6dff8a');
    }
  }
}

// ================================================================
//  MINES LARGUÉES
// ================================================================
export function dropMine(gs: GameState, s: Ship): boolean {
  if (!s.mineType || s.mineCount <= 0) return false;
  s.mineCount--;
  const def = MINES[s.mineType];
  makeMineEnt(gs, s.team, s.mineType, add(s.pos, fromAngle(s.heading + Math.PI, s.radius + 4)), def.fuse);
  return true;
}

function updateMines(gs: GameState, dt: number) {
  for (const m of gs.minesArmed) {
    if (!m.alive) continue;
    m.armed = Math.max(0, m.armed - dt);
    m.timer -= dt;
    let boom = m.timer <= 0;
    if (!boom && m.armed <= 0) {
      const foe = nearestShip(gs, m.pos, s => isEnemy(m.team, s.team), 14);
      if (foe) boom = true;
    }
    if (m.mtype === 'aimant' && m.armed <= 0) {
      // attire en continu avant d'exploser
      for (const s of gs.ships) {
        if (!s.alive || !isEnemy(m.team, s.team)) continue;
        const d = dist(s.pos, m.pos);
        if (d < MINES.aimant.radius * 2.2 && d > 4) {
          s.vel = add(s.vel, scale(norm(sub(m.pos, s.pos)), 90 * dt));
        }
      }
    }
    if (boom) {
      m.alive = false;
      const def = MINES[m.mtype];
      gs.fx.push({ type: 'explosion', pos: { ...m.pos }, size: def.radius, color: def.color });
      if (m.mtype === 'emp') {
        for (const s of gs.ships) {
          if (!s.alive || !isEnemy(m.team, s.team)) continue;
          if (dist(s.pos, m.pos) < def.radius) {
            s.energy = Math.max(0, s.energy - 100);
            s.shield *= 0.3;
            s.empT = Math.max(s.empT, 2);
            applyDamage(gs, s, def.dmg, m.team);
          }
        }
      } else {
        areaDamage(gs, m.pos, def.radius, def.dmg, m.team);
      }
    }
  }
}

function updateSmoke(gs: GameState, dt: number) {
  for (const z of gs.smokes) z.t -= dt;
  gs.smokes = gs.smokes.filter(z => z.t > 0);
}

function updateWrecks(gs: GameState, dt: number) {
  for (const w of gs.wrecks) {
    if (!w.alive) continue;
    w.t -= dt;
    if (w.t <= 0) { w.alive = false; continue; }
    // récupération par n'importe quel vaisseau proche (IA comprise)
    for (const s of gs.ships) {
      if (!s.alive || s.id === gs.playerShipId) continue;
      if (dist(s.pos, w.pos) < SALVAGE_RANGE) {
        w.alive = false;
        const team = gs.teams[s.team];
        if (team) team.credits += w.value;
        break;
      }
    }
  }
}

// ================================================================
//  RÉAPPARITIONS & PIRATES
// ================================================================
function updateRespawns(gs: GameState, dt: number) {
  for (const team of gs.teams) {
    if (!team.alive || team.respawnT <= 0) continue;
    team.respawnT -= dt;
    if (team.respawnT > 0) continue;
    const st = structById(gs, team.stationId);
    if (!st) continue;
    const pos = add(st.pos, fromAngle(gs.rng() * Math.PI * 2, st.radius + 25));
    const flag = makeShip(gs, team.id, 'corvette', pos);
    flag.isFlagship = true;
    applyUpgrades(gs, flag);
    gs.fx.push({ type: 'saut', pos: { ...pos } });
    if (team.id === gs.playerTeam) {
      gs.playerShipId = flag.id;
      addLog(gs, 'Nouveau vaisseau prêt. Vos améliorations sont conservées.', '#40c4ff');
    }
  }
}

function updatePirateTimer(gs: GameState, dt: number) {
  gs.pirateT -= dt;
  if (gs.pirateT <= 0) {
    const [a, b] = PIRATE_RAID_PERIOD;
    gs.pirateT = a + gs.rng() * (b - a);
    spawnPirateRaid(gs);
  }
}

// ================================================================
//  NETTOYAGE & VICTOIRE
// ================================================================
function cleanup(gs: GameState) {
  if (gs.projectiles.length > 400 || gs.projectiles.some(p => !p.alive)) {
    gs.projectiles = gs.projectiles.filter(p => p.alive);
  }
  gs.minesArmed = gs.minesArmed.filter(m => m.alive);
  // on garde les morts une frame pour le rendu, puis on purge
  gs.ships = gs.ships.filter(s => s.alive);
  gs.wrecks = gs.wrecks.filter(w => w.alive);
  gs.roids = gs.roids.filter(r => r.alive);
  gs.clouds = gs.clouds.filter(c => c.alive || c.amount > 0);
  gs.structures = gs.structures.filter(st => st.alive);
  gs.planets = gs.planets.filter(p => p.alive);
  // sélection : retire les ids disparus
  gs.selection = gs.selection.filter(id => gs.ships.some(s => s.id === id));
  // flottes vides
  gs.fleets = gs.fleets.filter(f => {
    const alive = fleetShips(gs, f).length;
    return alive >= 1;
  });
}

export function teamScore(gs: GameState, teamId: number): number {
  const team = gs.teams[teamId];
  if (!team) return 0;
  let sc = team.credits * 0.2 + team.kills * 30;
  for (const st of gs.structures) if (st.alive && st.team === teamId) sc += 60;
  for (const p of gs.planets) if (p.alive && p.owner === teamId) sc += 90;
  for (const s of gs.ships) if (s.alive && s.team === teamId) sc += SHIP_CLASSES[s.cls].power;
  return Math.round(sc);
}

function checkVictory(gs: GameState) {
  if (gs.status !== 'playing') return;
  const alive = gs.activeTeams.filter(id => gs.teams[id].alive);
  // (isAI sur l'équipe joueur = mode spectateur/test : la partie continue sans lui)
  if (!gs.teams[gs.playerTeam].alive && !gs.teams[gs.playerTeam].isAI) {
    gs.status = 'over';
    gs.winner = alive.length === 1 ? alive[0] : -1;
    gs.overReason = 'Votre station a été détruite.';
    return;
  }
  if (alive.length === 1 && gs.activeTeams.length > 1) {
    gs.status = 'over';
    gs.winner = alive[0];
    gs.overReason = alive[0] === gs.playerTeam ? 'Toutes les stations ennemies sont tombées.' : '';
    return;
  }
  // limite de temps : victoire au score
  if (gs.t >= TIME_LIMIT_T) {
    let best = -1, bestScore = -1;
    for (const id of alive) {
      const sc = teamScore(gs, id);
      if (sc > bestScore) { bestScore = sc; best = id; }
    }
    gs.status = 'over';
    gs.winner = best;
    gs.overReason = 'Temps écoulé — victoire au score.';
  }
}

// ================================================================
//  ACTIONS DU JOUEUR (boutique, construction, gadgets, modes)
// ================================================================
export function playerShip(gs: GameState): Ship | undefined {
  return shipById(gs, gs.playerShipId);
}

export function tryBuyShip(gs: GameState, teamId: number, cls: ShipClassId, pilot: boolean): string | null {
  const team = gs.teams[teamId];
  const def = SHIP_CLASSES[cls];
  if (!team) return 'Équipe invalide';
  const st = structById(gs, team.stationId);
  if (!st) return 'Station détruite';
  if (st.level < def.unlockLevel) return `Nécessite station niv. ${def.unlockLevel}`;
  if (team.credits < def.prix) return 'Crédits insuffisants';
  team.credits -= def.prix;
  const pos = add(st.pos, fromAngle(gs.rng() * Math.PI * 2, st.radius + 25));
  const ship = makeShip(gs, teamId, cls, pos);
  gs.fx.push({ type: 'saut', pos: { ...pos } });
  if (pilot && teamId === gs.playerTeam) {
    const old = playerShip(gs);
    if (old) {
      // reprise : l'ancien vaisseau est revendu à moitié prix
      team.credits += Math.round(SHIP_CLASSES[old.cls].prix * 0.5);
      old.alive = false;
      removeFromFleet(gs, old);
    }
    ship.isFlagship = true;
    applyUpgrades(gs, ship);
    gs.playerShipId = ship.id;
    addLog(gs, `Vous pilotez maintenant : ${def.nom}.`, '#40c4ff');
  } else {
    // vaisseau recruté : ordres par défaut selon la classe
    if (cls === 'mineur') ship.order = { kind: 'mine' };
    else if (cls === 'cargo') ship.order = { kind: 'trade' };
    else ship.order = { kind: 'guard', pos: { ...st.pos } };
  }
  return null;
}

export function tryBuyUpgrade(gs: GameState, teamId: number, upgradeId: string): string | null {
  const team = gs.teams[teamId];
  if (!team) return 'Équipe invalide';
  const def = UPGRADES.find(u => u.id === upgradeId);
  if (!def) return 'Amélioration inconnue';
  const lvl = team.upgrades[upgradeId] ?? 0;
  if (lvl >= def.prix.length) return 'Niveau maximum atteint';
  const price = def.prix[lvl];
  if (team.credits < price) return 'Crédits insuffisants';
  team.credits -= price;
  team.upgrades[upgradeId] = lvl + 1;
  // application immédiate sur l'amiral
  const flag = teamId === gs.playerTeam ? playerShip(gs) : gs.ships.find(s => s.alive && s.team === teamId && s.isFlagship);
  if (flag) {
    // recalcul depuis les stats de base (1 + mult × niveau), cohérent avec applyUpgrades
    const base = SHIP_CLASSES[flag.cls];
    const newLvl = lvl + 1;
    if (upgradeId === 'coque') {
      const nm = Math.round(base.hull * (1 + def.mult * newLvl));
      flag.hull = Math.min(nm, flag.hull + Math.max(0, nm - flag.hullMax));
      flag.hullMax = nm;
    }
    if (upgradeId === 'bouclier') flag.shieldMax = Math.round(base.shield * (1 + def.mult * newLvl));
    if (upgradeId === 'energie') flag.energyMax = Math.round(base.energy * (1 + def.mult * newLvl));
    if (upgradeId === 'soute') flag.cargoMax = Math.round(base.cargo * (1 + def.mult * newLvl));
  }
  return null;
}

export function tryBuyWeapon(gs: GameState, teamId: number, wid: WeaponId): string | null {
  const team = gs.teams[teamId];
  if (!team) return 'Équipe invalide';
  const flag = playerShip(gs);
  if (!flag) return 'Aucun vaisseau';
  const def = WEAPONS[wid];
  const slots = SHIP_CLASSES[flag.cls].secondarySlots;
  if (slots <= 0) return 'Ce vaisseau n\'a pas d\'emplacement secondaire';
  if (flag.weapons.some(w => w.wid === wid)) return 'Déjà équipée';
  if (team.credits < def.prix) return 'Crédits insuffisants';
  team.credits -= def.prix;
  if (!team.secondaries.includes(wid)) team.secondaries.push(wid);
  if (flag.weapons.length < 1 + slots) flag.weapons.push({ wid, cd: 0 });
  else flag.weapons[flag.weapons.length - 1] = { wid, cd: 0 };
  addLog(gs, `Arme équipée : ${def.nom}.`, '#40c4ff');
  return null;
}

export function tryBuyGadget(gs: GameState, teamId: number, gid: GadgetId): string | null {
  const team = gs.teams[teamId];
  if (!team) return 'Équipe invalide';
  const st = structById(gs, team.stationId);
  const def = GADGETS[gid];
  if (!st) return 'Station détruite';
  if (st.level < def.unlockLevel) return `Nécessite station niv. ${def.unlockLevel}`;
  if (team.gadgets.includes(gid)) return 'Déjà acquis';
  if (team.credits < def.prix) return 'Crédits insuffisants';
  team.credits -= def.prix;
  team.gadgets.push(gid);
  addLog(gs, `Gadget débloqué : ${def.nom}.`, '#40c4ff');
  return null;
}

export function tryUpgradeStation(gs: GameState, teamId: number): string | null {
  const team = gs.teams[teamId];
  if (!team) return 'Équipe invalide';
  const st = structById(gs, team.stationId);
  if (!st) return 'Station détruite';
  if (st.level >= 3) return 'Niveau maximum';
  const price = STATION_UPGRADE_PRICE[st.level];
  if (team.credits < price) return 'Crédits insuffisants';
  team.credits -= price;
  st.level++;
  st.hullMax += 300; st.hull += 300;
  st.shieldMax += 100;
  addLog(gs, `Station ${team.name} améliorée : niveau ${st.level}.`, team.cssColor);
  return null;
}

export function canPlaceStructure(gs: GameState, teamId: number, stype: StructType, pos: V2): string | null {
  const team = gs.teams[teamId];
  if (!team) return 'Équipe invalide';
  const def = STRUCTS[stype];
  if (team.credits < def.prix) return 'Crédits insuffisants';
  // dans le territoire : à portée d'une structure existante
  const near = gs.structures.some(st => st.alive && st.team === teamId &&
    dist(st.pos, pos) < (st.stype === 'station' ? 420 : 300));
  if (!near) return 'Trop loin de votre territoire';
  for (const st of gs.structures) if (st.alive && dist(st.pos, pos) < st.radius + def.radius + 18) return 'Trop proche d\'une structure';
  for (const p of gs.planets) if (p.alive && dist(p.pos, pos) < p.radius + def.radius + 10) return 'Trop proche d\'une planète';
  for (const b of gs.map.bodies) if (dist(b.pos, pos) < gs.map.killRadius + 40) return 'Trop proche de l\'étoile';
  if (stype === 'mine' && !gs.roids.some(r => r.alive && dist(r.pos, pos) < 150)) return 'Doit être proche d\'astéroïdes';
  return null;
}

export function placeStructure(gs: GameState, teamId: number, stype: StructType, pos: V2): string | null {
  const err = canPlaceStructure(gs, teamId, stype, pos);
  if (err) return err;
  const team = gs.teams[teamId]!;
  team.credits -= STRUCTS[stype].prix;
  makeStructure(gs, teamId, stype, pos);
  gs.fx.push({ type: 'saut', pos: { ...pos } });
  addLog(gs, `${STRUCTS[stype].nom} construit(e).`, team.cssColor);
  return null;
}

// ---------- Modes ----------
export function toggleMode(gs: GameState, s: Ship, mode: 'croisiere' | 'radar' | 'espion'): void {
  s.mode = s.mode === mode ? 'normal' : mode;
}

export function tryJump(gs: GameState, s: Ship): string | null {
  if (s.jumpT > 0) return 'Saut déjà en cours';
  if (s.energy < s.energyMax * 0.85) return 'Énergie insuffisante (85 % requis)';
  s.jumpT = 1.6;
  gs.fx.push({ type: 'saut', pos: { ...s.pos } });
  return null;
}

// ---------- Gadgets ----------
export function activateGadget(gs: GameState, teamId: number, gid: GadgetId, targetId?: number): string | null {
  const team = gs.teams[teamId];
  if (!team) return 'Équipe invalide';
  if (!team.gadgets.includes(gid)) return 'Gadget non débloqué';
  const cdLeft = team.gadgetCd[gid] ?? 0;
  if (cdLeft > gs.t) return 'En recharge';
  const s = teamId === gs.playerTeam ? playerShip(gs) : gs.ships.find(x => x.alive && x.team === teamId && x.isFlagship);
  if (!s) return 'Aucun vaisseau amiral';
  const def = GADGETS[gid];

  switch (gid) {
    case 'fumee':
      gs.smokes.push({ id: gs.nextId++, pos: { ...s.pos }, radius: 70, t: def.dur });
      gs.fx.push({ type: 'fumee', pos: { ...s.pos }, size: 70 });
      break;
    case 'camouflage':
      s.cloakT = def.dur;
      break;
    case 'bouclier_orbital':
      s.invulnT = def.dur;
      gs.fx.push({ type: 'bulle', pos: { ...s.pos }, size: s.radius + 10 });
      break;
    case 'frappe': {
      const target = shipById(gs, targetId ?? -1) ?? structById(gs, targetId ?? -1);
      if (!target || !isEnemy(teamId, target.team)) return 'Aucune cible ennemie visée';
      if (dist(s.pos, target.pos) > 420) return 'Cible trop éloignée';
      gs.fx.push({ type: 'frappe', pos: { ...target.pos }, size: 30 });
      dealHit(gs, target, 170, teamId);
      areaDamage(gs, target.pos, 24, 60, teamId);
      break;
    }
    case 'soutien': {
      for (let i = 0; i < 3; i++) {
        const pos = add(s.pos, fromAngle(gs.rng() * Math.PI * 2, 34));
        const ally = makeShip(gs, teamId, 'chasseur', pos);
        ally.supportT = def.dur;
        ally.order = { kind: 'escort', targetId: s.id };
        gs.fx.push({ type: 'saut', pos: { ...pos } });
      }
      addLog(gs, 'La flotte de soutien est arrivée (3 min).', '#40c4ff');
      break;
    }
  }
  team.gadgetCd[gid] = gs.t + def.cd;
  return null;
}

/** Minage manuel du joueur (touche F maintenue). Retourne la ressource minée ou null. */
export function playerMine(gs: GameState, dt: number): Res | null {
  const s = playerShip(gs);
  if (!s) return null;
  if (cargoTotal(s) >= s.cargoMax - 0.01) return null;
  let target: { kind: string; rtype?: 'roche' | 'minerai'; amount: number; pos: V2; alive: boolean; radius: number } | null = null;
  const roid = nearestRoid(gs, s.pos, MINING_RANGE + 20);
  if (roid && dist(roid.pos, s.pos) < MINING_RANGE + roid.radius) target = roid;
  if (!target) {
    const cloud = nearestCloud(gs, s.pos, 120);
    if (cloud && dist(cloud.pos, s.pos) < cloud.radius + 10) target = cloud;
  }
  if (!target) return null;
  harvest(gs, s, target, dt);
  return s.miningRes;
}

/** Prend le contrôle du vaisseau allié le plus proche (l'actuel passe à l'IA). */
export function takeControlNearest(gs: GameState): string | null {
  const cur = playerShip(gs);
  if (!cur) return 'Aucun vaisseau';
  const other = nearestShip(gs, cur.pos, s => s.team === gs.playerTeam && s.id !== cur.id && s.supportT <= 0, 220);
  if (!other) return 'Aucun vaisseau allié à proximité (220 m)';
  cur.isFlagship = false;
  cur.order = { kind: 'guard', pos: { ...cur.pos } };
  other.isFlagship = true;
  other.order = { ...IDLE };
  removeFromFleet(gs, other);
  gs.playerShipId = other.id;
  addLog(gs, `Contrôle transféré : ${SHIP_CLASSES[other.cls].nom}.`, '#40c4ff');
  return null;
}
