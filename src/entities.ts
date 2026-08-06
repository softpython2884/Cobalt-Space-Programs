// ============ COBALT SECTOR — constructeurs d'entités & requêtes spatiales ============
import {
  GameState, Ship, Structure, Planet, Roid, GasCloud, Wreck, Projectile, MineEnt,
  ShipClassId, StructType, PlanetType, MineType, V2, v2, IDLE, dist, PIRATE_TEAM, Res,
} from './core';
import { SHIP_CLASSES, STRUCTS, UPGRADES } from './data';

export function makeShip(gs: GameState, team: number, cls: ShipClassId, pos: V2, heading = 0): Ship {
  const def = SHIP_CLASSES[cls];
  const ship: Ship = {
    id: gs.nextId++, kind: 'ship', team, cls,
    pos: { ...pos }, vel: v2(), heading,
    radius: def.radius,
    hull: def.hull, hullMax: def.hull,
    shield: def.shield, shieldMax: def.shield,
    energy: def.energy, energyMax: def.energy,
    weapons: def.weapons.map(wid => ({ wid, cd: 0 })),
    cargo: { roche: 0, minerai: 0, gaz: 0 }, cargoMax: def.cargo,
    mineType: def.mineType, mineCount: def.mineMax, mineMax: def.mineMax,
    order: { ...IDLE }, fleetId: null,
    mode: 'normal',
    stasisT: 0, empT: 0, cloakT: 0, smokeT: 0, invulnT: 0, jumpT: 0,
    lastDmgT: -999, aiCd: gs.rng() * 0.5, avoidSeed: gs.rng() * 100,
    isFlagship: false, alive: true, supportT: 0, lockT: 0, lockTargetId: -1,
    miningRes: null, colonizeT: 0, tradePhase: 0, kills: 0,
  };
  gs.ships.push(ship);
  return ship;
}

/** Applique les améliorations persistantes de l'équipe au vaisseau (amiral). */
export function applyUpgrades(gs: GameState, ship: Ship) {
  const team = gs.teams[ship.team];
  if (!team) return;
  for (const u of UPGRADES) {
    const lvl = team.upgrades[u.id] ?? 0;
    if (lvl <= 0) continue;
    const m = 1 + u.mult * lvl;
    if (u.id === 'coque') { ship.hullMax = Math.round(ship.hullMax * m); ship.hull = ship.hullMax; }
    if (u.id === 'bouclier') { ship.shieldMax = Math.round(ship.shieldMax * m); ship.shield = ship.shieldMax; }
    if (u.id === 'energie') { ship.energyMax = Math.round(ship.energyMax * m); ship.energy = ship.energyMax; }
    if (u.id === 'soute') { ship.cargoMax = Math.round(ship.cargoMax * m); }
    // moteur : lu dynamiquement dans la sim via speedMult()
  }
}

export function speedMult(gs: GameState, ship: Ship): number {
  const team = gs.teams[ship.team];
  let m = 1;
  if (team && ship.isFlagship) m += 0.18 * (team.upgrades['moteur'] ?? 0);
  if (ship.mode === 'croisiere') m *= 1.7;
  if (ship.mode === 'radar') m *= 0.6;
  if (ship.stasisT > 0) m *= 0.45;
  return m;
}

export function makeStructure(gs: GameState, team: number, stype: StructType, pos: V2): Structure {
  const def = STRUCTS[stype];
  const st: Structure = {
    id: gs.nextId++, kind: 'structure', team, stype,
    pos: { ...pos }, radius: def.radius,
    hull: def.hull, hullMax: def.hull,
    shield: def.shield, shieldMax: def.shield,
    level: 1, fireCd: 0, incomeT: 0, lastDmgT: -999, pendingCredits: 0, pendingAllied: {}, buildT: 0, alive: true,
  };
  gs.structures.push(st);
  return st;
}

export function makePlanet(gs: GameState, ptype: PlanetType, name: string, pos: V2, radius: number): Planet {
  const p: Planet = {
    id: gs.nextId++, kind: 'planet', ptype, name,
    pos: { ...pos }, radius,
    owner: -1, colonyHp: 0, colonyHpMax: 220, incomeT: 0, dyingT: 0, alive: true,
  };
  gs.planets.push(p);
  return p;
}

export function makeRoid(gs: GameState, rtype: 'roche' | 'minerai', pos: V2, radius: number, amount: number): Roid {
  const r: Roid = { id: gs.nextId++, kind: 'roid', rtype, pos: { ...pos }, radius, amount, alive: true };
  gs.roids.push(r);
  return r;
}

export function makeCloud(gs: GameState, pos: V2, radius: number, amount: number): GasCloud {
  const c: GasCloud = { id: gs.nextId++, kind: 'gas', pos: { ...pos }, radius, amount, alive: true };
  gs.clouds.push(c);
  return c;
}

export function makeWreck(gs: GameState, pos: V2, value: number, cls: ShipClassId): Wreck {
  const w: Wreck = { id: gs.nextId++, kind: 'wreck', pos: { ...pos }, value, t: 60, cls, alive: true };
  gs.wrecks.push(w);
  return w;
}

export function makeProjectile(gs: GameState, team: number, wid: Projectile['wid'], pos: V2, vel: V2, dmg: number, ttl: number, homingId: number | null = null): Projectile {
  const p: Projectile = { id: gs.nextId++, team, wid, pos: { ...pos }, vel: { ...vel }, ttl, dmg, homingId, alive: true };
  gs.projectiles.push(p);
  return p;
}

export function makeMineEnt(gs: GameState, team: number, mtype: MineType, pos: V2, fuse: number, vel: V2 = v2()): MineEnt {
  const m: MineEnt = { id: gs.nextId++, team, mtype, pos: { ...pos }, vel: { ...vel }, timer: fuse, armed: 0.6, alive: true };
  gs.minesArmed.push(m);
  return m;
}

// ---------- Requêtes ----------
// Vérification d'alliance : la sim l'actualise à chaque tick (setAllianceCheck).
let alliedCheck: (a: number, b: number) => boolean = () => false;
export function setAllianceCheck(f: (a: number, b: number) => boolean) { alliedCheck = f; }
export const isEnemy = (a: number, b: number) => a !== b && a >= 0 && b >= 0 && !alliedCheck(a, b);

export function shipsOfTeam(gs: GameState, team: number): Ship[] {
  return gs.ships.filter(s => s.alive && s.team === team);
}

export function nearestShip(gs: GameState, pos: V2, pred: (s: Ship) => boolean, maxD = Infinity): Ship | null {
  let best: Ship | null = null, bd = maxD;
  for (const s of gs.ships) {
    if (!s.alive || !pred(s)) continue;
    const d = dist(s.pos, pos);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

export function nearestStruct(gs: GameState, pos: V2, pred: (s: Structure) => boolean, maxD = Infinity): Structure | null {
  let best: Structure | null = null, bd = maxD;
  for (const s of gs.structures) {
    if (!s.alive || !pred(s)) continue;
    const d = dist(s.pos, pos);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

export function nearestRoid(gs: GameState, pos: V2, maxD = Infinity): Roid | null {
  let best: Roid | null = null, bd = maxD;
  for (const r of gs.roids) {
    if (!r.alive || r.amount <= 0) continue;
    const d = dist(r.pos, pos);
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}

export function nearestCloud(gs: GameState, pos: V2, maxD = Infinity): GasCloud | null {
  let best: GasCloud | null = null, bd = maxD;
  for (const c of gs.clouds) {
    if (!c.alive || c.amount <= 0) continue;
    const d = dist(c.pos, pos);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/** Signature détectable du vaisseau (modes espion/camouflage la réduisent). */
export function signature(s: Ship): number {
  let sig = 1;
  if (s.mode === 'espion') sig *= 0.35;
  if (s.mode === 'radar') sig *= 2;
  if (s.smokeT > 0) sig *= 0.12;   // caché dans un écran de fumée
  if (s.cloakT > 0) sig = 0;
  return sig;
}

/** `viewer` (équipe) détecte-t-il le vaisseau `target` ? */
export function canDetect(gs: GameState, viewerTeam: number, target: Ship): boolean {
  if (target.team === viewerTeam) return true;
  if (alliedCheck(viewerTeam, target.team)) return true;
  const sig = signature(target);
  if (sig <= 0) return false;
  // vision partagée : les capteurs des alliés comptent aussi
  const sees = (team: number) => team === viewerTeam || alliedCheck(viewerTeam, team);
  for (const s of gs.ships) {
    if (!s.alive || !sees(s.team) || s.team === target.team) continue;
    let range = SHIP_CLASSES[s.cls].sensor * sig;
    if (s.mode === 'radar') range *= 2;
    if (dist(s.pos, target.pos) < range) return true;
  }
  for (const st of gs.structures) {
    if (!st.alive || !sees(st.team) || st.team === target.team) continue;
    if (dist(st.pos, target.pos) < STRUCTS[st.stype].sensor * sig) return true;
  }
  return false;
}

/** Puissance de combat cumulée des ennemis de `team` dans un rayon autour de `pos` (pour la fuite pirate). */
export function threatAround(gs: GameState, team: number, pos: V2, radius: number): number {
  let sum = 0;
  for (const s of gs.ships) {
    if (!s.alive || s.team === team || s.team < 0) continue;
    if (dist(s.pos, pos) < radius) sum += SHIP_CLASSES[s.cls].power;
  }
  for (const st of gs.structures) {
    if (!st.alive || st.team === team || st.team < 0 || st.team === PIRATE_TEAM) continue;
    if (STRUCTS[st.stype].weaponDmg > 0 && dist(st.pos, pos) < radius) sum += 15;
  }
  return sum;
}

export function cargoTotal(s: Ship): number {
  return s.cargo.roche + s.cargo.minerai + s.cargo.gaz;
}

export function addCargo(s: Ship, res: Res, amount: number): number {
  const free = s.cargoMax - cargoTotal(s);
  const take = Math.min(free, amount);
  s.cargo[res] += take;
  return take;
}
