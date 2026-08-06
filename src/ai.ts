// ============ COBALT SECTOR — IA des équipes (personnalités) & flotte pirate ============
import {
  GameState, Ship, V2, v2, fromAngle, dist, len, scale, norm, sub, add, IDLE,
  PIRATE_TEAM, WORLD_R, addLog, setAlert, shipById, structById, areAllied,
} from './core';
import { SHIP_CLASSES, PERSONAS, STRUCTS, COLONIZE_COST, STATION_UPGRADE_PRICE, DIFF_TUNING } from './data';
import { makeShip, nearestShip, threatAround, canDetect, isEnemy } from './entities';
import { createFleet, setFleetMission, fleetShips } from './orders';
import {
  tryBuyShip, tryUpgradeStation, canPlaceStructure, placeStructure, teamScore,
  proposeAlliance, requestFocus,
} from './sim';

// ================================================================
//  PIRATES — la flotte grise
// ================================================================
export function spawnPirateRaid(gs: GameState) {
  // les raids grossissent avec le temps
  const size = Math.min(2 + Math.floor(gs.t / 300), 5);
  const edgeA = gs.rng() * Math.PI * 2;
  const spawnPos = fromAngle(edgeA, WORLD_R * 0.98);
  for (let i = 0; i < size; i++) {
    const p = add(spawnPos, fromAngle(gs.rng() * Math.PI * 2, 25));
    const raider = makeShip(gs, PIRATE_TEAM, 'raider', p, edgeA + Math.PI);
    raider.order = { ...IDLE };
    gs.fx.push({ type: 'saut', pos: { ...p } });
  }
  addLog(gs, `⚠ Raid pirate détecté (${size} raiders) !`, '#9aa0a8');
  setAlert(gs, 'RAID PIRATE DÉTECTÉ', 3);
}

export function thinkPirates(gs: GameState, dt: number) {
  const pirates = gs.ships.filter(s => s.alive && s.team === PIRATE_TEAM);
  if (pirates.length === 0) return;

  // puissance du groupe : les pirates raisonnent en meute
  const packPower = pirates.reduce((a, s) => a + SHIP_CLASSES[s.cls].power, 0);

  for (const s of pirates) {
    s.aiCd -= dt;
    if (s.aiCd > 0) continue;
    s.aiCd = 0.8 + gs.rng() * 0.6;

    // en fuite arrivé au bord : disparition en saut spatial (vérifié AVANT la
    // réévaluation de la menace, sinon un pirate poursuivi ne despawne jamais)
    if (s.order.kind === 'flee' && len(s.pos) > WORLD_R * 0.94) {
      gs.fx.push({ type: 'saut', pos: { ...s.pos } });
      s.alive = false;
      continue;
    }

    // fuite : des vaisseaux plus puissants qu'eux dans leur rayon de visibilité ?
    const threat = threatAround(gs, PIRATE_TEAM, s.pos, SHIP_CLASSES.raider.sensor);
    if (threat > packPower * 1.15) {
      const foe = nearestShip(gs, s.pos, o => isEnemy(PIRATE_TEAM, o.team) && SHIP_CLASSES[o.cls].power > 5, 300);
      const away = foe ? norm(sub(s.pos, foe.pos)) : norm(s.pos);
      const fleePos = add(s.pos, scale(away, 350));
      const d = len(fleePos);
      s.order = { kind: 'flee', pos: d > WORLD_R ? scale(fleePos, WORLD_R / d) : fleePos };
      continue;
    }

    // chasse : le civil (cargo / mineur / transporteur) le plus proche
    const prey = nearestShip(gs, s.pos,
      o => o.team !== PIRATE_TEAM && o.team >= 0 && SHIP_CLASSES[o.cls].civil && o.cloakT <= 0, 1000);
    if (prey) {
      s.order = { kind: 'attack', targetId: prey.id };
      continue;
    }
    // pas de proie : rôde vers le centre puis repart
    if (s.order.kind === 'idle') {
      if (gs.rng() < 0.4) {
        s.order = { kind: 'move', pos: fromAngle(gs.rng() * Math.PI * 2, WORLD_R * (0.3 + gs.rng() * 0.5)) };
      } else {
        s.order = { kind: 'flee', pos: fromAngle(gs.rng() * Math.PI * 2, WORLD_R * 0.98) };
      }
    }
  }
}

// ================================================================
//  IA D'ÉQUIPE — macro-stratégie par personnalité
// ================================================================
export function thinkTeams(gs: GameState, dt: number) {
  for (const teamId of gs.activeTeams) {
    const team = gs.teams[teamId];
    if (!team || !team.alive || !team.isAI) continue;
    team.aiCd -= dt;
    if (team.aiCd > 0) continue;
    team.aiCd = (2.2 + gs.rng() * 1.2) * DIFF_TUNING[gs.cfg.difficulty].thinkMult;
    thinkOneTeam(gs, teamId);
  }
}

function thinkOneTeam(gs: GameState, teamId: number) {
  const team = gs.teams[teamId];
  const persona = PERSONAS[team.persona];
  const tune = DIFF_TUNING[gs.cfg.difficulty];
  const station = structById(gs, team.stationId);
  if (!station) return;

  const myShips = gs.ships.filter(s => s.alive && s.team === teamId && s.supportT <= 0);
  const miners = myShips.filter(s => s.cls === 'mineur');
  const cargos = myShips.filter(s => s.cls === 'cargo');
  const transporters = myShips.filter(s => s.cls === 'transporteur');
  const warships = myShips.filter(s => SHIP_CLASSES[s.cls].power > 5 && !s.isFlagship);
  const flagship = myShips.find(s => s.isFlagship);

  const minute = gs.t / 60;
  const myPlanets = gs.planets.filter(p => p.alive && p.owner === teamId);
  const neutralPlanets = gs.planets.filter(p => p.alive && p.owner < 0);

  // ---------- 1. DÉFENSE : la base est-elle attaquée ? ----------
  // (rappel des vaisseaux, mais l'économie et les achats continuent de tourner)
  const baseThreat = nearestShip(gs, station.pos, s => isEnemy(teamId, s.team) && SHIP_CLASSES[s.cls].power > 3, 340);
  if (baseThreat) {
    for (const w of [...warships, ...(flagship ? [flagship] : [])]) {
      if (w.order.kind !== 'attack' || gs.rng() < 0.3) w.order = { kind: 'attack', targetId: baseThreat.id };
    }
  }

  // ---------- 2. ÉCONOMIE : effectifs voulus ----------
  const wantMiners = Math.round(1 + persona.ecoFocus * 2.5);
  const wantCargos = myPlanets.length > 0 ? Math.round(1 + persona.ecoFocus * 1.5) : 0;
  const wantTransporters = neutralPlanets.length > 0 && minute > 1.5 ? 1 : 0;
  const wantWarships = Math.max(1, Math.min(9, Math.round((1 + persona.aggression * 3 + minute / 3.5) * tune.warshipMult)));

  // réserve d'argent selon la personnalité (+ budget gelé pour une colonisation en cours)
  const colonizeReserve = transporters.some(t => t.order.kind === 'colonize') ? COLONIZE_COST : 0;
  const reserve = 150 + persona.defense * 250 + colonizeReserve;
  let purchases = 0;
  const canBuy = (price: number) => team.credits - price > reserve && purchases < 2;

  if (miners.length < wantMiners && canBuy(SHIP_CLASSES.mineur.prix)) {
    if (!tryBuyShip(gs, teamId, 'mineur', false)) purchases++;
  }
  if (transporters.length < wantTransporters && canBuy(SHIP_CLASSES.transporteur.prix + COLONIZE_COST)) {
    if (!tryBuyShip(gs, teamId, 'transporteur', false)) purchases++;
  }
  if (cargos.length < wantCargos && canBuy(SHIP_CLASSES.cargo.prix)) {
    if (!tryBuyShip(gs, teamId, 'cargo', false)) purchases++;
  }
  if (warships.length < wantWarships) {
    const pool: ('chasseur' | 'bombardier' | 'croiseur')[] = ['chasseur'];
    if (station.level >= 2) {
      pool.push('bombardier');
      if (gs.rng() < 0.5) pool.push('croiseur');
    }
    const cls = pool[Math.floor(gs.rng() * pool.length)];
    if (canBuy(SHIP_CLASSES[cls].prix)) {
      if (!tryBuyShip(gs, teamId, cls, false)) purchases++;
    }
  }

  // ---------- 3. AMÉLIORATION DE STATION ----------
  if (station.level < 3 && minute > station.level * 3.5) {
    const price = STATION_UPGRADE_PRICE[station.level];
    if (team.credits - price > reserve * 0.5) tryUpgradeStation(gs, teamId);
  }

  // ---------- 4. CONSTRUCTION ----------
  if (team.credits > 900 && gs.rng() < 0.25) {
    const stype = gs.rng() < 0.45 ? 'mine' : gs.rng() < 0.7 ? 'avantposte' : 'satellite';
    for (let tries = 0; tries < 6; tries++) {
      const pos = add(station.pos, fromAngle(gs.rng() * Math.PI * 2, 120 + gs.rng() * 260));
      if (!canPlaceStructure(gs, teamId, stype, pos)) { placeStructure(gs, teamId, stype, pos); break; }
    }
  }

  // ---------- 5. ORDRES ÉCONOMIQUES ----------
  for (const m of miners) if (m.order.kind === 'idle' || m.order.kind === 'guard') m.order = { kind: 'mine' };
  for (const c of cargos) {
    if (c.order.kind === 'idle' || c.order.kind === 'guard') { c.order = { kind: 'trade' }; c.tradePhase = 0; }
  }
  for (const t of transporters) {
    if (t.order.kind !== 'colonize' && neutralPlanets.length > 0 && team.credits > COLONIZE_COST + 100) {
      let best = neutralPlanets[0], bd = Infinity;
      for (const p of neutralPlanets) {
        const d = dist(p.pos, station.pos);
        if (d < bd) { bd = d; best = p; }
      }
      t.order = { kind: 'colonize', targetId: best.id };
    }
  }

  // ---------- 5bis. DIPLOMATIE ----------
  const myAllies = gs.activeTeams.filter(id => id !== teamId && gs.teams[id].alive && areAllied(gs, teamId, id));
  if (myAllies.length === 0 && minute > 3 && gs.rng() < 0.03) {
    // menacé par une équipe bien plus forte ? cherche un partenaire (joueur compris)
    const others = gs.activeTeams.filter(id => id !== teamId && gs.teams[id].alive);
    if (others.length >= 2) {
      const myScore = teamScore(gs, teamId);
      const strongest = others.reduce((x, y) => teamScore(gs, x) >= teamScore(gs, y) ? x : y);
      if (teamScore(gs, strongest) > myScore * 1.1) {
        const candidates = others.filter(id => id !== strongest);
        const partner = candidates.reduce((x, y) => teamScore(gs, x) >= teamScore(gs, y) ? x : y, candidates[0]);
        if (partner != null) proposeAlliance(gs, teamId, partner);
      }
    }
  } else if (myAllies.length > 0 && gs.focusTargets[teamId] == null && gs.rng() < 0.04) {
    // demande à l'allié de concentrer le feu sur le plus fort des ennemis
    const foes = gs.activeTeams.filter(id => gs.teams[id].alive && id !== teamId && !areAllied(gs, teamId, id));
    if (foes.length > 0) {
      const strongest = foes.reduce((x, y) => teamScore(gs, x) >= teamScore(gs, y) ? x : y);
      requestFocus(gs, teamId, myAllies[0], strongest);
    }
  }

  // ---------- 6. OFFENSIVE ----------
  const idleWar = warships.filter(w => w.order.kind === 'idle' || w.order.kind === 'guard');
  // nettoyage des pirates dans notre territoire
  const pirateNear = nearestShip(gs, station.pos, s => s.team === PIRATE_TEAM, 600);
  if (pirateNear && idleWar.length > 0) {
    for (const w of idleWar.slice(0, 2)) w.order = { kind: 'attack', targetId: pirateNear.id };
  }

  // l'agressivité monte en fin de partie pour garantir une conclusion
  const lateGame = Math.max(0, minute - 12) * tune.lateRamp;
  const aggression = Math.min(1, (persona.aggression + lateGame) * tune.aggroMult);
  const readyForWar = warships.length >= Math.max(2, wantWarships * 0.7);

  // flottes d'attaque existantes : retarder si la cible est morte
  const attackFleets = gs.fleets.filter(f => f.team === teamId && f.mission.kind === 'attack' && fleetShips(gs, f).length >= 2);
  for (const f of attackFleets) {
    const valid = shipById(gs, f.mission.targetId ?? -1)
      ?? structById(gs, f.mission.targetId ?? -1)
      ?? gs.planets.find(p => p.id === f.mission.targetId && p.alive && p.owner >= 0);
    if (!valid) {
      const target = pickAttackTarget(gs, teamId, persona.raid, minute);
      if (target != null) setFleetMission(gs, f, { kind: 'attack', targetId: target });
    }
  }

  // renforts : en milieu de partie, les oisifs rejoignent la flotte d'attaque
  if (attackFleets.length > 0 && minute > 8) {
    const homeGuard = Math.ceil(persona.defense * 2);
    for (const w of idleWar.slice(homeGuard)) {
      w.order = { kind: 'escort', targetId: attackFleets[0].leaderId };
    }
  }

  const maxAttackFleets = minute > 14 ? 2 : 1;
  if (attackFleets.length < maxAttackFleets && readyForWar && gs.rng() < aggression * 0.35 + 0.05) {
    const target = pickAttackTarget(gs, teamId, persona.raid, minute);
    if (target != null) {
      const attackers = idleWar.length >= 2 ? idleWar : warships.filter(w => w.fleetId == null);
      const grp = attackers.slice(0, Math.max(2, Math.ceil(attackers.length * (0.5 + aggression * 0.5))));
      if (grp.length >= 2) {
        const fleet = createFleet(gs, teamId, grp.map(s => s.id), gs.rng() < 0.5 ? 'coin' : 'cercle');
        if (fleet) setFleetMission(gs, fleet, { kind: 'attack', targetId: target });
      } else if (grp.length === 1) {
        grp[0].order = { kind: 'attack', targetId: target };
      }
    }
  }

  // ---------- 7. AMIRAL ----------
  if (flagship && (flagship.order.kind === 'idle')) {
    if (persona.aggression > 0.6 && warships.length >= 2 && gs.rng() < 0.4) {
      // l'amiral agressif accompagne ses flottes
      const fleet = gs.fleets.find(f => f.team === teamId && f.mission.kind === 'attack');
      if (fleet) {
        flagship.order = { kind: 'escort', targetId: fleet.leaderId };
      } else {
        flagship.order = { kind: 'guard', pos: { ...station.pos } };
      }
    } else {
      // patrouille entre ses possessions
      const spots: V2[] = [station.pos, ...myPlanets.map(p => p.pos),
        ...gs.structures.filter(s => s.alive && s.team === teamId).map(s => s.pos)];
      const spot = spots[Math.floor(gs.rng() * spots.length)];
      flagship.order = { kind: 'guard', pos: add(spot, fromAngle(gs.rng() * Math.PI * 2, 60)) };
    }
  }
}

/** Choisit une cible d'attaque : civils (raid), colonies/structures (harcèlement), stations (fin de partie). */
function pickAttackTarget(gs: GameState, teamId: number, raidPref: number, minute: number): number | null {
  const tune = DIFF_TUNING[gs.cfg.difficulty];
  if (minute < tune.harassMin) return null;
  const enemies = gs.activeTeams.filter(id => id !== teamId && gs.teams[id].alive && !areAllied(gs, teamId, id));
  if (enemies.length === 0) return null;

  // cible : 60 % l'équipe la plus faible (au score), 40 % la plus proche — évite
  // que toutes les IA se ruent sur le même joueur
  let weakest = enemies[0], ws = Infinity;
  for (const e of enemies) {
    const sc = teamScore(gs, e);
    if (sc < ws) { ws = sc; weakest = e; }
  }
  if (gs.rng() < 0.4) {
    const myStation = structById(gs, gs.teams[teamId].stationId);
    if (myStation) {
      let nearest = weakest, nd = Infinity;
      for (const e of enemies) {
        const st = structById(gs, gs.teams[e].stationId);
        if (st) {
          const d = dist(st.pos, myStation.pos);
          if (d < nd) { nd = d; nearest = e; }
        }
      }
      weakest = nearest;
    }
  }
  // cible convenue avec un allié : priorité absolue
  const focus = gs.focusTargets[teamId];
  if (focus != null && gs.teams[focus]?.alive && !areAllied(gs, teamId, focus)) weakest = focus;

  // raid sur les civils
  if (gs.rng() < raidPref) {
    const prey = gs.ships.find(s => s.alive && enemies.includes(s.team) && SHIP_CLASSES[s.cls].civil && canDetect(gs, teamId, s));
    if (prey) return prey.id;
  }

  // début de partie : harcèlement uniquement (colonies, avant-postes, civils) —
  // les sièges de station sont interdits avant la 6e minute
  const colony = gs.planets.find(p => p.alive && p.owner === weakest);
  const outpost = gs.structures.find(s => s.alive && s.team === weakest && s.stype !== 'station');
  if (minute < tune.siegeMin) {
    if (colony) return colony.id;
    if (outpost) return outpost.id;
    const anyCiv = gs.ships.find(s => s.alive && enemies.includes(s.team) && SHIP_CLASSES[s.cls].civil && canDetect(gs, teamId, s));
    return anyCiv ? anyCiv.id : null;
  }
  if (minute < tune.siegeMin + 3 && gs.rng() < 0.5) {
    if (colony) return colony.id;
    if (outpost) return outpost.id;
  }
  const station = structById(gs, gs.teams[weakest].stationId);
  return station ? station.id : null;
}
