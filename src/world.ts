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
import { resetFleetCounter, createFleet, setFleetMission } from './orders';

function pickStar(rngv: () => number, choice: StarType | 'aleatoire'): StarType {
  if (choice !== 'aleatoire') return choice;
  const total = STAR_LIST.reduce((a, s) => a + STARS[s].weight, 0);
  let r = rngv() * total;
  for (const s of STAR_LIST) { r -= STARS[s].weight; if (r <= 0) return s; }
  return 'sol_jaune';
}

function makeMap(rng: () => number, starType: StarType, teamCount: number): MapInfo {
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
  // la carte grandit avec le monde : 4 équipes = rayon de base, 6 = +32 %, 9 = +80 %
  const worldR = Math.round(WORLD_R * (1 + Math.max(0, teamCount - 4) * 0.16));
  return {
    starType, starName: def.nom, bodies, worldR,
    killRadius: def.killRadius,
    supernovaAt: def.supernovaDelay > 0 ? def.supernovaDelay : -1,
    neutronPeriod: def.neutronPeriod,
    blackHole: def.blackHole,
    energyBonus: def.energyBonus,
  };
}

const mkPlan = () => ({ filter: 'tout' as const, objective: null, armed: false });

export function newGame(cfg: MatchConfig): GameState {
  resetFleetCounter();
  const rng = makeRng(cfg.seed);
  const starType = pickStar(rng, cfg.starChoice);
  // nombre TOTAL d'équipes : humains + IA de remplissage (teamCount prioritaire,
  // sinon héritage aiCount pour les anciennes configs et les tests)
  const humans0 = cfg.humanTeams && cfg.humanTeams.length > 0 ? cfg.humanTeams : [cfg.playerColorIdx];
  const teamCount = Math.max(2, Math.min(TEAM_DEFS.length,
    cfg.teamCount ?? (humans0.length + cfg.aiCount)));
  const map = makeMap(rng, starType, teamCount);
  const wr = map.worldR;

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
    alliances: new Set(), allianceSince: {}, diploOffers: [], focusTargets: {}, offerMuted: {},
    storms: [], stormT: 480 + rng() * 120,
    meteors: [], meteorT: 480,
    colossusBeams: [],
    plans: {},
    log: [], alertText: '', alertT: 0, alertColor: '#ff4b4b',
  };

  // ---------- Équipes (solo : joueur + IA ; multi : humains + IA de remplissage) ----------
  const humans = humans0;
  gs.playerTeam = humans[0];
  const aiTeamIdx: number[] = [];
  for (let i = 0; i < TEAM_DEFS.length && humans.length + aiTeamIdx.length < teamCount; i++) {
    if (!humans.includes(i)) aiTeamIdx.push(i);
  }
  const active = [...humans, ...aiTeamIdx];
  gs.activeTeams = active;

  for (let i = 0; i < TEAM_DEFS.length; i++) {
    const def = TEAM_DEFS[i];
    const isActive = active.includes(i);
    const persona: PersonaId = cfg.personaChoice === 'aleatoire' ? pick(rng, PERSONA_LIST) : cfg.personaChoice;
    const team: TeamState = {
      id: i, name: def.name, color: def.color, cssColor: def.cssColor,
      credits: START_CREDITS,
      isAI: !humans.includes(i),
      persona, alive: isActive, stationId: -1,
      upgrades: {}, gadgets: ['fumee'], gadgetCd: {},
      secondaries: [], aiCd: 2 + rng() * 3, respawnT: 0, garrisonT: 30, score: 0, kills: 0, colossusUsed: false,
    };
    gs.teams.push(team);
    gs.plans[i] = mkPlan();
  }

  // ---------- Bases (réparties uniformément sur un cercle) ----------
  const baseR = wr * 0.72;
  // décale d'un offset aléatoire pour varier
  const angleOffset = rr(rng, 0, Math.PI * 2);
  active.forEach((teamId, idx) => {
    const a = (idx / active.length) * Math.PI * 2 + angleOffset;
    const pos = fromAngle(a, baseR);
    const station = makeStructure(gs, teamId, 'station', pos);
    gs.teams[teamId].stationId = station.id;
    // Amiral (vaisseau de départ)
    const spawn = fromAngle(a, baseR - 60);
    const flag = makeShip(gs, teamId, 'corvette', spawn, a + Math.PI);
    flag.isFlagship = true;
    applyUpgrades(gs, flag);
    if (teamId === gs.playerTeam) gs.playerShipId = flag.id;
    // Un mineur de départ — qui se met au travail TOUT SEUL (minage auto + épaves)
    const miner = makeShip(gs, teamId, 'mineur', fromAngle(a + 0.06, baseR - 40), a + Math.PI);
    if (humans.includes(teamId)) {
      const mf = createFleet(gs, teamId, [miner.id]);
      if (mf) setFleetMission(gs, mf, { kind: 'mine_auto' });
    }
  });

  // ---------- Planètes (davantage sur les grandes cartes) ----------
  const extra = Math.max(0, active.length - 4);
  const planetCount = ri(rng, 7, 10) + Math.round(extra * 1.3);
  const names = [...PLANET_NAMES];
  for (let i = 0; i < planetCount; i++) {
    let pos = v2(), ok = false;
    for (let tries = 0; tries < 40 && !ok; tries++) {
      pos = fromAngle(rr(rng, 0, Math.PI * 2), rr(rng, map.killRadius + 220, wr * 0.92));
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
  const beltCount = ri(rng, 5, 7) + extra;
  for (let b = 0; b < beltCount; b++) {
    const center = fromAngle(rr(rng, 0, Math.PI * 2), rr(rng, map.killRadius + 260, wr * 0.88));
    const n = ri(rng, 6, 12);
    const rich = rng() < 0.4; // ceinture riche en minerai
    for (let i = 0; i < n; i++) {
      const p = { x: center.x + rr(rng, -90, 90), y: center.y + rr(rng, -90, 90) };
      const rtype = (rich ? rng() < 0.6 : rng() < 0.2) ? 'minerai' as const : 'roche' as const;
      makeRoid(gs, rtype, p, rr(rng, 5, 13), ri(rng, 60, 160));
    }
  }

  // ---------- Nuages de gaz ----------
  const cloudCount = ri(rng, 4, 6) + Math.ceil(extra * 0.7);
  for (let i = 0; i < cloudCount; i++) {
    const pos = fromAngle(rr(rng, 0, Math.PI * 2), rr(rng, map.killRadius + 300, wr * 0.85));
    makeCloud(gs, pos, rr(rng, 40, 70), ri(rng, 150, 300));
  }

  // ---------- ÉQUITÉ : chaque base a son kit de départ ----------
  // Le hasard fait la carte, mais personne ne démarre le ventre vide : autour de
  // chaque station, on garantit un minimum d'astéroïdes, un nuage de gaz et une
  // planète à portée raisonnable — les surplus, eux, restent au petit bonheur.
  for (const teamId of active) {
    const st = gs.structures.find(s => s.id === gs.teams[teamId].stationId)!;
    const toward = (d: number, jitter: number) => {
      // point entre la base et le centre (jamais côté bordure, jamais dans l'étoile)
      const dir = Math.atan2(-st.pos.y, -st.pos.x) + rr(rng, -0.7, 0.7);
      const p = { x: st.pos.x + Math.cos(dir) * d + rr(rng, -jitter, jitter), y: st.pos.y + Math.sin(dir) * d + rr(rng, -jitter, jitter) };
      const dc = Math.hypot(p.x, p.y);
      if (dc < map.killRadius + 200) { const f = (map.killRadius + 200) / dc; p.x *= f; p.y *= f; }
      return p;
    };
    // minerai/roche : au moins ~450 unités dans un rayon de 480
    const nearAmount = gs.roids.filter(r => dist(r.pos, st.pos) < 480).reduce((a, r) => a + r.amount, 0);
    if (nearAmount < 450) {
      const center = toward(rr(rng, 240, 340), 40);
      const n = ri(rng, 6, 9);
      for (let i = 0; i < n; i++) {
        const p = { x: center.x + rr(rng, -80, 80), y: center.y + rr(rng, -80, 80) };
        makeRoid(gs, rng() < 0.35 ? 'minerai' : 'roche', p, rr(rng, 5, 12), ri(rng, 70, 150));
      }
    }
    // un nuage de gaz à portée
    if (!gs.clouds.some(c => dist(c.pos, st.pos) < 560)) {
      makeCloud(gs, toward(rr(rng, 320, 440), 60), rr(rng, 40, 60), ri(rng, 150, 260));
    }
    // une planète colonisable dans le voisinage
    if (!gs.planets.some(p => dist(p.pos, st.pos) < 600)) {
      let pos = toward(rr(rng, 360, 520), 70);
      for (let tries = 0; tries < 20; tries++) {
        if (gs.planets.every(p => dist(p.pos, pos) > 200) && gs.structures.every(s => dist(s.pos, pos) > 240)) break;
        pos = toward(rr(rng, 360, 520), 70);
      }
      const name = names.splice(ri(rng, 0, Math.max(0, names.length - 1)), 1)[0] ?? 'Frontière';
      makePlanet(gs, pick(rng, PLANET_TYPE_LIST), name, pos, rr(rng, 22, 34));
    }
  }

  addLog(gs, `Système « ${map.starName} » généré.`, '#40c4ff');
  if (map.supernovaAt > 0) addLog(gs, '⚠ La supergéante est instable : SUPERNOVA IMMINENTE.', '#ff4b4b');
  if (map.blackHole) addLog(gs, '⚠ Trou noir au centre : restez à distance.', '#ff8c42');
  if (map.neutronPeriod > 0) addLog(gs, '⚠ Impulsions EMP périodiques détectées.', '#7adfff');
  if (map.starType === 'sol_violet') addLog(gs, '✦ Radiations violettes : énergie +50 %.', '#b06bff');

  return gs;
}
