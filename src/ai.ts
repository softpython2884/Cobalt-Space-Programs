// ============ COBALT SECTOR — IA des équipes (personnalités) & flotte pirate ============
import {
  GameState, Ship, V2, v2, fromAngle, dist, len, scale, norm, sub, add, IDLE,
  PIRATE_TEAM, WORLD_R, addLog, setAlert, shipById, structById, areAllied,
} from './core';
import {
  SHIP_CLASSES, PERSONAS, STRUCTS, COLONIZE_COST, STATION_UPGRADE_PRICE, DIFF_TUNING, DiffTuning,
  STATION_UPGRADES, COLOSSE_LABS_REQUIRED, WEAPONS, OUTPOST_MAX_LEVEL, GUARD_COST,
} from './data';
import { makeShip, nearestShip, nearestStruct, threatAround, canDetect, isEnemy } from './entities';
import { createFleet, setFleetMission, fleetShips } from './orders';
import {
  tryBuyShip, tryUpgradeStation, canPlaceStructure, placeStructure, teamScore,
  proposeAlliance, requestFocus, requestDefend, tryBuyStationUpgrade,
  salveFireCmd, colossusWorldBreaker, tryUpgradeOutpost, buyGuards, breakAlliance,
} from './sim';

/** Réglages de difficulté effectifs : en facile, l'IA monte en puissance au fil
 *  de la partie (débuts tranquilles, mais il finit par se passer des choses). */
export function effectiveTune(gs: GameState): DiffTuning {
  const t = DIFF_TUNING[gs.cfg.difficulty];
  if (gs.cfg.difficulty !== 'facile') return t;
  const ramp = Math.min(1, Math.max(0, gs.t / 60 - 10) / 20);   // 0 à 10 min → plein régime à 30 min
  return {
    ...t,
    warshipMult: t.warshipMult + (1.0 - t.warshipMult) * ramp,
    aggroMult: t.aggroMult + (1.0 - t.aggroMult) * ramp,
    buildMult: t.buildMult + (0.9 - t.buildMult) * ramp,
    thinkMult: t.thinkMult + (1.0 - t.thinkMult) * ramp,
    lateRamp: t.lateRamp + 0.04 * ramp,
  };
}

// ================================================================
//  PIRATES — la flotte grise
// ================================================================
export function spawnPirateRaid(gs: GameState) {
  // les raids grossissent avec le temps, sans plafond mou — et passé 20 min,
  // des raiders VÉTÉRANS renforcés se glissent dans les meutes
  const size = Math.min(9, 2 + Math.floor(gs.t / 260));
  const elite = gs.t > 1200;
  const edgeA = gs.rng() * Math.PI * 2;
  const spawnPos = fromAngle(edgeA, WORLD_R * 0.98);
  for (let i = 0; i < size; i++) {
    const p = add(spawnPos, fromAngle(gs.rng() * Math.PI * 2, 25));
    const raider = makeShip(gs, PIRATE_TEAM, 'raider', p, edgeA + Math.PI);
    raider.order = { ...IDLE };
    if (elite && i % 2 === 0) {
      raider.hullMax = Math.round(raider.hullMax * 1.6);
      raider.hull = raider.hullMax;
      raider.shieldMax = Math.round(raider.shieldMax * 1.5);
      raider.shield = raider.shieldMax;
    }
    gs.fx.push({ type: 'saut', pos: { ...p } });
  }
  addLog(gs, `Raid pirate détecté (${size} raiders${elite ? ' — vétérans' : ''}) !`, '#9aa0a8');
  setAlert(gs, elite ? 'RAID PIRATE VÉTÉRAN DÉTECTÉ' : 'RAID PIRATE DÉTECTÉ', 3);
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
    team.aiCd = (2.2 + gs.rng() * 1.2) * effectiveTune(gs).thinkMult;
    thinkOneTeam(gs, teamId);
  }
}

function thinkOneTeam(gs: GameState, teamId: number) {
  const team = gs.teams[teamId];
  const persona = PERSONAS[team.persona];
  const tune = effectiveTune(gs);
  const station = structById(gs, team.stationId);
  if (!station) return;

  // ---------- 0. ESCALADE : un Colosse ennemi rôde, ou on est le dernier survivant IA ----------
  // Dans les deux cas, l'IA passe en économie de guerre et frappe bien plus fort.
  const colossusThreat = gs.ships.some(sh => sh.alive && sh.cls === 'colosse' && isEnemy(teamId, sh.team));
  const aliveTeams = gs.activeTeams.filter(id => gs.teams[id].alive);
  const aliveAIs = aliveTeams.filter(id => gs.teams[id].isAI);
  // distancée au score par un ennemi (joueur qui snowball compris) : on se bat SÉRIEUSEMENT
  // dès maintenant — pas seulement quand on est la dernière IA en vie
  const myScore0 = teamScore(gs, teamId);
  let foeScoreMax = 0;
  for (const id of aliveTeams) {
    if (id === teamId || areAllied(gs, teamId, id)) continue;
    const sc = teamScore(gs, id);
    if (sc > foeScoreMax) foeScoreMax = sc;
  }
  const minute0 = gs.t / 60;
  const outmatched = minute0 > 6 && foeScoreMax > myScore0 * 1.55;
  const escalate = colossusThreat || outmatched
    || (aliveAIs.length === 1 && aliveAIs[0] === teamId && aliveTeams.length >= 2);
  if (escalate) team.credits += 26;   // mobilisation générale : toute l'industrie tourne pour la guerre

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
    // les flottes en patrouille sont RÉAFFECTÉES à la défense du cœur
    for (const pf of gs.fleets) {
      if (pf.team === teamId && pf.mission.kind.startsWith('patrol')) {
        setFleetMission(gs, pf, { kind: 'attack', targetId: baseThreat.id });
      }
    }
    // appelle ses alliés à la rescousse (dont le joueur)
    if (gs.rng() < 0.3) {
      for (const ally of gs.activeTeams) {
        if (ally !== teamId && gs.teams[ally].alive && areAllied(gs, teamId, ally)) {
          requestDefend(gs, teamId, ally);
          break;
        }
      }
    }
  }

  // ---------- 1bis. PROJET COLOSSE : des labos dans les nuages, puis l'usine ----------
  // Les labos démarrent vers 12 min ; l'usine (donc le Colosse) reste un objectif d'après 20 min.
  // RÈGLE D'OR : l'armée d'abord — le projet (et son épargne) se met en pause tant que
  // la défense n'est pas correcte, sinon l'IA se fait raser en économisant pour son rêve.
  const myLabs = gs.structures.filter(x => x.alive && x.team === teamId && x.stype === 'labo').length;
  const armyOK = warships.length >= Math.min(7, 3 + Math.floor(minute / 8));
  const wantColossus = !team.colossusUsed && minute > 12
    && (escalate || persona.aggression > 0.4 || minute > 25);
  const savingColossus = wantColossus && armyOK && myLabs < COLOSSE_LABS_REQUIRED;
  const savingUsine = wantColossus && armyOK && myLabs >= COLOSSE_LABS_REQUIRED && minute > 18;
  if (wantColossus && armyOK) {
    if (myLabs < COLOSSE_LABS_REQUIRED && team.credits > STRUCTS.labo.prix + 100) {
      // essaie tous les nuages : les rivaux snipent les labos, il faut être tenace
      outer: for (const storm of gs.storms) {
        if (!storm.alive) continue;
        for (let tries = 0; tries < 8; tries++) {
          const pos = add(storm.pos, fromAngle(gs.rng() * Math.PI * 2, gs.rng() * storm.radius * 0.7));
          if (!canPlaceStructure(gs, teamId, 'labo', pos)) { placeStructure(gs, teamId, 'labo', pos); break outer; }
        }
      }
    } else if (myLabs >= COLOSSE_LABS_REQUIRED && minute > 20 && team.credits > STRUCTS.usine.prix + 50) {
      for (let tries = 0; tries < 6; tries++) {
        const pos = add(station.pos, fromAngle(gs.rng() * Math.PI * 2, 150 + gs.rng() * 200));
        if (!canPlaceStructure(gs, teamId, 'usine', pos)) { placeStructure(gs, teamId, 'usine', pos); break; }
      }
    }
  }

  // ---------- 2. ÉCONOMIE : effectifs voulus ----------
  // objectif : TOUJOURS grandir. Les mineurs lancent la machine (3-6, les ressources
  // s'épuisent) ; ensuite les CARGOS et les revenus passifs prennent le relais, sans plafond bas
  const wantMiners = Math.round(2 + persona.ecoFocus * 2 + Math.min(2, minute / 8));
  const wantCargos = myPlanets.length > 0
    ? Math.min(24, Math.round(myPlanets.length * (1 + persona.ecoFocus) + minute / 5))
    : 0;
  const wantTransporters = neutralPlanets.length > 0 && minute > 1.5 ? 1 : 0;
  // effectifs militaires : une VRAIE armée, calée sur la plus grosse armée adverse —
  // un joueur qui débarque avec 20 chasseurs et 4 bombardiers ne doit surprendre personne
  let enemyMaxWar = 0;
  for (const id of gs.activeTeams) {
    if (id === teamId || !gs.teams[id].alive || areAllied(gs, teamId, id)) continue;
    const n = gs.ships.filter(s2 => s2.alive && s2.team === id && SHIP_CLASSES[s2.cls].power > 5).length;
    if (n > enemyMaxWar) enemyMaxWar = n;
  }
  const wantWarships = Math.max(2, Math.min(escalate ? 26 : 20, Math.max(
    Math.round((2 + persona.aggression * 3 + minute / 2.2) * tune.warshipMult) + (escalate ? 4 : 0),
    Math.round((enemyMaxWar + 2) * Math.min(1, tune.warshipMult + 0.25)),
  )));

  // réserve d'argent selon la personnalité (+ budget gelé pour une colonisation en cours,
  // + épargne pour le projet Colosse — uniquement quand l'armée tient debout)
  const colonizeReserve = transporters.some(t => t.order.kind === 'colonize') ? COLONIZE_COST : 0;
  const reserve = (escalate ? 60 : 150 + persona.defense * 250) + colonizeReserve
    + (savingColossus ? 380 : 0) + (savingUsine ? 1500 : 0);
  let purchases = 0;
  const canBuy = (price: number) => team.credits - price > reserve && purchases < (escalate ? 4 : 3);

  if (miners.length < wantMiners && canBuy(SHIP_CLASSES.mineur.prix)) {
    if (!tryBuyShip(gs, teamId, 'mineur', false)) purchases++;
  }
  // l'expansion ignore l'épargne Colosse : une planète libre, ça ne se refuse pas
  if (transporters.length < wantTransporters && purchases < 3
    && team.credits - (SHIP_CLASSES.transporteur.prix + COLONIZE_COST) > 150 + colonizeReserve) {
    if (!tryBuyShip(gs, teamId, 'transporteur', false)) purchases++;
  }
  if (cargos.length < wantCargos) {
    // la flotte marchande grossit vite quand le réseau commercial est en retard
    const rounds = wantCargos - cargos.length > 4 ? 2 : 1;
    for (let k = 0; k < rounds; k++) {
      if (canBuy(SHIP_CLASSES.cargo.prix) && !tryBuyShip(gs, teamId, 'cargo', false)) purchases++;
    }
  }
  if (warships.length < wantWarships) {
    // gros déficit (l'ennemi a levé une armée) : jusqu'à 2 recrutements par réflexion
    const rounds = wantWarships - warships.length > 5 ? 2 : 1;
    for (let k = 0; k < rounds; k++) {
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
  }

  // ---------- 2bis. CROISSANCE PERPÉTUELLE : le surplus s'investit — avec des plafonds ----------
  // Un tas d'or qui dort ne gagne pas de guerre : cargo de plus, bureau, mine, dépôt,
  // ou un laboratoire à revenus dans un nuage. Les plafonds évitent l'emballement
  // bureau → revenus → bureau à l'infini (constaté en sonde : 100 bureaux…).
  if (team.credits > 2600 && !savingUsine) {
    const count = (st2: 'bureau' | 'mine' | 'depot' | 'labo') =>
      gs.structures.filter(x => x.alive && x.team === teamId && x.stype === st2).length;
    const roll = gs.rng();
    if (roll < 0.45 && myPlanets.length > 0 && cargos.length < wantCargos) {
      tryBuyShip(gs, teamId, 'cargo', false);
    } else if (roll < 0.8) {
      const stype2: 'bureau' | 'mine' | 'depot' = roll < 0.62 ? 'bureau' : roll < 0.72 ? 'mine' : 'depot';
      const cap = stype2 === 'bureau' ? 6 : stype2 === 'mine' ? 6 : 3;
      if (count(stype2) < cap) {
        for (let tries = 0; tries < 6; tries++) {
          const pos = add(station.pos, fromAngle(gs.rng() * Math.PI * 2, 110 + gs.rng() * 240));
          if (!canPlaceStructure(gs, teamId, stype2, pos)) { placeStructure(gs, teamId, stype2, pos); break; }
        }
      }
    } else if (count('labo') < 8) {
      const storm = gs.storms.find(sc => sc.alive);
      if (storm) {
        for (let tries = 0; tries < 6; tries++) {
          const pos = add(storm.pos, fromAngle(gs.rng() * Math.PI * 2, gs.rng() * storm.radius * 0.7));
          if (!canPlaceStructure(gs, teamId, 'labo', pos)) { placeStructure(gs, teamId, 'labo', pos); break; }
        }
      }
    }
  }

  // ---------- 3. AMÉLIORATION DE STATION ----------
  if (station.level < 3 && (escalate || minute > station.level * 3.5)) {
    const price = STATION_UPGRADE_PRICE[station.level];
    if (team.credits - price > reserve * 0.5) tryUpgradeStation(gs, teamId);
  }
  // défenses de station : un survivant aux abois blinde sa base, les autres s'y mettent
  // sur le tard — sans engloutir l'économie (le projet Colosse passe avant)
  if ((escalate && team.credits > 900 && gs.rng() < 0.4)
    || (minute > 12 && team.credits > 2400 && gs.rng() < 0.08)) {
    const u = STATION_UPGRADES[Math.floor(gs.rng() * STATION_UPGRADES.length)];
    tryBuyStationUpgrade(gs, teamId, u.id);
  }

  // ---------- 4. CONSTRUCTION (cadence selon la difficulté, avant-postes plafonnés) ----------
  if (team.credits > 900 && gs.rng() < 0.25 * tune.buildMult) {
    const myOutposts = gs.structures.filter(x => x.alive && x.team === teamId && x.stype === 'avantposte').length;
    const outpostCap = 1 + Math.floor(minute / 7) + (persona.defense > 0.6 ? 1 : 0);
    let stype: 'mine' | 'avantposte' | 'satellite' | 'bureau' =
      gs.rng() < 0.4 ? 'mine' : gs.rng() < 0.65 ? 'avantposte' : gs.rng() < 0.8 ? 'bureau' : 'satellite';
    if (stype === 'avantposte' && myOutposts >= outpostCap) stype = 'bureau';
    const myBureaux = gs.structures.filter(x => x.alive && x.team === teamId && x.stype === 'bureau').length;
    if (stype === 'bureau' && myBureaux >= 6) stype = 'mine';
    for (let tries = 0; tries < 6; tries++) {
      const pos = add(station.pos, fromAngle(gs.rng() * Math.PI * 2, 120 + gs.rng() * 260));
      if (!canPlaceStructure(gs, teamId, stype, pos)) { placeStructure(gs, teamId, stype, pos); break; }
    }
  }

  // ---------- 4ter. DÉFENSE DU CŒUR : jamais de station nue ----------
  const myOutpostList = gs.structures.filter(x => x.alive && x.team === teamId && x.stype === 'avantposte');
  // premier avant-poste garanti dès la 6e minute (sans lui, 20 chasseurs rasent tout)
  if (myOutpostList.length === 0 && minute > 6 && team.credits > STRUCTS.avantposte.prix + 150) {
    for (let tries = 0; tries < 8; tries++) {
      const pos = add(station.pos, fromAngle(gs.rng() * Math.PI * 2, 100 + gs.rng() * 160));
      if (!canPlaceStructure(gs, teamId, 'avantposte', pos)) { placeStructure(gs, teamId, 'avantposte', pos); break; }
    }
  }
  // avant-postes améliorés (défensifs et survivants d'abord)
  if ((escalate || persona.defense > 0.5 || minute > 20) && team.credits > 1100 && gs.rng() < 0.1) {
    const target = myOutpostList.find(o => o.level < OUTPOST_MAX_LEVEL);
    if (target) tryUpgradeOutpost(gs, teamId, target.id);
  }
  // gardes orbitales autour du cœur en fin de partie
  if ((escalate || persona.defense > 0.6 || minute > 22)
    && team.credits > (GUARD_COST[station.level] ?? 500) + 600 && gs.rng() < 0.08) {
    buyGuards(gs, teamId, station.id);
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
  // les alliances ne sont pas éternelles : l'IA rompt quand ça l'arrange —
  // plus d'ennemi commun (le pacte n'a plus de sens), ou un allié devenu trop dangereux
  if (myAllies.length > 0 && gs.rng() < 0.025) {
    const partner = myAllies[0];
    const commonFoe = gs.activeTeams.some(id => gs.teams[id].alive && id !== teamId && id !== partner
      && !areAllied(gs, teamId, id));
    const pScore = teamScore(gs, partner), myScore = teamScore(gs, teamId);
    if (!commonFoe || (pScore > myScore * 1.45 && gs.rng() < 0.25 + persona.aggression * 0.4)) {
      breakAlliance(gs, teamId, partner);
      // la trahison s'annonce en transmission radio, pas en petit caractère
      if (partner === gs.playerTeam) {
        setAlert(gs, `${team.name.toUpperCase()} ROMPT VOTRE ALLIANCE`, 5.5, '#ff8c42');
      }
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
  const aggression = Math.min(1, Math.max(escalate ? 0.8 : 0, (persona.aggression + lateGame) * tune.aggroMult));
  const readyForWar = warships.length >= Math.max(2, wantWarships * 0.7);

  // flottes d'attaque existantes : retarder si la cible est morte
  const attackFleets = gs.fleets.filter(f => f.team === teamId && f.mission.kind === 'attack' && fleetShips(gs, f).length >= 2);
  for (const f of attackFleets) {
    const valid = shipById(gs, f.mission.targetId ?? -1)
      ?? structById(gs, f.mission.targetId ?? -1)
      ?? gs.planets.find(p => p.id === f.mission.targetId && p.alive && p.owner >= 0);
    if (!valid) {
      const target = pickAttackTarget(gs, teamId, persona.raid, minute, escalate);
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

  const maxAttackFleets = (minute > 14 || escalate) ? 2 : 1;
  if (attackFleets.length < maxAttackFleets && readyForWar && gs.rng() < aggression * 0.35 + 0.05) {
    const target = pickAttackTarget(gs, teamId, persona.raid, minute, escalate);
    if (target != null) {
      const attackers = idleWar.length >= 2 ? idleWar : warships.filter(w => w.fleetId == null);
      const grp = attackers.slice(0, Math.max(2, Math.ceil(attackers.length * (0.5 + aggression * 0.5))));
      if (grp.length >= 2) {
        const fleet = createFleet(gs, teamId, grp.map(s => s.id), gs.rng() < 0.5 ? 'coin' : 'cercle');
        if (fleet) setFleetMission(gs, fleet, { kind: 'attack', targetId: target });
      } else {
        // pas assez de vaisseaux libres : une flotte de patrouille est réaffectée à l'assaut
        const pf = gs.fleets.find(f2 => f2.team === teamId && f2.mission.kind.startsWith('patrol')
          && fleetShips(gs, f2).length >= 2);
        if (pf) setFleetMission(gs, pf, { kind: 'attack', targetId: target });
        else if (grp.length === 1) grp[0].order = { kind: 'attack', targetId: target };
      }
    }
  }

  // ---------- 6bis. FLOTTES DE PATROUILLE ----------
  // une IA qui sait jouer fait ronde chez elle : 2-3 vaisseaux couvrent le territoire
  // (bordure ou escorte des civils, au goût de la personnalité)
  const patrolFleets = gs.fleets.filter(f2 => f2.team === teamId
    && ['patrol_border', 'patrol_in', 'patrol_civil'].includes(f2.mission.kind));
  if (patrolFleets.length === 0 && warships.length >= 5 && gs.rng() < 0.3) {
    const idleNow = warships.filter(w => (w.order.kind === 'idle' || w.order.kind === 'guard') && w.fleetId == null);
    if (idleNow.length >= 2) {
      const grp = idleNow.slice(0, Math.min(3, idleNow.length));
      const fleet = createFleet(gs, teamId, grp.map(s2 => s2.id), 'coin');
      if (fleet) {
        const kind = persona.raid > 0.5 ? 'patrol_civil' : persona.defense > 0.5 ? 'patrol_in' : 'patrol_border';
        setFleetMission(gs, fleet, { kind });
      }
    }
  }

  // ---------- 7. AMIRAL ----------
  // Un Colosse IA ne patrouille pas : il marche sur l'ennemi et vide ses armes.
  if (flagship && flagship.cls === 'colosse') {
    if (flagship.order.kind === 'idle' || flagship.order.kind === 'guard') {
      const foeSt = nearestStruct(gs, flagship.pos, x => isEnemy(teamId, x.team) && x.stype === 'station', Infinity);
      if (foeSt) flagship.order = { kind: 'attack', targetId: foeSt.id };
    }
    // salve de l'Apocalypse dès que 3 cibles se présentent (validation par la sim)
    const inRange = gs.ships.filter(x => x.alive && isEnemy(teamId, x.team) && x.cloakT <= 0
      && dist(x.pos, flagship.pos) < WEAPONS.salve.range);
    if (inRange.length >= 3) salveFireCmd(gs, teamId, inRange.slice(0, 8).map(x => x.id));
    // Brise-Monde sur toute colonie ennemie à portée
    const prey = gs.planets.find(pl => pl.alive && pl.dyingT === 0 && pl.owner >= 0
      && isEnemy(teamId, pl.owner) && dist(pl.pos, flagship.pos) < WEAPONS.brise_monde.range);
    if (prey) colossusWorldBreaker(gs, flagship, prey.pos);
  } else if (flagship && (flagship.order.kind === 'idle')) {
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

/** Le joueur a-t-il de quoi encaisser ? (armée embryonnaire = pas encore prêt) */
function playerNotReady(gs: GameState): boolean {
  const t = gs.teams[gs.playerTeam];
  if (!t?.alive || t.isAI) return false;
  const war = gs.ships.filter(s => s.alive && s.team === gs.playerTeam && SHIP_CLASSES[s.cls].power > 5).length;
  return war < 4;
}

/** Choisit une cible d'attaque : civils (raid), colonies/structures (harcèlement), stations (fin de partie). */
function pickAttackTarget(gs: GameState, teamId: number, raidPref: number, minute: number, ignoreGrace = false): number | null {
  const tune = effectiveTune(gs);
  // PRIORITÉ ABSOLUE : un chantier de Colosse ennemi doit tomber (ignore toute grâce)
  const usine = gs.structures.find(st => st.alive && st.stype === 'usine' && st.buildT > 0
    && isEnemy(teamId, st.team));
  if (usine) return usine.id;
  // des laboratoires qui s'accumulent = un Colosse en préparation : on frappe la recherche
  const labsByTeam = new Map<number, number[]>();
  for (const st of gs.structures) {
    if (!st.alive || st.stype !== 'labo' || !isEnemy(teamId, st.team)) continue;
    const arr = labsByTeam.get(st.team) ?? [];
    arr.push(st.id);
    labsByTeam.set(st.team, arr);
  }
  let dangerLab: number | null = null, dangerCount = 0;
  for (const ids of labsByTeam.values()) {
    if (ids.length > dangerCount) { dangerCount = ids.length; dangerLab = ids[0]; }
  }
  // (probabiliste : la pression est réelle mais un bâtisseur tenace garde une chance)
  if (dangerLab != null && dangerCount >= COLOSSE_LABS_REQUIRED - 1 && gs.rng() < 0.6) return dangerLab;
  if (dangerLab != null && dangerCount >= 2 && minute >= tune.harassMin && gs.rng() < 0.25) return dangerLab;
  if (minute < tune.harassMin) return null;
  // période de grâce : l'IA laisse le joueur s'installer avant de le viser —
  // en FACILE, la grâce se prolonge tant que le joueur n'a pas d'armée digne de ce nom
  const easyMercy = gs.cfg.difficulty === 'facile' && minute < 16 && playerNotReady(gs);
  const enemies = gs.activeTeams.filter(id => id !== teamId && gs.teams[id].alive && !areAllied(gs, teamId, id)
    && !(id === gs.playerTeam && !gs.teams[id].isAI && !ignoreGrace && (minute < tune.playerGraceMin || easyMercy)));
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
