// ============ COBALT SECTOR — simulation (physique, combat, économie, événements) ============
import {
  GameState, Ship, Structure, Planet, StormCloud, Meteor, Stance, PlanFilter, V2, v2, add, sub, scale, len, dist, norm, angleOf,
  fromAngle, clamp, turnToward, IDLE, PIRATE_TEAM, NO_TEAM, WORLD_R, addLog, setAlert,
  shipById, structById, planetById, GadgetId, MineType, WeaponId, ShipClassId, StructType, Res,
  areAllied, allyKey,
} from './core';
import {
  WEAPONS, SHIP_CLASSES, STRUCTS, MINES, GADGETS, RES_PRICE, KILL_BOUNTY, WRECK_VALUE,
  PLANET_INCOME, PLANET_INCOME_PERIOD, MINE_INCOME, MINE_INCOME_PERIOD,
  PASSIVE_INCOME, PASSIVE_INCOME_PERIOD, COLONIZE_COST, COLONIZE_TIME, TRADE_PROFIT,
  HULL_REGEN_DELAY, HULL_REGEN_RATE, SHIELD_RECHARGE_RATE, ENERGY_REGEN,
  SALVAGE_RANGE, DOCK_RANGE, MINING_RANGE, MINING_RATE, DIFF_MULT, MINE_RESTOCK_PRICE,
  UPGRADES, STATION_UPGRADE_PRICE, PIRATE_RAID_PERIOD,
  LABO_INCOME, LABO_INCOME_PERIOD, GUARD_COST, GUARD_COMP,
  DEPOT_RATE, DEPOT_CAP, DEPOT_ALLY_BONUS, ALLY_TRADE_MULT, ALLIANCE_DURATION, PLANET_UPGRADE_COST, PLANET_UPGRADE_HP, DIFF_TUNING,
  COLOSSE_LABS_REQUIRED, COLOSSE_BUILD_TIME, COLOSSE_RAY_COUNT, COLOSSE_RAY_RANGE, COLOSSE_SALVO_SIZE,
} from './data';
import {
  makeRoid, makeCloud,
  makeShip, makeStructure, makeWreck, makeProjectile, makeMineEnt, applyUpgrades, speedMult,
  isEnemy, nearestShip, nearestStruct, nearestRoid, nearestCloud, canDetect, cargoTotal, addCargo,
  setAllianceCheck,
} from './entities';
import { removeFromFleet, formationWorldPos, fleetShips } from './orders';
import { PERSONAS } from './data';
import { thinkTeams, thinkPirates, spawnPirateRaid } from './ai';

const DRAG = 1.1;

/** Charge totale en attente d'un dépôt (propriétaire + alliés). */
function depotLoad(st: Structure): number {
  let sum = st.pendingCredits;
  for (const k in st.pendingAllied) sum += st.pendingAllied[k];
  return sum;
}

/** Amiral piloté par un humain ? (pas d'autopilote, pas de ramassage IA) */
export function isHumanFlag(gs: GameState, s: Ship): boolean {
  return s.isFlagship && !!gs.teams[s.team] && !gs.teams[s.team].isAI;
}
/** Amiral (vaisseau contrôlé) d'une équipe. */
export function flagshipOf(gs: GameState, team: number): Ship | undefined {
  return gs.ships.find(x => x.alive && x.team === team && x.isFlagship);
}

/** Doctrine de tir du vaisseau : celle de sa flotte, sinon « feu à volonté ». */
function stanceOf(gs: GameState, s: Ship): Stance {
  if (s.fleetId != null) {
    const f = gs.fleets.find(f => f.id === s.fleetId);
    if (f) return f.stance;
  }
  return 'feu';
}
/** Peut-il engager de lui-même ? (paix : jamais ; défense : seulement si attaqué récemment) */
function mayEngage(gs: GameState, s: Ship): boolean {
  const st = stanceOf(gs, s);
  if (st === 'paix') return false;
  if (st === 'defense') return gs.t - s.lastDmgT < 6;
  return true;
}

// ================================================================
//  TICK PRINCIPAL
// ================================================================
export const SUDDEN_DEATH_T = 1200;   // 20 min : les boucliers des stations tombent
export const TIME_LIMIT_T = 5400;     // 1 h 30 : victoire au score (trou noir uniquement)

export function simTick(gs: GameState, dt: number) {
  if (gs.status !== 'playing') return;
  gs.t += dt;
  if (gs.alertT > 0) gs.alertT -= dt;
  if (gs.t - dt < SUDDEN_DEATH_T && gs.t >= SUDDEN_DEATH_T) {
    setAlert(gs, 'MORT SUBITE — BOUCLIERS DES STATIONS HORS-LIGNE', 5);
    addLog(gs, 'Mort subite : les stations ne rechargent plus leurs boucliers.', '#ff8c42');
  }

  setAllianceCheck((x, y) => areAllied(gs, x, y));

  // alliances : expiration après 15 min (renouvelables dans les 2 dernières minutes)
  for (const key of [...gs.alliances]) {
    const since = gs.allianceSince[key] ?? 0;
    const age = gs.t - since;
    const [a2, b2] = key.split('-').map(Number);
    if (age > ALLIANCE_DURATION) {
      breakAlliance(gs, a2, b2);
      addLog(gs, 'Le pacte est arrivé à son terme.', '#8fa8c8');
    } else if (age > ALLIANCE_DURATION - 120 && !gs.allianceSince[key + ':warn']) {
      gs.allianceSince[key + ':warn'] = 1;
      if (a2 === gs.playerTeam || b2 === gs.playerTeam) {
        setAlert(gs, 'ALLIANCE EXPIRE DANS 2 MIN — RENOUVELEZ-LA (J)', 5, '#ffd84b');
      }
      // deux IA alliées décident elles-mêmes du renouvellement
      if (a2 !== gs.playerTeam && b2 !== gs.playerTeam) {
        if (aiAcceptsAlliance(gs, a2, b2) && aiAcceptsAlliance(gs, b2, a2)) {
          gs.allianceSince[key] = gs.t;
          delete gs.allianceSince[key + ':warn'];
        }
      } else {
        // l'IA propose le renouvellement au joueur
        const ai = a2 === gs.playerTeam ? b2 : a2;
        if (gs.teams[ai]?.isAI && aiAcceptsAlliance(gs, ai, gs.playerTeam)) {
          gs.diploOffers.push({ id: gs.nextId++, from: ai, to: gs.playerTeam, type: 'alliance', expiresT: gs.t + 110 });
          addLog(gs, `${gs.teams[ai].name} souhaite renouveler votre alliance.`, gs.teams[ai].cssColor);
        }
      }
    }
  }

  // offres diplomatiques : expiration
  gs.diploOffers = gs.diploOffers.filter(o => {
    if (!gs.teams[o.from]?.alive || !gs.teams[o.to]?.alive) return false;
    if (o.expiresT <= gs.t) {
      if (o.to === gs.playerTeam) addLog(gs, `L'offre de ${gs.teams[o.from].name} a expiré.`, '#8fa8c8');
      return false;
    }
    return true;
  });

  updateStarBodies(gs, dt);
  updateStorms(gs, dt);
  updateMeteors(gs, dt);
  updateColossus(gs, dt);
  updateFleetMissions(gs, dt);
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
  // système triple : une primaire fixe + un couple binaire serré qui orbite autour d'elle
  if (gs.map.starType === 'triple' && bodies.length === 3) {
    const [a2, b2, c2] = bodies;
    a2.pos.x = 0; a2.pos.y = 0;
    b2.phase += 0.1 * dt;               // orbite lente du couple
    c2.phase += 0.55 * dt;              // valse rapide du couple sur lui-même
    const bx = Math.cos(b2.phase) * 230, by = Math.sin(b2.phase) * 230;
    const off = 52;
    b2.pos.x = bx + Math.cos(c2.phase) * off; b2.pos.y = by + Math.sin(c2.phase) * off;
    c2.pos.x = bx - Math.cos(c2.phase) * off; c2.pos.y = by - Math.sin(c2.phase) * off;
    return;
  }
  for (const b of bodies) {
    if (b.orbitR > 0) {
      b.phase += b.orbitSpeed * dt;
      b.pos.x = Math.cos(b.phase) * b.orbitR;
      b.pos.y = Math.sin(b.phase) * b.orbitR;
    }
  }
}

// ================================================================
//  MÉTÉORES — pluies de ressources à partir de 8 min (3 tous les ~5 min)
// ================================================================
function updateMeteors(gs: GameState, dt: number) {
  if (gs.t >= 480) {
    gs.meteorT -= dt;
    if (gs.meteorT <= 0) {
      gs.meteorT = 280 + gs.rng() * 60;
      for (let i = 0; i < 3; i++) {
        const edge = gs.rng() * Math.PI * 2;
        const from = fromAngle(edge, WORLD_R * 1.05);
        const target = fromAngle(gs.rng() * Math.PI * 2, gs.map.killRadius + 200 + gs.rng() * (WORLD_R * 0.7));
        const m: Meteor = {
          id: gs.nextId++, kind: 'meteor',
          pos: from, vel: scale(norm(sub(target, from)), 190 + gs.rng() * 50),
          target, alive: true,
        };
        gs.meteors.push(m);
      }
      addLog(gs, 'Pluie de météores détectée : ressources fraîches à l\'impact.', '#ffb35d');
      setAlert(gs, 'PLUIE DE MÉTÉORES EN APPROCHE', 4, '#ffb35d');
    }
  }
  for (const m of gs.meteors) {
    if (!m.alive) continue;
    m.pos = add(m.pos, scale(m.vel, dt));
    // traînée de feu
    if (gs.rng() < dt * 30) gs.fx.push({ type: 'tir', pos: { ...m.pos }, color: 0xff8c42, wid: 'canon' });
    if (dist(m.pos, m.target) < 26) {
      m.alive = false;
      gs.fx.push({ type: 'explosion', pos: { ...m.pos }, size: 26, color: 0xffb35d });
      gs.fx.push({ type: 'onde', pos: { ...m.pos }, size: 60, color: 0xff8c42 });
      for (const sh of gs.ships) {
        if (!sh.alive) continue;
        const d2 = dist(sh.pos, m.pos);
        if (d2 < 34) applyDamage(gs, sh, 25 * (1 - d2 / 34), NO_TEAM, true);
      }
      // gisement : quantités mélangées semi-aléatoires
      makeRoid(gs, 'roche', add(m.pos, fromAngle(gs.rng() * Math.PI * 2, 8)), 7 + gs.rng() * 5, 20 + Math.floor(gs.rng() * 25));
      if (gs.rng() < 0.65) {
        makeRoid(gs, 'minerai', add(m.pos, fromAngle(gs.rng() * Math.PI * 2, 16)), 5 + gs.rng() * 5, 10 + Math.floor(gs.rng() * 18));
      }
      if (gs.rng() < 0.4) {
        makeCloud(gs, add(m.pos, fromAngle(gs.rng() * Math.PI * 2, 20)), 24 + gs.rng() * 14, 8 + Math.floor(gs.rng() * 40));
      }
    } else if (len(m.pos) > WORLD_R * 1.2) {
      m.alive = false;
    }
  }
  gs.meteors = gs.meteors.filter(m => m.alive);
}

// ================================================================
//  NUAGES ÉLECTRIQUES — apparaissent en cours de partie, lâchent des orages
// ================================================================
function updateStorms(gs: GameState, dt: number) {
  gs.stormT -= dt;
  if (gs.stormT <= 0 && gs.storms.filter(st => st.alive).length < 3) {
    gs.stormT = 90 + gs.rng() * 90;
    const pos = fromAngle(gs.rng() * Math.PI * 2, WORLD_R * (0.35 + gs.rng() * 0.5));
    const storm: StormCloud = {
      id: gs.nextId++, kind: 'storm',
      pos, vel: fromAngle(gs.rng() * Math.PI * 2, 1.6),
      radius: 70 + gs.rng() * 40,
      boltT: 4 + gs.rng() * 6,
      alive: true,
    };
    gs.storms.push(storm);
    addLog(gs, 'Un nuage électrique s\'est formé — zone à laboratoires (et à orages).', '#c86bff');
    setAlert(gs, 'NUAGE ÉLECTRIQUE DÉTECTÉ', 4, '#c86bff');
  }

  for (const st of gs.storms) {
    if (!st.alive) continue;
    // dérive lente, rebond sur la bordure du monde
    st.pos = add(st.pos, scale(st.vel, dt));
    if (len(st.pos) > WORLD_R * 0.92) st.vel = scale(norm(st.pos), -1.6);

    st.boltT -= dt;
    if (st.boltT <= 0) {
      st.boltT = 5 + gs.rng() * 8;
      // éclair : direction aléatoire, frappe le premier vaisseau/structure du couloir
      const ang = gs.rng() * Math.PI * 2;
      const from = add(st.pos, fromAngle(ang, st.radius * 0.4));
      const range = 240;
      const dir = fromAngle(ang);
      let hitPos = add(from, scale(dir, range));
      let victim: Ship | Structure | null = null;
      let bd = range;
      const test = (e: Ship | Structure) => {
        const to = sub(e.pos, from);
        const along = to.x * dir.x + to.y * dir.y;
        if (along < 0 || along > range) return;
        const lat = Math.abs(to.x * dir.y - to.y * dir.x);
        if (lat < e.radius + 10 && along < bd) { bd = along; victim = e; }
      };
      for (const sh of gs.ships) if (sh.alive) test(sh);
      for (const su of gs.structures) if (su.alive) test(su);
      if (victim) {
        const v = victim as Ship | Structure;
        hitPos = { ...v.pos };
        v.shield = 0;                                // l'orage grille tout le bouclier…
        if (v.kind === 'ship') v.energy = v.energyMax;   // …mais recharge l'énergie à bloc
        if (v.kind === 'ship' && v.team === gs.playerTeam && v.id === gs.playerShipId) {
          addLog(gs, 'Foudroyé : bouclier grillé, énergie rechargée à 100 %.', '#c86bff');
        }
      }
      gs.fx.push({ type: 'eclair', pos: { ...from }, pos2: hitPos, color: 0xc86bff });
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
      const g = (2600000 / (d * d + 4000)) * (1 + gs.t / 1400);
      const dir = norm(scale(s.pos, -1));
      s.vel = add(s.vel, scale(dir, clamp(g, 0, 70) * dt));
    }
  }

  // Le trou noir dévore peu à peu les corps célestes : en fin de partie, tout y passe
  if (map.blackHole) {
    const pull = 0.5 + gs.t * 0.0015;
    const spiral = (pos: V2): V2 => {
      const dir = norm(scale(pos, -1));
      const tang = { x: -dir.y, y: dir.x };
      return add(pos, scale(add(dir, scale(tang, 0.45)), pull * dt));
    };
    for (const p of gs.planets) {
      if (!p.alive) continue;
      p.pos = spiral(p.pos);
      if (len(p.pos) < map.killRadius + p.radius * 0.3) {
        p.alive = false;
        gs.fx.push({ type: 'explosion', pos: { ...p.pos }, size: p.radius * 2.5, color: 0xff8c42 });
        addLog(gs, `${p.name} a été engloutie par le trou noir !`, '#ff8c42');
        if (p.owner === gs.playerTeam) setAlert(gs, `${p.name.toUpperCase()} ENGLOUTIE`, 3);
      }
    }
    for (const r of gs.roids) {
      if (!r.alive) continue;
      r.pos = spiral(r.pos);
      if (len(r.pos) < map.killRadius) { r.alive = false; gs.fx.push({ type: 'impact', pos: { ...r.pos }, color: 0xff8c42, size: 6 }); }
    }
    for (const c of gs.clouds) {
      if (!c.alive) continue;
      c.pos = spiral(c.pos);
      if (len(c.pos) < map.killRadius) c.alive = false;
    }
  }

  // Grondements avant la supernova
  if (map.supernovaAt > 0 && gs.supernovaWave < 0) {
    const left = map.supernovaAt - gs.t;
    if (left < 20 && Math.floor((gs.t + dt) / 3) !== Math.floor(gs.t / 3)) {
      gs.fx.push({ type: 'onde', pos: v2(), size: 180 + (20 - left) * 14, color: 0xff6b4b });
    }
    if (left <= 10 && left + dt > 10) setAlert(gs, 'EFFONDREMENT DU CŒUR STELLAIRE', 4);
  }

  // Impulsion de l'étoile à neutrons
  if (map.neutronPeriod > 0) {
    gs.neutronT -= dt;
    if (gs.neutronT <= 8 && gs.neutronT + dt > 8) setAlert(gs, 'IMPULSION EMP IMMINENTE', 3);
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

  // À 60 min, l'étoile du système devient instable : supernova 5 min plus tard
  if (map.supernovaAt < 0 && !map.blackHole && gs.t >= 3600) {
    map.supernovaAt = gs.t + 300;
    addLog(gs, 'Le cœur de l\'étoile s\'effondre : SUPERNOVA dans 5 minutes.', '#ff6b4b');
    setAlert(gs, 'L\'ÉTOILE DEVIENT INSTABLE — SUPERNOVA DANS 5 MIN', 6);
  }

  // Supernova
  if (map.supernovaAt > 0 && gs.supernovaWave < 0 && gs.t >= map.supernovaAt) {
    gs.supernovaWave = 0;
    setAlert(gs, 'SUPERNOVA !', 6);
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

  // amarré à un dépôt ami ou ALLIÉ (s'il n'est pas plein) : décharge la soute
  const depot = nearestStruct(gs, s.pos,
    x => x.stype === 'depot' && (x.team === s.team || areAllied(gs, x.team, s.team)) && depotLoad(x) < DEPOT_CAP,
    DOCK_RANGE);
  if (depot && cargoTotal(s) > 0) {
    let value = 0;
    for (const r of ['roche', 'minerai', 'gaz'] as Res[]) {
      value += s.cargo[r] * RES_PRICE[r];
      s.cargo[r] = 0;
    }
    value = Math.round(value);
    if (depot.team === s.team) {
      depot.pendingCredits += value;
    } else {
      // dépôt chez un allié : il touche 20 % en bonus, sans rien vous retirer
      depot.pendingAllied[s.team] = (depot.pendingAllied[s.team] ?? 0) + value;
      depot.pendingCredits += Math.round(value * DEPOT_ALLY_BONUS);
    }
    if (s.id === gs.playerShipId) addLog(gs, `Cargaison déposée au dépôt (+${value} en attente).`, '#ffd84b');
  }

  // amarré à la station d'un ALLIÉ : vente pleine valeur, 20 % de bonus pour l'hôte
  if (cargoTotal(s) > 0) {
    const allySt = nearestStruct(gs, s.pos,
      x => x.stype === 'station' && x.team !== s.team && areAllied(gs, x.team, s.team), DOCK_RANGE);
    if (allySt) {
      let value = 0;
      for (const r of ['roche', 'minerai', 'gaz'] as Res[]) {
        value += s.cargo[r] * RES_PRICE[r];
        s.cargo[r] = 0;
      }
      value = Math.round(value);
      const me = gs.teams[s.team];
      const host = gs.teams[allySt.team];
      if (me) me.credits += value;
      if (host) host.credits += Math.round(value * DEPOT_ALLY_BONUS);
      if (s.id === gs.playerShipId) addLog(gs, `Vente chez l'allié : +${value} crédits.`, '#ffd84b');
    }
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
  if (isHumanFlag(gs, s)) { playerAssist(gs, s, dt); return; }
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
      const foe = mayEngage(gs, s) ? findFoeNear(gs, s, s.pos, SHIP_CLASSES[s.cls].sensor * 0.8) : null;
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
      // la cible est (devenue) alliée ou amie : on n'attaque pas les siens
      const tTeam = target.kind === 'planet' ? target.owner : target.team;
      if (!isEnemy(s.team, tTeam)) { s.order = { ...IDLE }; break; }
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
      // une escorte attaquée se défend sans quitter la flotte (sauf doctrine pacifique)
      if (SHIP_CLASSES[s.cls].power > 3 && gs.t - s.lastDmgT < 4 && stanceOf(gs, s) !== 'paix') {
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
    case 'orbit': {
      const body = structById(gs, o.targetId ?? -1) ?? planetById(gs, o.targetId ?? -1);
      if (!body) { s.order = { kind: 'guard', pos: { ...s.pos } }; break; }
      // un ennemi rôde ? la garde intercepte, puis reprend sa ronde d'elle-même
      if (mayEngage(gs, s)) {
        const foe = findFoeNear(gs, s, body.pos, 260);
        if (foe) { combatApproach(gs, s, foe.pos, foe, dt); break; }
      }
      const ringR = body.radius + 36;
      const slot = fromAngle(s.avoidSeed + gs.t * 0.35, ringR);
      moveToward(gs, s, add(body.pos, slot), dt, 4);
      break;
    }
  }

  // attaque à vue des vaisseaux armés inactifs, selon leur doctrine
  if (s.team !== PIRATE_TEAM) {
    if ((o.kind === 'idle' || o.kind === 'move' || o.kind === 'dock') && SHIP_CLASSES[s.cls].power > 3
        && s.aiCd <= 0 && mayEngage(gs, s)) {
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

  // tir (un verrouillage missile en cours bloque les autres armes)
  const locking = s.lockT > 0 && s.id !== gs.playerShipId;
  for (let i = 0; i < s.weapons.length; i++) {
    const ws = s.weapons[i];
    const w = WEAPONS[ws.wid];
    if (ws.wid === 'missile') {
      if (isHumanFlag(gs, s)) continue;            // les humains verrouillent eux-mêmes (touche A)
      if (target.kind === 'planet') continue;
      const tid = (target as Ship | Structure).id;
      if (ws.cd > 0 || s.energy < w.energy || d > w.range) {
        if (s.lockTargetId === tid) lockCancel(s);
        continue;
      }
      if (s.lockTargetId !== tid) { s.lockTargetId = tid; s.lockT = 0; }
      s.lockT += dt;
      if (s.lockT >= (w.lockTime ?? 1.2)) { fireMissile(gs, s, i, tid); lockCancel(s); }
      continue;
    }
    if (locking) continue;
    if (d < w.range * 1.05) {
      const targetId = target.kind === 'planet' ? undefined : (target as Ship | Structure).id;
      fireShipWeapon(gs, s, i, targetPos, targetId, target.kind === 'planet' ? target.id : undefined);
    }
  }

  // en combat rapproché, l'IA largue parfois une de ses bombes
  if (!isHumanFlag(gs, s) && s.mineCount > 0 && d < 70 && gs.rng() < dt * 0.25) {
    dropMine(gs, s, targetPos);
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
    // point de dépôt le plus proche : dépôt (non plein) ou station, chez soi ou chez un allié
    const candidates: Structure[] = gs.structures.filter(x => x.alive
      && (x.team === s.team || areAllied(gs, x.team, s.team))
      && (x.stype === 'station' || (x.stype === 'depot' && depotLoad(x) < DEPOT_CAP)));
    let target: Structure | null = null, bd = Infinity;
    for (const c of candidates) {
      const d = dist(c.pos, s.pos);
      if (d < bd) { bd = d; target = c; }
    }
    if (!target) { s.order = { ...IDLE }; return; }
    arrive(gs, s, target.pos, dt, DOCK_RANGE * 0.6); // le déchargement est automatique une fois amarré
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
  const tradable = (p: Planet) => p.owner === s.team || (p.owner >= 0 && areAllied(gs, p.owner, s.team));
  let planet = planetById(gs, s.order.targetId ?? -1);
  if (!planet || !tradable(planet)) {
    planet = gs.planets.find(p => p.alive && tradable(p)) ?? undefined as any;
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
      // le commerce avec une colonie ALLIÉE rapporte trois fois plus
      const allied = planet.owner !== s.team;
      const profit = allied ? TRADE_PROFIT * ALLY_TRADE_MULT : TRADE_PROFIT;
      team.credits += profit;
      s.tradePhase = 0;
      if (s.team === gs.playerTeam) addLog(gs, `Livraison commerciale${allied ? ' (alliée)' : ''} : +${profit} crédits.`, '#ffd84b');
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
      if (s.team === gs.playerTeam) setAlert(gs, `${planet.name} COLONISÉE`, 3.5, '#6dff8a');
      // le transporteur se pose définitivement : il est consommé par la colonie
      gs.fx.push({ type: 'saut', pos: { ...s.pos } });
      s.alive = false;
      removeFromFleet(gs, s);
      if (s.id === gs.playerShipId) {
        gs.playerShipId = -1;
        team.respawnT = 2;
        addLog(gs, `Votre transporteur s'est posé — nouveau vaisseau à la station.`, '#40c4ff');
      }
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

  // séparation douce entre vaisseaux proches (anti-empilement)
  for (const o of gs.ships) {
    if (!o.alive || o.id === s.id) continue;
    const minD = o.radius + s.radius + 3;
    const dx = s.pos.x - o.pos.x, dy = s.pos.y - o.pos.y;
    if (Math.abs(dx) > minD || Math.abs(dy) > minD) continue;
    const d = Math.hypot(dx, dy);
    if (d < minD && d > 0.01) {
      const push = (minD - d) / minD * 42 * dt;
      s.vel.x += (dx / d) * push;
      s.vel.y += (dy / d) * push;
    }
  }

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
      if (target.kind === 'ship' && w.slowFactor) {
        target.stasisT = Math.max(target.stasisT, w.slowDur ?? 1.5);
        target.energy = Math.max(0, target.energy - 16);   // la stase draine l'énergie
        gs.fx.push({ type: 'stase_fx', pos: { ...target.pos }, size: target.radius + 4 });
      }
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
  if (target.kind === 'structure') target.lastDmgT = gs.t;
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
        // les civils fuient vers la station — parfois derrière un écran de fumée
        const st = structById(gs, gs.teams[target.team]?.stationId ?? -1);
        if (st) target.order = { kind: 'flee', pos: { ...st.pos } };
        if (gs.rng() < 0.15 && !gs.smokes.some(z => dist(z.pos, target.pos) < z.radius)) {
          gs.smokes.push({ id: gs.nextId++, pos: { ...target.pos }, radius: 60, t: 10 });
          gs.fx.push({ type: 'fumee', pos: { ...target.pos }, size: 60 });
        }
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
    if (st.stype === 'usine' && st.buildT > 0) {
      setAlert(gs, st.team === gs.playerTeam ? 'LE CHANTIER DU COLOSSE EST DÉTRUIT' : 'LE CHANTIER DU COLOSSE ENNEMI EST DÉTRUIT', 5,
        st.team === gs.playerTeam ? '#ff4b4b' : '#6dff8a');
    }
  }
}

function eliminateTeam(gs: GameState, teamId: number, attackerTeam: number) {
  const team = gs.teams[teamId];
  if (!team || !team.alive) return;
  team.alive = false;
  addLog(gs, `L'équipe ${team.name} est ÉLIMINÉE !`, team.cssColor);
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

    // bouclier des structures : régénère après 10 s sans dégât (coupé en mort subite)
    if (st.shield < st.shieldMax && gs.t < SUDDEN_DEATH_T && gs.t - st.lastDmgT > 10) {
      st.shield = clamp(st.shield + 7 * dt, 0, st.shieldMax);
    }

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

    // chantier du Colosse
    if (st.stype === 'usine' && st.buildT > 0) {
      st.buildT -= dt;
      if (gs.rng() < dt * 4) {
        gs.fx.push({ type: 'impact', pos: add(st.pos, fromAngle(gs.rng() * Math.PI * 2, st.radius * gs.rng())), color: 0x7adfff, size: 6 });
      }
      const owner2 = gs.teams[st.team];
      if (st.buildT <= 0 && owner2) {
        // chantier terminé : le vaisseau du propriétaire explose… et renaît en COLOSSE
        st.alive = false;
        owner2.colossusUsed = true;
        gs.fx.push({ type: 'explosion', pos: { ...st.pos }, size: 40, color: 0xff2222 });
        gs.fx.push({ type: 'onde', pos: { ...st.pos }, size: 200, color: 0xff2222 });
        const flag = gs.ships.find(x => x.alive && x.team === st.team && x.isFlagship);
        if (flag) {
          gs.fx.push({ type: 'explosion', pos: { ...flag.pos }, size: flag.radius * 2, color: 0xff8c42 });
          flag.alive = false;
          removeFromFleet(gs, flag);
        }
        owner2.respawnT = 0;
        const colosse = makeShip(gs, st.team, 'colosse', { ...st.pos });
        colosse.isFlagship = true;
        applyUpgrades(gs, colosse);
        if (st.team === gs.playerTeam) {
          gs.playerShipId = colosse.id;
          setAlert(gs, 'LE COLOSSE EST NÉ', 6, '#6dff8a');
          addLog(gs, 'COLOSSE opérationnel : rayons automatiques, A = salve de 8 missiles, E = Brise-Monde.', '#ff4b4b');
        } else {
          setAlert(gs, `${owner2.name.toUpperCase()} A DÉCHAÎNÉ UN COLOSSE`, 6);
        }
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
      const nearRoid = gs.roids.some(r => r.alive && dist(r.pos, st.pos) < 320);
      if (nearRoid) team.credits += Math.round(MINE_INCOME * mult);
    }
    if (st.stype === 'depot' && depotLoad(st) > 0) {
      // le dépôt écoule sa valeur à débit limité : le propriétaire d'abord, puis les alliés
      let budget = DEPOT_RATE * dt;
      const own = Math.min(st.pendingCredits, budget);
      st.pendingCredits -= own;
      team.credits += own;
      budget -= own;
      for (const k in st.pendingAllied) {
        if (budget <= 0) break;
        const t2 = gs.teams[Number(k)];
        const out = Math.min(st.pendingAllied[k], budget);
        st.pendingAllied[k] -= out;
        budget -= out;
        if (t2) t2.credits += out;
        if (st.pendingAllied[k] <= 0) delete st.pendingAllied[k];
      }
    }
    if (st.stype === 'labo' && st.incomeT >= LABO_INCOME_PERIOD) {
      st.incomeT = 0;
      const inStorm = gs.storms.some(sc => sc.alive && dist(sc.pos, st.pos) < sc.radius);
      if (inStorm) team.credits += Math.round(LABO_INCOME * mult);
    }
  }
}

function updatePlanets(gs: GameState, dt: number) {
  for (const p of gs.planets) {
    if (!p.alive) continue;
    // planète frappée : le noyau s'effondre puis elle explose
    if (p.dyingT > 0) {
      p.dyingT -= dt;
      if (p.dyingT < 5 && gs.rng() < dt * (4 + (5 - p.dyingT) * 3)) {
        gs.fx.push({ type: 'impact', pos: add(p.pos, fromAngle(gs.rng() * Math.PI * 2, p.radius * gs.rng())), color: 0xff5d2a, size: 9 });
      }
      if (p.dyingT <= 0) explodePlanet(gs, p);
      continue;
    }
    if (p.owner < 0) continue;
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

/** Explosion d'une planète frappée : dégâts + vaisseaux projetés dans un large rayon. */
function explodePlanet(gs: GameState, p: Planet) {
  p.alive = false;
  const dmgR = p.radius * 8;
  const pushR = p.radius * 22;   // onde de répulsion massive
  gs.fx.push({ type: 'explosion', pos: { ...p.pos }, size: p.radius * 3.5, color: 0xff6b4b });
  gs.fx.push({ type: 'onde', pos: { ...p.pos }, size: pushR, color: 0xff8c42 });
  gs.fx.push({ type: 'onde', pos: { ...p.pos }, size: pushR * 0.6, color: 0xffd84b });
  for (const s of gs.ships) {
    if (!s.alive) continue;
    const d = dist(s.pos, p.pos);
    if (d < pushR) {
      const f = 1 - d / pushR;
      s.vel = add(s.vel, scale(norm(sub(s.pos, p.pos)), 320 * f));
      if (d < dmgR) applyDamage(gs, s, 60 * (1 - d / dmgR), NO_TEAM, true);
    }
  }
  addLog(gs, `${p.name} A EXPLOSÉ !`, '#ff6b4b');
  setAlert(gs, `${p.name.toUpperCase()} DÉTRUITE`, 3);
}

// ================================================================
//  MINES LARGUÉES
// ================================================================
export function dropMine(gs: GameState, s: Ship, aim?: V2): boolean {
  if (!s.mineType || s.mineCount <= 0) return false;
  s.mineCount--;
  const def = MINES[s.mineType];
  // la mine est lancée avec de l'élan vers le curseur
  const dir = aim ? norm(sub(aim, s.pos)) : fromAngle(s.heading + Math.PI);
  const throwDist = aim ? Math.min(dist(aim, s.pos), 170) : 25;
  const speed = clamp(throwDist * 1.5, 35, 190);
  const start = add(s.pos, scale(dir, s.radius + 4));
  makeMineEnt(gs, s.team, s.mineType, start, def.fuse, add(scale(dir, speed), scale(s.vel, 0.4)));
  return true;
}

function updateMines(gs: GameState, dt: number) {
  for (const m of gs.minesArmed) {
    if (!m.alive) continue;
    // élan du lancer, avec frottement
    m.pos = add(m.pos, scale(m.vel, dt));
    m.vel = scale(m.vel, Math.max(0, 1 - 2.4 * dt));
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
      if (!s.alive || isHumanFlag(gs, s)) continue;
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
  // En multijoueur, l'élimination d'un humain ne termine pas la partie.
  if (!gs.cfg.multiplayer && !gs.teams[gs.playerTeam].alive && !gs.teams[gs.playerTeam].isAI) {
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
  // tous les survivants sont alliés : victoire partagée
  if (alive.length >= 2 && alive.every(x => alive.every(y => areAllied(gs, x, y)))) {
    gs.status = 'over';
    gs.winner = alive.includes(gs.playerTeam) ? gs.playerTeam : alive[0];
    gs.overReason = `Victoire d'alliance : les survivants sont tous alliés.`;
    return;
  }
  // limite de temps au score : seulement autour d'un trou noir (pas de supernova possible)
  if (gs.map.blackHole && gs.t >= TIME_LIMIT_T) {
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
  if (pilot && !team.isAI) {
    const old = flagshipOf(gs, teamId);
    if (old) {
      // reprise : l'ancien vaisseau est revendu à moitié prix
      team.credits += Math.round(SHIP_CLASSES[old.cls].prix * 0.5);
      old.alive = false;
      removeFromFleet(gs, old);
    }
    ship.isFlagship = true;
    applyUpgrades(gs, ship);
    if (teamId === gs.playerTeam) gs.playerShipId = ship.id;
    addLog(gs, `${team.name} pilote maintenant : ${def.nom}.`, team.cssColor);
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
  const flag = flagshipOf(gs, teamId);
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
  // l'usine d'assemblage : 5 laboratoires, une seule par équipe, un seul Colosse
  if (stype === 'usine') {
    const team2 = gs.teams[teamId];
    if (team2?.colossusUsed) return 'Le Colosse a déjà été assemblé';
    if (gs.structures.some(st => st.alive && st.team === teamId && st.stype === 'usine')) return 'Usine déjà en chantier';
    const labs = gs.structures.filter(st => st.alive && st.team === teamId && st.stype === 'labo').length;
    if (labs < COLOSSE_LABS_REQUIRED) return `Requiert ${COLOSSE_LABS_REQUIRED} laboratoires (${labs}/${COLOSSE_LABS_REQUIRED})`;
  }
  // le laboratoire se bâtit DANS un nuage électrique, où qu'il soit
  if (stype === 'labo') {
    if (!gs.storms.some(sc => sc.alive && dist(sc.pos, pos) < sc.radius)) {
      return 'Doit être bâti dans un nuage électrique';
    }
  } else {
    // dans le territoire : à portée d'une structure existante
    // (les mines spatiales ont un rayon de déploiement bien plus large)
    const reach = stype === 'mine' ? 1.8 : 1;
    const near = gs.structures.some(st => st.alive && st.team === teamId &&
      dist(st.pos, pos) < (st.stype === 'station' ? 420 : 300) * reach);
    if (!near) return 'Trop loin de votre territoire';
  }
  for (const st of gs.structures) if (st.alive && dist(st.pos, pos) < st.radius + def.radius + 18) return 'Trop proche d\'une structure';
  for (const p of gs.planets) if (p.alive && dist(p.pos, pos) < p.radius + def.radius + 10) return 'Trop proche d\'une planète';
  for (const b of gs.map.bodies) if (dist(b.pos, pos) < gs.map.killRadius + 40) return 'Trop proche de l\'étoile';
  if (stype === 'mine' && !gs.roids.some(r => r.alive && dist(r.pos, pos) < 320)) return 'Doit être à moins de 320 m d\'astéroïdes';
  return null;
}

export function placeStructure(gs: GameState, teamId: number, stype: StructType, pos: V2): string | null {
  const err = canPlaceStructure(gs, teamId, stype, pos);
  if (err) return err;
  const team = gs.teams[teamId]!;
  team.credits -= STRUCTS[stype].prix;
  const st = makeStructure(gs, teamId, stype, pos);
  gs.fx.push({ type: 'saut', pos: { ...pos } });
  addLog(gs, `${STRUCTS[stype].nom} construit(e).`, team.cssColor);
  if (stype === 'usine') {
    // TOUT LE MONDE est prévenu : 4 minutes pour l'abattre
    st.buildT = COLOSSE_BUILD_TIME;
    addLog(gs, `${team.name} assemble un COLOSSE ! Chantier : 4 minutes.`, '#ff4b4b');
    setAlert(gs, teamId === gs.playerTeam
      ? 'CHANTIER DU COLOSSE LANCÉ — TENEZ 4 MINUTES'
      : `${team.name.toUpperCase()} ASSEMBLE UN COLOSSE — DÉTRUISEZ L'USINE`, 6);
  }
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
      const planet = planetById(gs, targetId ?? -1);
      if (planet) {
        if (dist(s.pos, planet.pos) > 480) return 'Cible trop éloignée';
        if (planet.dyingT > 0) return 'La planète se disloque déjà';
        planet.dyingT = 6;
        gs.fx.push({ type: 'frappe', pos: { ...planet.pos }, size: planet.radius });
        addLog(gs, `Frappe orbitale : le noyau de ${planet.name} s'effondre !`, '#ff6b4b');
        break;
      }
      const target = shipById(gs, targetId ?? -1) ?? structById(gs, targetId ?? -1);
      if (!target || !isEnemy(teamId, target.team)) return 'Aucune cible ennemie visée';
      if (dist(s.pos, target.pos) > 420) return 'Cible trop éloignée';
      gs.fx.push({ type: 'frappe', pos: { ...target.pos }, size: 30 });
      dealHit(gs, target, 170, teamId);
      areaDamage(gs, target.pos, 24, 60, teamId);
      break;
    }
    case 'soutien': {
      for (let i = 0; i < 13; i++) {
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

/** Applique les entrées continues d'un humain (serveur multijoueur). */
export function applyHumanInput(gs: GameState, teamId: number,
  input: { thrust: { x: number; y: number }; aim: V2; fire: boolean; fireE: boolean; mineF: boolean }, dt: number) {
  const ship = flagshipOf(gs, teamId);
  if (!ship || ship.empT > 0 || ship.jumpT > 0) return;
  const def = SHIP_CLASSES[ship.cls];
  const l = Math.hypot(input.thrust.x, input.thrust.y);
  if (l > 0.01) {
    ship.vel.x += (input.thrust.x / l) * def.accel * dt;
    ship.vel.y += (input.thrust.y / l) * def.accel * dt;
  }
  if (ship.cls !== 'colosse') {
    if (input.fire) fireShipWeapon(gs, ship, 0, input.aim);
    if (input.fireE) fireShipWeapon(gs, ship, 2, input.aim);
  }
  if (input.mineF) shipMineHold(gs, ship, dt);
}

/** Tir missile demandé par un client : le serveur revalide tout. */
export function missileFireCmd(gs: GameState, teamId: number, targetId: number): string | null {
  const ship = flagshipOf(gs, teamId);
  if (!ship) return 'Aucun vaisseau';
  const slot = missileSlot(ship);
  if (slot < 0) return 'Pas de lance-missiles';
  const w = WEAPONS.missile;
  if (ship.weapons[slot].cd > 0) return 'Missile en recharge';
  if (ship.energy < w.energy) return 'Énergie insuffisante';
  const target = shipById(gs, targetId) ?? structById(gs, targetId);
  if (!target || !isEnemy(ship.team, target.team)) return 'Cible invalide';
  if (dist(target.pos, ship.pos) > w.range * 1.2) return 'Cible hors de portée';
  ship.lockT = w.lockTime ?? 1.2;
  ship.lockTargetId = targetId;
  lockRelease(gs, ship);
  return null;
}

/** Salve du Colosse demandée par un client. */
export function salveFireCmd(gs: GameState, teamId: number, targets: number[]): string | null {
  const ship = flagshipOf(gs, teamId);
  if (!ship || ship.cls !== 'colosse') return 'Pas de Colosse';
  const w = WEAPONS.salve;
  if (ship.weapons[0].cd > 0) return 'Salve en recharge';
  if (ship.energy < w.energy) return 'Énergie insuffisante';
  const valid = targets.slice(0, COLOSSE_SALVO_SIZE).filter(tid => {
    const t = shipById(gs, tid);
    return t && isEnemy(ship.team, t.team) && dist(t.pos, ship.pos) < w.range * 1.2;
  });
  if (valid.length === 0) return 'Aucune cible valide';
  ship.weapons[0].cd = w.cd;
  ship.energy -= w.energy;
  valid.forEach((tid, i) => {
    const t = shipById(gs, tid);
    const dir = t ? norm(sub(t.pos, ship.pos)) : fromAngle(ship.heading + i);
    const from = add(ship.pos, fromAngle((i / COLOSSE_SALVO_SIZE) * Math.PI * 2, ship.radius + 3));
    makeProjectile(gs, ship.team, 'missile', from, scale(dir, w.speed ?? 160), w.dmg, 3.2, tid);
    gs.fx.push({ type: 'tir', pos: { ...from }, color: w.color, wid: 'missile' });
  });
  return null;
}

/** Minage manuel d'un vaisseau (touche F maintenue). */
export function shipMineHold(gs: GameState, s: Ship, dt: number): Res | null {
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

/** Minage manuel du joueur (touche F maintenue). Retourne la ressource minée ou null. */
export function playerMine(gs: GameState, dt: number): Res | null {
  const s = playerShip(gs);
  if (!s) return null;
  return shipMineHold(gs, s, dt);
}

/** Renforce la colonie d'une planète possédée (+vie max, réparation). */
export function tryUpgradePlanet(gs: GameState, teamId: number, planetId: number): string | null {
  const team = gs.teams[teamId];
  const planet = planetById(gs, planetId);
  if (!team || !planet) return 'Cible invalide';
  if (planet.owner !== teamId) return 'Cette colonie ne vous appartient pas';
  if (planet.colonyHpMax >= 1200) return 'Défenses de colonie au maximum';
  if (team.credits < PLANET_UPGRADE_COST) return 'Crédits insuffisants';
  team.credits -= PLANET_UPGRADE_COST;
  planet.colonyHpMax += PLANET_UPGRADE_HP;
  planet.colonyHp = Math.min(planet.colonyHpMax, planet.colonyHp + PLANET_UPGRADE_HP);
  addLog(gs, `Colonie de ${planet.name} renforcée (${planet.colonyHpMax} PV).`, team.cssColor);
  return null;
}

/** Prend le contrôle du vaisseau allié le plus proche (l'actuel passe à l'IA). */
export function takeControlNearest(gs: GameState, teamId = gs.playerTeam): string | null {
  const cur = flagshipOf(gs, teamId);
  if (!cur) return 'Aucun vaisseau';
  const other = nearestShip(gs, cur.pos, s => s.team === teamId && s.id !== cur.id && s.supportT <= 0, 220);
  if (!other) return 'Aucun vaisseau allié à proximité (220 m)';
  cur.isFlagship = false;
  cur.order = { kind: 'guard', pos: { ...cur.pos } };
  other.isFlagship = true;
  other.order = { ...IDLE };
  removeFromFleet(gs, other);
  if (teamId === gs.playerTeam) gs.playerShipId = other.id;
  addLog(gs, `Contrôle transféré : ${SHIP_CLASSES[other.cls].nom}.`, '#40c4ff');
  return null;
}

// ================================================================
//  MISSIONS DE FLOTTE AUTONOMES (minage auto, patrouilles)
// ================================================================
function updateFleetMissions(gs: GameState, dt: number) {
  for (const f of gs.fleets) {
    const kind = f.mission.kind;
    if (!['attack', 'mine_auto', 'patrol_in', 'patrol_border', 'patrol_out', 'protect', 'trade_auto', 'patrol_civil', 'plan'].includes(kind)) continue;
    const ships = fleetShips(gs, f);
    if (ships.length === 0) continue;
    const team = gs.teams[f.team];
    const station = structById(gs, team?.stationId ?? -1);
    const home = station ? station.pos : v2();

    // ---- siège coordonné : contre une structure/planète, la flotte se répartit ----
    if (kind === 'attack') {
      const tid = f.mission.targetId ?? -1;
      const core = structById(gs, tid) ?? planetById(gs, tid);
      if (!core) continue;   // cible vaisseau : comportement standard
      f.patrolAngle += dt;
      if (f.patrolAngle < 3) continue;   // réévalue la répartition toutes les ~3 s
      f.patrolAngle = 0;
      const R = 460;
      const outposts = gs.structures.filter(st2 => st2.alive && st2.id !== core.id
        && isEnemy(f.team, st2.team) && STRUCTS[st2.stype].weaponDmg > 0 && dist(st2.pos, core.pos) < R);
      const bombers = ships.filter(sh => sh.cls === 'bombardier');
      const bomberIds = new Set(bombers.map(b2 => b2.id));
      // menaces : les ennemis qui tirent sur nos unités vulnérables passent en priorité
      const vulnerable = new Set([...bomberIds, ...ships.filter(sh => SHIP_CLASSES[sh.cls].civil).map(sh => sh.id)]);
      const foes = gs.ships
        .filter(sh => sh.alive && isEnemy(f.team, sh.team) && SHIP_CLASSES[sh.cls].power > 3 && dist(sh.pos, core.pos) < R)
        .sort((x, y) => {
          const px = x.order.kind === 'attack' && vulnerable.has(x.order.targetId ?? -1) ? 0 : 1;
          const py = y.order.kind === 'attack' && vulnerable.has(y.order.targetId ?? -1) ? 0 : 1;
          return px - py || dist(x.pos, core.pos) - dist(y.pos, core.pos);
        });
      // bombardiers : 2/3 sur le cœur, 1/3 sur les avant-postes voisins
      bombers.forEach((b2, i) => {
        const onCore = outposts.length === 0 || i < Math.max(1, Math.ceil(bombers.length * 0.66));
        const want = onCore ? core.id : outposts[i % outposts.length].id;
        if (b2.order.kind !== 'attack' || b2.order.targetId !== want) b2.order = { kind: 'attack', targetId: want };
      });
      // chasseurs & co : d'abord les vaisseaux ennemis (menaces en tête), sinon
      // les avant-postes, sinon le cœur — chacun sa cible, dans le rayon d'action
      const fighters = ships.filter(sh => !bomberIds.has(sh.id) && SHIP_CLASSES[sh.cls].power > 3);
      fighters.forEach((c2, i) => {
        let want: number;
        if (foes.length > 0) want = foes[i % foes.length].id;
        else if (outposts.length > 0) want = outposts[i % outposts.length].id;
        else want = core.id;
        if (c2.order.kind !== 'attack' || c2.order.targetId !== want) c2.order = { kind: 'attack', targetId: want };
      });
      continue;
    }

    if (kind === 'mine_auto') {
      const miners = ships.filter(x => SHIP_CLASSES[x.cls].canMine);
      const guards = ships.filter(x => !SHIP_CLASSES[x.cls].canMine);
      for (const m of miners) {
        const valid = m.order.kind === 'mine' && (
          cargoTotal(m) >= m.cargoMax - 0.5 ||
          gs.roids.some(r => r.id === m.order.targetId && r.alive && r.amount > 0) ||
          gs.clouds.some(c => c.id === m.order.targetId && c.alive && c.amount > 0));
        if (!valid) {
          // priorité : la ressource la plus proche du territoire (de la station)
          let bestId = -1, bd = Infinity;
          for (const r of gs.roids) {
            if (!r.alive || r.amount <= 0) continue;
            const d = dist(r.pos, home);
            if (d < bd) { bd = d; bestId = r.id; }
          }
          for (const c of gs.clouds) {
            if (!c.alive || c.amount <= 0) continue;
            const d = dist(c.pos, home) + 60;
            if (d < bd) { bd = d; bestId = c.id; }
          }
          m.order = bestId >= 0 ? { kind: 'mine', targetId: bestId } : { kind: 'guard', pos: { ...home } };
        }
      }
      // les vaisseaux armés de la flotte escortent automatiquement les mineurs
      guards.forEach((g, i) => {
        if (g.order.kind === 'attack') return; // laisse-le finir son combat
        if (miners.length === 0) {
          if (g.order.kind === 'idle') g.order = { kind: 'guard', pos: { ...home } };
          return;
        }
        const ward = miners[i % miners.length];
        if (g.order.kind !== 'escort' || g.order.targetId !== ward.id) {
          g.order = { kind: 'escort', targetId: ward.id };
        }
      });
      continue;
    }

    // ---- protection de l'amiral ----
    if (kind === 'protect') {
      const flag = gs.ships.find(x => x.alive && x.team === f.team && x.isFlagship);
      if (!flag) continue;
      for (const x of ships) {
        if (x.order.kind === 'attack') continue;
        if (x.order.kind !== 'escort' || x.order.targetId !== flag.id) {
          x.order = { kind: 'escort', targetId: flag.id };
        }
      }
      continue;
    }

    // ---- commerce auto : les cargos tracent la route, les armés les escortent ----
    if (kind === 'trade_auto') {
      const traders = ships.filter(x => SHIP_CLASSES[x.cls].civil);
      const guards = ships.filter(x => !SHIP_CLASSES[x.cls].civil);
      for (const c of traders) {
        if (c.order.kind !== 'trade') { c.order = { kind: 'trade' }; c.tradePhase = 0; }
      }
      guards.forEach((g, i) => {
        if (g.order.kind === 'attack') return;
        const ward = traders[i % Math.max(1, traders.length)];
        if (ward && (g.order.kind !== 'escort' || g.order.targetId !== ward.id)) {
          g.order = { kind: 'escort', targetId: ward.id };
        } else if (!ward && g.order.kind === 'idle') {
          g.order = { kind: 'guard', pos: { ...home } };
        }
      });
      continue;
    }

    // ---- patrouille civile : escorte les civils les plus en danger ----
    if (kind === 'patrol_civil') {
      f.patrolAngle += dt;
      if (f.patrolAngle < 3 && ships.some(x => x.order.kind === 'escort')) continue; // réévalue ~3 s
      f.patrolAngle = 0;
      const civils = gs.ships.filter(x => x.alive && x.team === f.team && SHIP_CLASSES[x.cls].civil);
      if (civils.length === 0) {
        for (const g of ships) if (g.order.kind === 'idle') g.order = { kind: 'guard', pos: { ...home } };
        continue;
      }
      // danger : proximité de menaces ennemies + absence de couverture armée
      const threats = [
        ...gs.ships.filter(x => x.alive && isEnemy(f.team, x.team) && SHIP_CLASSES[x.cls].power > 3),
        ...gs.structures.filter(x => x.alive && isEnemy(f.team, x.team) && STRUCTS[x.stype].weaponDmg > 0),
      ];
      const scored = civils.map(c => {
        let nearThreat = Infinity;
        for (const t2 of threats) nearThreat = Math.min(nearThreat, dist(t2.pos, c.pos));
        const covered = gs.ships.some(g2 => g2.alive && g2.team === f.team
          && SHIP_CLASSES[g2.cls].power > 3 && !ships.includes(g2) && dist(g2.pos, c.pos) < 160);
        const danger = Math.max(0, 700 - Math.min(nearThreat, 700)) + (covered ? 0 : 260);
        return { c, danger };
      }).sort((x, y) => y.danger - x.danger);
      ships.forEach((g, i) => {
        if (g.order.kind === 'attack') return;
        const ward = scored[i % scored.length].c;
        if (g.order.kind !== 'escort' || g.order.targetId !== ward.id) {
          g.order = { kind: 'escort', targetId: ward.id };
        }
      });
      continue;
    }

    // ---- plan d'attaque : tenir la position, puis avancer sur l'objectif ----
    if (kind === 'plan') {
      const lead = shipById(gs, f.leaderId);
      if (!lead) continue;
      const plan = gs.plans[f.team] ?? { filter: 'tout' as const, objective: null, armed: false };
      const staging = f.mission.pos;
      if (!plan.armed || !plan.objective) {
        // phase de mise en place : rejoindre la position et tenir la formation
        if (staging && dist(lead.pos, staging) > 30) {
          if (lead.order.kind !== 'move') lead.order = { kind: 'move', pos: { ...staging } };
        } else if (lead.order.kind === 'move' || lead.order.kind === 'idle') {
          lead.order = { kind: 'guard', pos: staging ? { ...staging } : { ...lead.pos } };
        }
      } else {
        // exécution : avancer vers l'objectif en engageant les cibles autorisées
        const targetId = planPickTarget(gs, f.team, lead.pos, plan.filter);
        if (targetId != null) {
          if (lead.order.kind !== 'attack' || lead.order.targetId !== targetId) {
            lead.order = { kind: 'attack', targetId };
          }
        } else if (dist(lead.pos, plan.objective) > 60) {
          if (lead.order.kind !== 'move') lead.order = { kind: 'move', pos: { ...plan.objective } };
        } else if (lead.order.kind !== 'guard') {
          lead.order = { kind: 'guard', pos: { ...plan.objective } };
        }
      }
      for (const id of f.members) {
        const mm = shipById(gs, id);
        if (mm && mm.order.kind !== 'attack' && (mm.order.kind !== 'escort' || mm.order.targetId !== lead.id)) {
          mm.order = { kind: 'escort', targetId: lead.id };
        }
      }
      continue;
    }

    // ---- patrouilles territoriales : couvrent TOUTES vos possessions ----
    const lead = shipById(gs, f.leaderId);
    if (!lead) continue;
    if (lead.order.kind !== 'move' && lead.order.kind !== 'attack') {
      // possessions : station, avant-postes, mines, labos, satellites, colonies
      const holdings: { pos: V2; r: number }[] = [
        ...gs.structures.filter(st => st.alive && st.team === f.team)
          .map(st => ({ pos: st.pos, r: st.stype === 'station' ? 340 : st.stype === 'avantposte' ? 260 : 160 })),
        ...gs.planets.filter(pl => pl.alive && pl.owner === f.team)
          .map(pl => ({ pos: pl.pos, r: 200 })),
      ];
      if (holdings.length === 0) continue;
      f.patrolAngle += 1;
      const h = holdings[Math.floor(f.patrolAngle) % holdings.length];
      let wp: V2;
      if (kind === 'patrol_border') {
        wp = add(h.pos, fromAngle(f.patrolAngle * 0.9 + gs.rng(), h.r + 30));
      } else if (kind === 'patrol_out') {
        // au large : entre la possession et l'espace ennemi le plus proche
        const foeSt = nearestStruct(gs, h.pos, x => isEnemy(f.team, x.team), Infinity);
        const dirOut = foeSt ? norm(sub(foeSt.pos, h.pos)) : norm(h.pos);
        wp = add(h.pos, add(scale(dirOut, h.r + 220), fromAngle(gs.rng() * Math.PI * 2, 80)));
      } else {
        wp = add(h.pos, fromAngle(gs.rng() * Math.PI * 2, 30 + gs.rng() * h.r * 0.5));
      }
      const dW = len(wp);
      if (dW > WORLD_R * 0.98) wp = scale(wp, WORLD_R * 0.98 / dW);
      lead.order = { kind: 'move', pos: wp };
      for (const id of f.members) {
        const mm = shipById(gs, id);
        if (mm && mm.order.kind !== 'attack' && (mm.order.kind !== 'escort' || mm.order.targetId !== lead.id)) {
          mm.order = { kind: 'escort', targetId: lead.id };
        }
      }
    }
  }
}

/** Cible autorisée par le plan la plus proche de `pos` (rayon d'engagement 300). */
function planPickTarget(gs: GameState, team: number, pos: V2, filter: PlanFilter): number | null {
  let best: number | null = null, bd = 300;
  const consider = (id: number, p2: V2) => {
    const d = dist(p2, pos);
    if (d < bd) { bd = d; best = id; }
  };
  if (filter === 'tout' || filter === 'armes') {
    for (const sh of gs.ships) {
      if (!sh.alive || !isEnemy(team, sh.team)) continue;
      if (filter === 'armes' && SHIP_CLASSES[sh.cls].civil) continue;
      if (!canDetect(gs, team, sh)) continue;
      consider(sh.id, sh.pos);
    }
  }
  if (filter !== 'armes') {
    for (const st of gs.structures) {
      if (!st.alive || !isEnemy(team, st.team)) continue;
      if (filter === 'stations' && st.stype !== 'station') continue;
      consider(st.id, st.pos);
    }
    if (filter === 'tout' || filter === 'structures') {
      for (const pl of gs.planets) {
        if (!pl.alive || pl.owner < 0 || !isEnemy(team, pl.owner)) continue;
        consider(pl.id, pl.pos);
      }
    }
  }
  return best;
}

// ================================================================
//  GARDES ORBITALES — achetées en vue tactique sur un corps possédé
// ================================================================
export function buyGuards(gs: GameState, teamId: number, targetId: number): string | null {
  const team = gs.teams[teamId];
  if (!team) return 'Équipe invalide';
  const body = structById(gs, targetId) ?? planetById(gs, targetId);
  if (!body) return 'Corps introuvable';
  const owner = body.kind === 'planet' ? body.owner : body.team;
  if (owner !== teamId) return 'Ce corps ne vous appartient pas';
  const station = structById(gs, team.stationId);
  if (!station) return 'Station détruite';
  const cost = GUARD_COST[station.level] ?? GUARD_COST[1];
  if (team.credits < cost) return 'Crédits insuffisants';
  team.credits -= cost;
  const comp = GUARD_COMP[station.level] ?? GUARD_COMP[1];
  comp.forEach((cls, i) => {
    const pos = add(body.pos, fromAngle((i / comp.length) * Math.PI * 2, body.radius + 36));
    const guard = makeShip(gs, teamId, cls, pos);
    guard.avoidSeed = (i / comp.length) * Math.PI * 2;
    guard.order = { kind: 'orbit', targetId: body.id };
    gs.fx.push({ type: 'saut', pos: { ...pos } });
  });
  addLog(gs, `Garde orbitale déployée (${comp.length} vaisseaux).`, team.cssColor);
  return null;
}

// ================================================================
//  COLOSSE — rayons automatiques à dégâts croissants, salve, Brise-Monde
// ================================================================
const rayHeat = new Map<string, number>();     // `${colosse}:${cible}` -> chauffe
const rayFxT = new Map<number, number>();      // throttle des effets par colosse
const colossusLocks = new Map<number, number[]>();

function updateColossus(gs: GameState, dt: number) {
  gs.colossusBeams.length = 0;
  for (const c of gs.ships) {
    if (!c.alive || c.cls !== 'colosse') continue;
    // cibles : jusqu'à 5 ennemis distincts à portée
    const targets: (Ship | Structure)[] = [];
    const candidates: (Ship | Structure)[] = [
      ...gs.ships.filter(x => x.alive && isEnemy(c.team, x.team) && x.cloakT <= 0 && x.smokeT <= 0
        && dist(x.pos, c.pos) < COLOSSE_RAY_RANGE),
      ...gs.structures.filter(x => x.alive && isEnemy(c.team, x.team)
        && dist(x.pos, c.pos) < COLOSSE_RAY_RANGE),
    ].sort((x, y) => dist(x.pos, c.pos) - dist(y.pos, c.pos));
    for (const t of candidates) {
      if (targets.length >= COLOSSE_RAY_COUNT) break;
      targets.push(t);
    }
    for (const t of targets) {
      if (c.energy < 6) break;
      const key = `${c.id}:${t.id}`;
      const heat = Math.min(4, (rayHeat.get(key) ?? 0) + dt);   // plus c'est long, plus ça brûle
      rayHeat.set(key, heat);
      const dmg = (7 + heat * 5) * dt;
      applyDamage(gs, t, dmg, c.team);
      c.energy = Math.max(0, c.energy - (2.2 + heat * 1.3) * dt);
      // faisceau continu : le rendu lit cet état à chaque frame
      gs.colossusBeams.push({ x1: c.pos.x, y1: c.pos.y, x2: t.pos.x, y2: t.pos.y, heat });
    }
    // refroidissement des cibles hors faisceau
    const hot = new Set(targets.map(t => `${c.id}:${t.id}`));
    for (const [key, h] of rayHeat) {
      if (key.startsWith(`${c.id}:`) && !hot.has(key)) {
        const nh = h - dt * 2;
        if (nh <= 0) rayHeat.delete(key); else rayHeat.set(key, nh);
      }
    }
  }
}

/** Verrouillage multiple de la salve (A maintenu sur le Colosse). */
export function colossusLockTick(gs: GameState, c: Ship, dt: number): { targets: number[]; progress: number; ready: boolean } {
  const w = WEAPONS.salve;
  if (c.weapons[0].cd > 0 || c.energy < w.energy) {
    c.lockT = 0;
    colossusLocks.delete(c.id);
    return { targets: [], progress: 0, ready: false };
  }
  const targets = gs.ships
    .filter(x => x.alive && isEnemy(c.team, x.team) && x.cloakT <= 0 && dist(x.pos, c.pos) < w.range)
    .sort((x, y) => dist(x.pos, c.pos) - dist(y.pos, c.pos))
    .slice(0, COLOSSE_SALVO_SIZE)
    .map(x => x.id);
  if (targets.length === 0) {
    c.lockT = 0;
    colossusLocks.delete(c.id);
    return { targets: [], progress: 0, ready: false };
  }
  colossusLocks.set(c.id, targets);
  c.lockT = Math.min(w.lockTime ?? 1.5, c.lockT + dt);
  const ready = c.lockT >= (w.lockTime ?? 1.5);
  return { targets, progress: c.lockT / (w.lockTime ?? 1.5), ready };
}

/** Relâchement de A : la salve part, un missile par cible verrouillée. */
export function colossusSalveRelease(gs: GameState, c: Ship): boolean {
  const w = WEAPONS.salve;
  const targets = colossusLocks.get(c.id) ?? [];
  const ready = c.lockT >= (w.lockTime ?? 1.5) && targets.length > 0
    && c.weapons[0].cd <= 0 && c.energy >= w.energy;
  if (ready) {
    c.weapons[0].cd = w.cd;
    c.energy -= w.energy;
    targets.forEach((tid, i) => {
      const t = shipById(gs, tid);
      const dir = t ? norm(sub(t.pos, c.pos)) : fromAngle(c.heading + i);
      const from = add(c.pos, fromAngle((i / COLOSSE_SALVO_SIZE) * Math.PI * 2, c.radius + 3));
      makeProjectile(gs, c.team, 'missile', from, scale(dir, w.speed ?? 160), w.dmg, 3.2, tid);
      gs.fx.push({ type: 'tir', pos: { ...from }, color: w.color, wid: 'missile' });
    });
  }
  c.lockT = 0;
  colossusLocks.delete(c.id);
  return ready;
}

/** État lisible du Colosse pour le HUD (salve + Brise-Monde). */
export function colossusStatus(gs: GameState, c: Ship): { salveCd: number; briseCd: number; briseEnergy: number; planetsInRange: number } {
  const w = WEAPONS.brise_monde;
  return {
    salveCd: c.weapons[0]?.cd ?? 0,
    briseCd: c.weapons[1]?.cd ?? 0,
    briseEnergy: w.energy,
    planetsInRange: gs.planets.filter(pl => pl.alive && pl.dyingT === 0 && dist(pl.pos, c.pos) < w.range).length,
  };
}

/** Le Brise-Monde (E) : effondre le noyau de la planète visée. */
export function colossusWorldBreaker(gs: GameState, c: Ship, aim: V2): string | null {
  const w = WEAPONS.brise_monde;
  const slot = c.weapons[1];
  if (!slot || slot.cd > 0) return 'Brise-Monde en recharge';
  if (c.energy < w.energy) return `Énergie insuffisante (${w.energy})`;
  let planet: Planet | null = null, bd = 120;
  for (const pl of gs.planets) {
    if (!pl.alive || pl.dyingT > 0) continue;
    if (dist(pl.pos, c.pos) > w.range) continue;
    const d = dist(pl.pos, aim) - pl.radius;
    if (d < bd) { bd = d; planet = pl; }
  }
  if (!planet) return 'Aucune planète à portée sous le curseur';
  slot.cd = w.cd;
  c.energy -= w.energy;
  planet.dyingT = 6;
  gs.fx.push({ type: 'frappe', pos: { ...planet.pos }, size: planet.radius });
  gs.fx.push({ type: 'rayon', pos: { ...c.pos }, pos2: { ...planet.pos }, color: 0xff2222, size: 6 });
  addLog(gs, `BRISE-MONDE : le noyau de ${planet.name} s'effondre !`, '#ff2222');
  return null;
}

// ================================================================
//  MISSILES — verrouillage et tir
// ================================================================
export function missileSlot(s: Ship): number {
  return s.weapons.findIndex(w => w.wid === 'missile');
}
export interface LockState { targetId: number; progress: number; ready: boolean }

/** Fait progresser le verrouillage du joueur (touche A maintenue). */
export function lockTick(gs: GameState, s: Ship, aim: V2, dt: number): LockState | null {
  const slot = missileSlot(s);
  if (slot < 0) return null;
  const w = WEAPONS.missile;
  if (s.weapons[slot].cd > 0 || s.energy < w.energy || s.empT > 0 || s.mode === 'croisiere' || s.mode === 'espion') {
    lockCancel(s);
    return { targetId: -1, progress: 0, ready: false };
  }
  // la cible est conservée tant qu'elle est valide ; sinon, la plus proche du curseur
  let target: Ship | Structure | undefined = shipById(gs, s.lockTargetId) ?? structById(gs, s.lockTargetId);
  if (!target || !isEnemy(s.team, target.team) || dist(target.pos, s.pos) > w.range * 1.15) {
    target = undefined;
    let bd = 160;
    for (const o of gs.ships) {
      if (!o.alive || !isEnemy(s.team, o.team) || o.cloakT > 0) continue;
      if (dist(o.pos, s.pos) > w.range) continue;
      const d = dist(o.pos, aim);
      if (d < bd) { bd = d; target = o; }
    }
    if (!target) {
      for (const o of gs.structures) {
        if (!o.alive || !isEnemy(s.team, o.team)) continue;
        if (dist(o.pos, s.pos) > w.range) continue;
        const d = dist(o.pos, aim);
        if (d < bd) { bd = d; target = o; }
      }
    }
    s.lockTargetId = target ? target.id : -1;
    s.lockT = 0;
  }
  if (s.lockTargetId < 0) return { targetId: -1, progress: 0, ready: false };
  s.lockT = Math.min(w.lockTime ?? 1.2, s.lockT + dt);
  return { targetId: s.lockTargetId, progress: s.lockT / (w.lockTime ?? 1.2), ready: s.lockT >= (w.lockTime ?? 1.2) };
}

/** Relâchement de A : tire si verrouillé, sinon annule. */
export function lockRelease(gs: GameState, s: Ship): boolean {
  const slot = missileSlot(s);
  const w = WEAPONS.missile;
  const canFire = slot >= 0 && s.lockT >= (w.lockTime ?? 1.2) && s.lockTargetId >= 0
    && s.weapons[slot].cd <= 0 && s.energy >= w.energy;
  if (canFire) fireMissile(gs, s, slot, s.lockTargetId);
  lockCancel(s);
  return canFire;
}
export function lockCancel(s: Ship) { s.lockT = 0; s.lockTargetId = -1; }

function fireMissile(gs: GameState, s: Ship, slot: number, targetId: number) {
  const w = WEAPONS.missile;
  s.weapons[slot].cd = w.cd;
  s.energy -= w.energy;
  if (s.cloakT > 0) s.cloakT = 0;
  const target = shipById(gs, targetId) ?? structById(gs, targetId);
  const dir = target ? norm(sub(target.pos, s.pos)) : fromAngle(s.heading);
  const from = add(s.pos, fromAngle(s.heading, s.radius + 2));
  makeProjectile(gs, s.team, 'missile', from, scale(dir, w.speed ?? 150), w.dmg, ((w.range) / (w.speed ?? 150)) * 1.6, targetId);
  gs.fx.push({ type: 'tir', pos: { ...from }, color: w.color, wid: 'missile' });
}

/** Distance du missile ennemi le plus proche qui nous traque (-1 si aucun). */
export function nearestIncomingMissile(gs: GameState, shipId: number): number {
  const ship = shipById(gs, shipId);
  if (!ship) return -1;
  let best = -1;
  for (const pr of gs.projectiles) {
    if (!pr.alive || pr.wid !== 'missile' || pr.homingId !== shipId) continue;
    const d = dist(pr.pos, ship.pos);
    if (best < 0 || d < best) best = d;
  }
  return best;
}
/** Un ennemi est-il en train de nous verrouiller ? */
export function enemyLockingShip(gs: GameState, shipId: number): boolean {
  return gs.ships.some(s => s.alive && s.id !== shipId && s.lockTargetId === shipId && s.lockT > 0);
}

// ================================================================
//  DIPLOMATIE
// ================================================================
export function formAlliance(gs: GameState, a: number, b: number) {
  gs.alliances.add(allyKey(a, b));
  gs.allianceSince[allyKey(a, b)] = gs.t;
  delete gs.allianceSince[allyKey(a, b) + ':warn'];
  // plus aucun ordre hostile entre nouveaux alliés
  const between = (t1: number, t2: number) => (t1 === a && t2 === b) || (t1 === b && t2 === a);
  for (const sh of gs.ships) {
    if (!sh.alive || sh.order.kind !== 'attack') continue;
    const tg = shipById(gs, sh.order.targetId ?? -1) ?? structById(gs, sh.order.targetId ?? -1) ?? planetById(gs, sh.order.targetId ?? -1);
    if (!tg) continue;
    const tTeam = tg.kind === 'planet' ? tg.owner : tg.team;
    if (between(sh.team, tTeam)) sh.order = { ...IDLE };
  }
  for (const f of gs.fleets) {
    if (f.mission.kind !== 'attack') continue;
    const tg = shipById(gs, f.mission.targetId ?? -1) ?? structById(gs, f.mission.targetId ?? -1) ?? planetById(gs, f.mission.targetId ?? -1);
    if (!tg) continue;
    const tTeam = tg.kind === 'planet' ? tg.owner : tg.team;
    if (between(f.team, tTeam)) f.mission = { ...IDLE };
  }
  addLog(gs, `Alliance conclue : ${gs.teams[a].name} + ${gs.teams[b].name}.`, '#6dff8a');
  if (a === gs.playerTeam || b === gs.playerTeam) setAlert(gs, 'ALLIANCE CONCLUE', 3.5, '#6dff8a');
}

export function breakAlliance(gs: GameState, a: number, b: number) {
  if (!gs.alliances.delete(allyKey(a, b))) return;
  delete gs.allianceSince[allyKey(a, b)];
  delete gs.allianceSince[allyKey(a, b) + ':warn'];
  delete gs.focusTargets[a];
  delete gs.focusTargets[b];
  addLog(gs, `L'alliance ${gs.teams[a].name} / ${gs.teams[b].name} est rompue.`, '#ff8c42');
}

export function aiAcceptsAlliance(gs: GameState, aiTeam: number, other: number): boolean {
  const persona = PERSONAS[gs.teams[aiTeam].persona];
  const my = teamScore(gs, aiTeam);
  const enemies = gs.activeTeams.filter(id =>
    gs.teams[id].alive && id !== aiTeam && id !== other && !areAllied(gs, aiTeam, id));
  if (enemies.length === 0) return false; // pas d'ennemi commun : aucune raison de s'allier
  const strongest = Math.max(...enemies.map(id => teamScore(gs, id)));
  if (strongest > my * 1.2) return true;  // menacé : accepte volontiers
  const friendly = 0.25 + persona.defense * 0.25 + persona.ecoFocus * 0.2 - persona.aggression * 0.25;
  return gs.rng() < Math.max(0.05, friendly);
}

/** Propose une alliance. Vers le joueur : crée une offre ; entre IA : résolution immédiate. */
export function proposeAlliance(gs: GameState, from: number, to: number): string | null {
  if (from === to || !gs.teams[to]?.alive || !gs.teams[from]?.alive) return 'Équipe invalide';
  if (areAllied(gs, from, to)) {
    // déjà alliés : renouvellement possible dans les 2 dernières minutes
    const key = allyKey(from, to);
    const age = gs.t - (gs.allianceSince[key] ?? 0);
    if (age > ALLIANCE_DURATION - 120) {
      gs.allianceSince[key] = gs.t;
      delete gs.allianceSince[key + ':warn'];
      addLog(gs, `Alliance ${gs.teams[from].name} / ${gs.teams[to].name} renouvelée pour 15 min.`, '#6dff8a');
      return null;
    }
    return 'Déjà alliés';
  }
  if (gs.diploOffers.some(o => o.type === 'alliance'
    && ((o.from === from && o.to === to) || (o.from === to && o.to === from)))) return 'Offre déjà en attente';
  if (to === gs.playerTeam && !gs.teams[to].isAI) {
    gs.diploOffers.push({ id: gs.nextId++, from, to, type: 'alliance', expiresT: gs.t + 25 });
    addLog(gs, `${gs.teams[from].name} vous propose une alliance.`, gs.teams[from].cssColor);
    return null;
  }
  if (aiAcceptsAlliance(gs, to, from)) formAlliance(gs, from, to);
  else if (from === gs.playerTeam) addLog(gs, `${gs.teams[to].name} refuse votre alliance.`, gs.teams[to].cssColor);
  return null;
}

/** Demande à un allié de cibler une équipe. */
export function requestFocus(gs: GameState, from: number, to: number, target: number): string | null {
  if (!areAllied(gs, from, to)) return 'Vous devez être alliés';
  if (!gs.teams[target]?.alive || areAllied(gs, to, target) || areAllied(gs, from, target)) return 'Cible invalide';
  if (to === gs.playerTeam && !gs.teams[to].isAI) {
    if (gs.diploOffers.some(o => o.type === 'target' && o.from === from && o.to === to)) return null;
    gs.diploOffers.push({ id: gs.nextId++, from, to, type: 'target', target, expiresT: gs.t + 25 });
    addLog(gs, `${gs.teams[from].name} vous demande de cibler ${gs.teams[target].name}.`, gs.teams[from].cssColor);
    return null;
  }
  const persona = PERSONAS[gs.teams[to].persona];
  if (gs.rng() < 0.4 + persona.aggression * 0.4) {
    gs.focusTargets[to] = target;
    gs.focusTargets[from] = target;
    addLog(gs, `${gs.teams[to].name} accepte de cibler ${gs.teams[target].name}.`, '#6dff8a');
  } else if (from === gs.playerTeam) {
    addLog(gs, `${gs.teams[to].name} décline votre requête.`, gs.teams[to].cssColor);
  }
  return null;
}

/** Demande à un allié de venir défendre notre base. */
export function requestDefend(gs: GameState, from: number, to: number): string | null {
  if (!areAllied(gs, from, to)) return 'Vous devez être alliés';
  const fromStation = structById(gs, gs.teams[from].stationId);
  if (!fromStation) return 'Votre station est détruite';
  if (to === gs.playerTeam && !gs.teams[to].isAI) {
    if (!gs.diploOffers.some(o => o.type === 'defend' && o.from === from && o.to === to)) {
      gs.diploOffers.push({ id: gs.nextId++, from, to, type: 'defend', expiresT: gs.t + 30 });
      addLog(gs, `${gs.teams[from].name} demande votre aide : sa base est attaquée !`, gs.teams[from].cssColor);
    }
    return null;
  }
  // l'IA dépêche une partie de ses vaisseaux de guerre en garde chez l'allié
  const persona = PERSONAS[gs.teams[to].persona];
  if (gs.rng() < 0.45 + persona.defense * 0.4) {
    const warships = gs.ships.filter(x => x.alive && x.team === to && SHIP_CLASSES[x.cls].power > 5 && !x.isFlagship);
    const sent = warships.slice(0, Math.max(2, Math.floor(warships.length / 2)));
    for (const w of sent) w.order = { kind: 'guard', pos: add(fromStation.pos, fromAngle(gs.rng() * Math.PI * 2, 80)) };
    addLog(gs, `${gs.teams[to].name} envoie ${sent.length} vaisseaux défendre votre base.`, '#6dff8a');
  } else if (from === gs.playerTeam) {
    addLog(gs, `${gs.teams[to].name} ne peut pas envoyer d'aide pour l'instant.`, gs.teams[to].cssColor);
  }
  return null;
}

export function acceptOffer(gs: GameState, offerId: number) {
  const o = gs.diploOffers.find(x => x.id === offerId);
  if (!o) return;
  gs.diploOffers = gs.diploOffers.filter(x => x.id !== offerId);
  if (o.type === 'alliance') {
    if (areAllied(gs, o.from, o.to)) {
      const key = allyKey(o.from, o.to);
      gs.allianceSince[key] = gs.t;
      delete gs.allianceSince[key + ':warn'];
      addLog(gs, 'Alliance renouvelée pour 15 min.', '#6dff8a');
    } else {
      formAlliance(gs, o.from, o.to);
    }
  } else if (o.type === 'defend') {
    addLog(gs, `Vous avez promis d'aider ${gs.teams[o.from].name} — leur base est en difficulté.`, gs.teams[o.from].cssColor);
  } else if (o.type === 'target' && o.target != null) {
    gs.focusTargets[o.to] = o.target;
    gs.focusTargets[o.from] = o.target;
    addLog(gs, `Cible commune convenue : ${gs.teams[o.target].name}.`, '#6dff8a');
  }
}

export function refuseOffer(gs: GameState, offerId: number) {
  const o = gs.diploOffers.find(x => x.id === offerId);
  if (!o) return;
  gs.diploOffers = gs.diploOffers.filter(x => x.id !== offerId);
  addLog(gs, `Vous déclinez l'offre de ${gs.teams[o.from].name}.`, '#8fa8c8');
}
