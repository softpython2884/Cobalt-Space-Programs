// ============ COBALT SECTOR — ordres, flottes, formations ============
import {
  GameState, Ship, Fleet, FormationId, Order, V2, v2, fromAngle, shipById, addLog, IDLE,
} from './core';
import { SHIP_CLASSES } from './data';

let fleetCounter = 1;
/** À appeler au démarrage d'une nouvelle partie. */
export function resetFleetCounter() { fleetCounter = 1; }

/** Crée une flotte à partir d'ids de vaisseaux ; le plus puissant devient chef. */
export function createFleet(gs: GameState, team: number, shipIds: number[], formation: FormationId = 'coin'): Fleet | null {
  const ships = shipIds.map(id => shipById(gs, id)).filter((s): s is Ship => !!s && s.team === team);
  if (ships.length < 2) return null;
  // retire de leurs anciennes flottes
  for (const s of ships) removeFromFleet(gs, s);
  ships.sort((a, b) => SHIP_CLASSES[b.cls].power - SHIP_CLASSES[a.cls].power);
  const leader = ships[0];
  const fleet: Fleet = {
    id: gs.nextId++,
    team,
    name: `Flotte ${fleetCounter++}`,
    leaderId: leader.id,
    members: ships.slice(1).map(s => s.id),
    formation,
    mission: { ...IDLE },
    patrolAngle: 0,
    stance: 'feu',
  };
  for (const s of ships) s.fleetId = fleet.id;
  gs.fleets.push(fleet);
  addLog(gs, `${fleet.name} créée (${ships.length} vaisseaux).`, gs.teams[team]?.cssColor);
  return fleet;
}

export function disbandFleet(gs: GameState, fleetId: number) {
  const f = gs.fleets.find(f => f.id === fleetId);
  if (!f) return;
  for (const id of [f.leaderId, ...f.members]) {
    const s = shipById(gs, id);
    if (s) { s.fleetId = null; s.order = { ...IDLE }; }
  }
  gs.fleets = gs.fleets.filter(x => x.id !== fleetId);
}

export function removeFromFleet(gs: GameState, ship: Ship) {
  if (ship.fleetId == null) return;
  const f = gs.fleets.find(f => f.id === ship.fleetId);
  ship.fleetId = null;
  if (!f) return;
  f.members = f.members.filter(id => id !== ship.id);
  if (f.leaderId === ship.id) {
    // promeut un membre, sinon dissout
    const next = f.members.map(id => shipById(gs, id)).find(s => !!s);
    if (next) {
      f.leaderId = next.id;
      f.members = f.members.filter(id => id !== next.id);
      // le nouveau chef reprend la mission, les membres le suivent
      next.order = { ...f.mission, pos: f.mission.pos ? { ...f.mission.pos } : undefined };
      for (const id of f.members) {
        const m = shipById(gs, id);
        if (m) m.order = { kind: 'escort', targetId: next.id };
      }
    } else {
      gs.fleets = gs.fleets.filter(x => x.id !== f.id);
    }
  }
  if (f.members.length === 0 && !shipById(gs, f.leaderId)) {
    gs.fleets = gs.fleets.filter(x => x.id !== f.id);
  }
}

export function fleetShips(gs: GameState, f: Fleet): Ship[] {
  const out: Ship[] = [];
  const lead = shipById(gs, f.leaderId);
  if (lead) out.push(lead);
  for (const id of f.members) {
    const s = shipById(gs, id);
    if (s) out.push(s);
  }
  return out;
}

/** Position de formation du membre `idx` (0-based, hors chef) autour du chef. */
export function formationOffset(formation: FormationId, idx: number, spacing = 22): V2 {
  const i = idx + 1;
  switch (formation) {
    case 'ligne': {
      // aile gauche / droite alternée sur une ligne perpendiculaire au cap
      const side = i % 2 === 1 ? 1 : -1;
      const rank = Math.ceil(i / 2);
      return v2(0, side * rank * spacing);
    }
    case 'colonne':
      return v2(-i * spacing, 0);
    case 'coin': {
      const side = i % 2 === 1 ? 1 : -1;
      const rank = Math.ceil(i / 2);
      return v2(-rank * spacing * 0.9, side * rank * spacing * 0.8);
    }
    case 'cercle': {
      // demi-cercle derrière le chef, par anneaux de 6
      const slot = idx % 6, ring = 1 + Math.floor(idx / 6);
      const arc = Math.PI * 1.1;
      const t = slot / 5;
      return fromAngle(Math.PI - arc / 2 + t * arc, ring * spacing * 1.4);
    }
  }
}

/** Position monde visée par le membre idx d'une flotte (formation orientée selon le cap du chef). */
export function formationWorldPos(leader: Ship, formation: FormationId, idx: number): V2 {
  const off = formationOffset(formation, idx);
  const c = Math.cos(leader.heading), s = Math.sin(leader.heading);
  return {
    x: leader.pos.x + off.x * c - off.y * s,
    y: leader.pos.y + off.x * s + off.y * c,
  };
}

/** Donne un ordre à une flotte : le chef reçoit la mission, les membres suivent en formation. */
export function setFleetMission(gs: GameState, fleet: Fleet, mission: Order) {
  fleet.mission = mission;
  const lead = shipById(gs, fleet.leaderId);
  if (lead) lead.order = { ...mission };
  // les membres reçoivent 'escort' vers le chef ; la sim les tient en formation
  for (const id of fleet.members) {
    const s = shipById(gs, id);
    if (s) s.order = { kind: 'escort', targetId: fleet.leaderId };
  }
}

/** Donne un ordre à une liste de vaisseaux (sélection) : gère les flottes entières si le chef est inclus. */
export function issueOrder(gs: GameState, shipIds: number[], order: Order) {
  const done = new Set<number>();
  for (const id of shipIds) {
    if (done.has(id)) continue;
    const s = shipById(gs, id);
    if (!s) continue;
    if (s.fleetId != null) {
      const f = gs.fleets.find(f => f.id === s.fleetId);
      if (f && f.leaderId === s.id) {
        setFleetMission(gs, f, order);
        for (const mid of [f.leaderId, ...f.members]) done.add(mid);
        continue;
      }
    }
    s.order = { ...order, pos: order.pos ? { ...order.pos } : undefined };
    s.tradePhase = 0;
    s.colonizeT = 0;
    done.add(id);
  }
}

export function missionLabel(gs: GameState, f: Fleet): string {
  const m = f.mission;
  switch (m.kind) {
    case 'attack': return 'Attaque';
    case 'escort': {
      const other = gs.fleets.find(x => x.leaderId === m.targetId);
      return other ? `Escorte ${other.name}` : 'Escorte';
    }
    case 'mine': return 'Minage';
    case 'trade': return 'Commerce';
    case 'move': return 'Déplacement';
    case 'guard': return 'Garde';
    case 'colonize': return 'Colonisation';
    case 'mine_auto': return 'Minage auto';
    case 'patrol_in': return 'Patrouille int.';
    case 'patrol_border': return 'Patrouille bordure';
    case 'patrol_out': return 'Patrouille ext.';
    case 'protect': return 'Protection amiral';
    case 'trade_auto': return 'Commerce auto';
    case 'patrol_civil': return 'Patrouille civile';
    case 'plan': return 'Plan d\'attaque';
    case 'orbit': return 'Garde orbitale';
    default: return 'En attente';
  }
}
