// ============ COBALT SECTOR — génération de partie & de carte ============
import {
  GameState, MatchConfig, MapInfo, StarBody, TeamState, makeRng, rr, ri, pick,
  v2, fromAngle, WORLD_R, NO_TEAM, PIRATE_TEAM, StarType, PersonaId, addLog, dist,
} from './core';
import {
  TEAM_DEFS, STARS, STAR_LIST, PERSONA_LIST, PLANET_TYPE_LIST, PLANET_NAMES,
  START_CREDITS, SHIP_CLASSES,
} from './data';
import { makeShip, makeStructure, makePlanet, makeRoid, makeCloud, applyUpgrades } from './entities';
import { resetFleetCounter } from './orders';

function pickStar(rngv: () => number, choice: StarType | 'aleatoire'): StarType {
  if (choice !== 'aleatoire') return choice;
  const total = STAR_LIST.reduce((a, s) => a + STARS[s].weight, 0);
  let r = rngv() * total;
  for (const s of STAR_LIST) { r -= STARS[s].weight; if (r <= 0) return s; }
  return 'sol_jaune';
}

function makeMap(rng: () => number, starType: StarType): MapInfo {
  const def = STARS[starType];
  const bodies: StarBody[] = [];
  for (let i = 0; i < def.bodies; i++) {
    const orbitR = def.bodies === 1 ? 0 : def.bodies === 2 ? 110 : 150;
    bodies.push({
      pos: v2(), radius: def.radius * (i === 0 ? 1 : 0.75),
      color: i === 0 ? def.color : (i === 1 ? 0xff8c42 : 0x7ab8ff),
      orbitR, orbitSpeed: 0.15 + i * 0.05, phase: (i / def.bodies) * Math.PI * 2,
    });
  }
  return {
    starType, starName: def.nom, bodies,
    killRadius: def.killRadius,
    supernovaAt: def.supernovaDelay > 0 ? def.supernovaDelay : -1,
    neutronPeriod: def.neutronPeriod,
    blackHole: def.blackHole,
    energyBonus: def.energyBonus,
  };
}

export function newGame(cfg: MatchConfig): GameState {
  resetFleetCounter();
  const rng = makeRng(cfg.seed);
  const starType = pickStar(rng, cfg.starChoice);
  const map = makeMap(rng, starType);

  const gs: GameState = {
    t: 0, seed: cfg.seed, rng, cfg, map, nextId: 1,
    teams: [], activeTeams: [],
    ships: [], structures: [], planets: [], roids: [], clouds: [], wrecks: [],
    projectiles: [], minesArmed: [], smokes: [], fleets: [], fx: [],
    playerTeam: cfg.playerColorIdx, playerShipId: -1, selection: [],
    status: 'playing', winner: -1, overReason: '',
    neutronT: map.neutronPeriod > 0 ? map.neutronPeriod : -1,
    pirateT: 100,
    supernovaWave: -1,
    alliances: new Set(), allianceSince: {}, diploOffers: [], focusTargets: {},
    storms: [], stormT: 480 + rng() * 120,
    meteors: [], meteorT: 480,
    colossusBeams: [],
    plan: { filter: 'tout', objective: null, armed: false },
    log: [], alertText: '', alertT: 0, alertColor: '#ff4b4b',
  };

  // ---------- Équipes ----------
  const aiTeamIdx: number[] = [];
  for (let i = 0; i < 4 && aiTeamIdx.length < cfg.aiCount; i++) {
    if (i !== cfg.playerColorIdx) aiTeamIdx.push(i);
  }
  const active = [cfg.playerColorIdx, ...aiTeamIdx];
  gs.activeTeams = active;

  for (let i = 0; i < 4; i++) {
    const def = TEAM_DEFS[i];
    const isActive = active.includes(i);
    const persona: PersonaId = cfg.personaChoice === 'aleatoire' ? pick(rng, PERSONA_LIST) : cfg.personaChoice;
    const team: TeamState = {
      id: i, name: def.name, color: def.color, cssColor: def.cssColor,
      credits: START_CREDITS,
      isAI: i !== cfg.playerColorIdx,
      persona, alive: isActive, stationId: -1,
      upgrades: {}, gadgets: ['fumee'], gadgetCd: {},
      secondaries: [], aiCd: 2 + rng() * 3, respawnT: 0, score: 0, kills: 0, colossusUsed: false,
    };
    gs.teams.push(team);
  }

  // ---------- Bases (réparties sur un cercle) ----------
  const baseR = WORLD_R * 0.72;
  const baseAngles = [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75];
  // décale d'un offset aléatoire pour varier
  const angleOffset = rr(rng, 0, Math.PI * 2);
  active.forEach((teamId, idx) => {
    const a = baseAngles[idx % 4] + angleOffset;
    const pos = fromAngle(a, baseR);
    const station = makeStructure(gs, teamId, 'station', pos);
    gs.teams[teamId].stationId = station.id;
    // Amiral (vaisseau de départ)
    const spawn = fromAngle(a, baseR - 60);
    const flag = makeShip(gs, teamId, 'corvette', spawn, a + Math.PI);
    flag.isFlagship = true;
    applyUpgrades(gs, flag);
    if (teamId === gs.playerTeam) gs.playerShipId = flag.id;
    // Un mineur de départ
    makeShip(gs, teamId, 'mineur', fromAngle(a + 0.06, baseR - 40), a + Math.PI);
  });

  // ---------- Planètes ----------
  const planetCount = ri(rng, 6, 9);
  const names = [...PLANET_NAMES];
  for (let i = 0; i < planetCount; i++) {
    let pos = v2(), ok = false;
    for (let tries = 0; tries < 40 && !ok; tries++) {
      pos = fromAngle(rr(rng, 0, Math.PI * 2), rr(rng, map.killRadius + 220, WORLD_R * 0.92));
      ok = gs.planets.every(p => dist(p.pos, pos) > 220)
        && gs.structures.every(s => dist(s.pos, pos) > 260);
    }
    if (!ok) continue;
    const ptype = pick(rng, PLANET_TYPE_LIST);
    const nameIdx = ri(rng, 0, names.length - 1);
    const name = names.splice(nameIdx, 1)[0] ?? `Planète ${i + 1}`;
    makePlanet(gs, ptype, name, pos, rr(rng, 22, 38));
  }

  // ---------- Ceintures d'astéroïdes ----------
  const beltCount = ri(rng, 4, 6);
  for (let b = 0; b < beltCount; b++) {
    const center = fromAngle(rr(rng, 0, Math.PI * 2), rr(rng, map.killRadius + 260, WORLD_R * 0.88));
    const n = ri(rng, 6, 12);
    const rich = rng() < 0.4; // ceinture riche en minerai
    for (let i = 0; i < n; i++) {
      const p = { x: center.x + rr(rng, -90, 90), y: center.y + rr(rng, -90, 90) };
      const rtype = (rich ? rng() < 0.6 : rng() < 0.2) ? 'minerai' as const : 'roche' as const;
      makeRoid(gs, rtype, p, rr(rng, 5, 13), ri(rng, 60, 160));
    }
  }

  // ---------- Nuages de gaz ----------
  const cloudCount = ri(rng, 3, 5);
  for (let i = 0; i < cloudCount; i++) {
    const pos = fromAngle(rr(rng, 0, Math.PI * 2), rr(rng, map.killRadius + 300, WORLD_R * 0.85));
    makeCloud(gs, pos, rr(rng, 40, 70), ri(rng, 150, 300));
  }

  addLog(gs, `Système « ${map.starName} » généré.`, '#40c4ff');
  if (map.supernovaAt > 0) addLog(gs, '⚠ La supergéante est instable : SUPERNOVA IMMINENTE.', '#ff4b4b');
  if (map.blackHole) addLog(gs, '⚠ Trou noir au centre : restez à distance.', '#ff8c42');
  if (map.neutronPeriod > 0) addLog(gs, '⚠ Impulsions EMP périodiques détectées.', '#7adfff');
  if (map.starType === 'sol_violet') addLog(gs, '✦ Radiations violettes : énergie +50 %.', '#b06bff');

  return gs;
}
