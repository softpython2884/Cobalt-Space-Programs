// ============ COBALT SECTOR — serveur multijoueur (LAN & en ligne) ============
// Serveur AUTORITAIRE : il exécute la vraie simulation (les mêmes modules que le
// jeu) et diffuse des instantanés ~12 Hz. Les clients envoient entrées + commandes.
//
//   npm run server        → ws://<ip>:17771 (+ sert dist/ en HTTP si présent)
//
// LAN : lancez-le sur n'importe quel PC du réseau. En ligne : sur la machine
// dédiée — mêmes trois modes côté client : Partie rapide / Créer un salon / Code.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { GameState, MatchConfig, FxEvent, V2, SIM_DT, Stance, PlanFilter, OrderKind, shipById } from '../src/core';
import { newGame } from '../src/world';
import {
  simTick, applyHumanInput, missileFireCmd, salveFireCmd, colossusWorldBreaker,
  tryBuyShip, tryBuyUpgrade, tryBuyWeapon, tryBuyGadget, tryUpgradeStation, tryBuyStationUpgrade, tryUpgradeOutpost,
  placeStructure, tryUpgradePlanet, buyGuards, activateGadget, toggleMode, tryJump,
  takeControlNearest, dropMine, flagshipOf,
  proposeAlliance, breakAlliance, requestFocus, requestDefend, acceptOffer, refuseOffer,
} from '../src/sim';
import { issueOrder, createFleet, disbandFleet, setFleetMission, fleetShips, assignMission } from '../src/orders';
import { encodeSnap, InputMsg } from '../src/netcodec';

const PORT = Number(process.env.PORT ?? 17771);
const SNAP_HZ = 12;

interface Player {
  ws: WebSocket;
  name: string;
  team: number;
  token: string;             // jeton de session : permet la reconnexion après coupure
  input: InputMsg;
  prevInput: InputMsg;
}
interface Room {
  code: string;
  isPublic: boolean;
  quick: boolean;            // partie rapide : départ automatique après décompte
  autoStartAt: number;       // horodatage du départ auto (0 = désactivé)
  players: Player[];
  gone: { name: string; team: number; token: string }[];  // déconnectés en cours de partie
  emptyAt: number;           // salon vidé en pleine partie : survit 3 min pour la reconnexion
  hostCfg: MatchConfig;
  gs: GameState | null;
  fxBuf: FxEvent[];
  loop: NodeJS.Timeout | null;
  snapAcc: number;
  snapSeq: number;           // cadence complet/léger : 1 instantané complet sur 12 (~1 Hz)
}

const REJOIN_GRACE_MS = 180_000;

/** Capacité HUMAINE du salon : le « nombre de joueurs » choisi à la création
 *  (2..9) ; les humains remplissent, le reste devient des IA au lancement. */
function roomCap(room: Room): number {
  return Math.max(2, Math.min(9, room.hostCfg.teamCount ?? 4));
}

function onlineCount(): number {
  let n = 0;
  for (const r of rooms.values()) n += r.players.length;
  return n;
}

const rooms = new Map<string, Room>();

const newCode = (): string => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  do {
    c = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(c));
  return c;
};

const send = (ws: WebSocket, o: unknown) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
};

const emptyInput = (): InputMsg => ({ thrust: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, fireE: false, mineF: false });

function broadcastLobby(room: Room) {
  const players = room.players.map((p, i) => ({ name: p.name, team: p.team, host: i === 0 }));
  const cd = room.autoStartAt > 0 ? Math.max(0, Math.ceil((room.autoStartAt - Date.now()) / 1000)) : null;
  room.players.forEach((p, i) => {
    send(p.ws, { t: 'lobby', code: room.code, players, you: p.team, host: i === 0 && !room.quick, cd });
  });
}

function joinRoom(room: Room, ws: WebSocket, name: string, token: string) {
  if (room.gs) { send(ws, { t: 'err', msg: 'La partie a déjà commencé' }); return; }
  if (room.players.length >= roomCap(room)) { send(ws, { t: 'err', msg: 'Salon complet' }); return; }
  const taken = new Set(room.players.map(p => p.team));
  let team = 0;
  while (taken.has(team)) team++;
  room.players.push({ ws, name: name.slice(0, 16) || 'Amiral', team, token, input: emptyInput(), prevInput: emptyInput() });
  (ws as any).room = room;
  // partie rapide : décompte lancé dès le premier joueur, départ immédiat une fois plein
  if (room.quick) {
    if (room.autoStartAt === 0) room.autoStartAt = Date.now() + 25000;
    if (room.players.length >= roomCap(room)) { startRoom(room); return; }
  }
  broadcastLobby(room);
}

function startRoom(room: Room) {
  const humans = room.players.map(p => p.team);
  // le « nombre de joueurs » choisi définit le TOTAL d'équipes :
  // les humains présents d'abord, l'IA comble les sièges vides
  const total = Math.max(roomCap(room), humans.length);
  const cfg: MatchConfig = {
    ...room.hostCfg,
    seed: Math.floor(Math.random() * 1e9),
    humanTeams: humans,
    multiplayer: true,
    teamCount: total,
    aiCount: Math.max(0, total - humans.length),
  };
  room.gs = newGame(cfg);
  room.fxBuf = [];
  room.snapAcc = 0;
  room.snapSeq = -1;   // le tout premier instantané diffusé est COMPLET
  const names: Record<number, string> = {};
  for (const p of room.players) names[p.team] = p.name;
  room.players.forEach(p => send(p.ws, { t: 'start', you: p.team, names }));

  let last = Date.now();
  let acc = 0;
  room.loop = setInterval(() => {
    const gs = room.gs!;
    const now = Date.now();
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    while (acc >= SIM_DT) {
      // entrées humaines : mouvements/tirs continus + fronts montants/descendants
      for (const p of room.players) {
        applyHumanInput(gs, p.team, p.input, SIM_DT);
        p.prevInput = p.input;
      }
      simTick(gs, SIM_DT);
      if (gs.fx.length) { room.fxBuf.push(...gs.fx); gs.fx.length = 0; }
      acc -= SIM_DT;
    }
    room.snapAcc += 1;
    if (room.snapAcc >= Math.round(60 / SNAP_HZ)) {
      room.snapAcc = 0;
      // 1 instantané COMPLET par seconde, le reste en LÉGER (sans le décor statique) :
      // avec beaucoup de vaisseaux, le tuyau ne sature plus → fini les mini-freezes
      room.snapSeq = (room.snapSeq + 1) % 12;
      const snap = encodeSnap(gs, room.fxBuf.splice(0, 200), room.snapSeq === 0);
      for (const p of room.players) {
        if (p.ws.readyState !== WebSocket.OPEN) continue;
        // anti-rafale : si la connexion du joueur est déjà engorgée, on saute
        // cet instantané pour lui plutôt que d'empiler du retard (cause des « rollbacks »)
        if (p.ws.bufferedAmount > 250_000) continue;
        p.ws.send(snap);
      }
    }
    if (gs.status === 'over') {
      // dernier instantané (complet) puis fermeture douce du salon
      const snap = encodeSnap(gs, room.fxBuf.splice(0, 200), true);
      for (const p of room.players) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(snap);
      clearInterval(room.loop!);
      room.loop = null;
    }
  }, 1000 / 60);
}

// ---------- Commandes de jeu (whitelist, l'équipe est celle de l'expéditeur) ----------
function runCmd(gs: GameState, team: number, name: string, a: any): string | null {
  const own = (ids: number[]) => ids.filter(id => shipById(gs, id)?.team === team);
  switch (name) {
    case 'buyShip': return tryBuyShip(gs, team, a.cls, !!a.pilot);
    case 'buyUpgrade': return tryBuyUpgrade(gs, team, a.id);
    case 'buyWeapon': return tryBuyWeapon(gs, team, a.wid);
    case 'buyGadget': return tryBuyGadget(gs, team, a.gid);
    case 'upgradeStation': return tryUpgradeStation(gs, team);
    case 'stationUp': return tryBuyStationUpgrade(gs, team, String(a.id));
    case 'outpostUp': return tryUpgradeOutpost(gs, team, Number(a.structId));
    case 'place': return placeStructure(gs, team, a.stype, a.pos);
    case 'planetUp': return tryUpgradePlanet(gs, team, a.planetId);
    case 'guards': return buyGuards(gs, team, a.targetId);
    case 'gadget': return activateGadget(gs, team, a.gid, a.targetId);
    case 'mode': {
      const f = flagshipOf(gs, team);
      if (!f) return 'Aucun vaisseau';
      if (a.mode === 'saut') return tryJump(gs, f);
      toggleMode(gs, f, a.mode);
      return null;
    }
    case 'takeControl': return takeControlNearest(gs, team);
    case 'mine': {
      const f = flagshipOf(gs, team);
      return f && dropMine(gs, f, a.aim) ? null : 'Aucune mine disponible';
    }
    case 'order': { issueOrder(gs, own(a.ids ?? []), a.order); return null; }
    case 'protect': {
      for (const id of own(a.ids ?? [])) {
        const sh = shipById(gs, id);
        if (sh) sh.order = { kind: 'orbit', targetId: a.targetId };
      }
      return null;
    }
    case 'fleetCreate': return createFleet(gs, team, own(a.ids ?? []), a.formation) ? null : 'Sélection invalide';
    case 'fleetDisband': {
      const f = gs.fleets.find(x => x.id === a.fleetId && x.team === team);
      if (f) disbandFleet(gs, f.id);
      return null;
    }
    case 'fleetMission': {
      const f = gs.fleets.find(x => x.id === a.fleetId && x.team === team);
      if (f) setFleetMission(gs, f, a.mission);
      return null;
    }
    case 'autoMission': return assignMission(gs, team, own(a.ids ?? []), a.mission);
    case 'fleetFormation': {
      const f = gs.fleets.find(x => x.id === a.fleetId && x.team === team);
      if (f) f.formation = a.frm;
      return null;
    }
    case 'fleetStance': {
      const f = gs.fleets.find(x => x.id === a.fleetId && x.team === team);
      if (f) f.stance = a.stance as Stance;
      return null;
    }
    case 'planFilter': gs.plans[team].filter = a.filter as PlanFilter; return null;
    case 'planObjective': gs.plans[team].objective = a.pos; gs.plans[team].armed = false; return null;
    case 'planArm': gs.plans[team].armed = true; return null;
    case 'planClear': {
      gs.plans[team] = { filter: 'tout', objective: null, armed: false };
      for (const f of gs.fleets) {
        if (f.team === team && f.mission.kind === 'plan') setFleetMission(gs, f, { kind: 'idle' });
      }
      return null;
    }
    case 'missileFire': return missileFireCmd(gs, team, a.targetId);
    case 'salveFire': return salveFireCmd(gs, team, a.targets ?? []);
    case 'breaker': {
      const f = flagshipOf(gs, team);
      return f ? colossusWorldBreaker(gs, f, a.aim) : 'Aucun vaisseau';
    }
    case 'diploPropose': return proposeAlliance(gs, team, a.team);
    case 'diploBreak': breakAlliance(gs, team, a.team); return null;
    case 'diploFocus': return requestFocus(gs, team, a.team, a.target);
    case 'diploDefend': return requestDefend(gs, team, a.team);
    case 'offerAccept': acceptOffer(gs, a.id); return null;
    case 'offerRefuse': refuseOffer(gs, a.id); return null;
    default: return `Commande inconnue : ${name}`;
  }
}

// ---------- HTTP (sert dist/ si buildé) + WebSocket ----------
const DIST = path.resolve(process.cwd(), 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];
  // compteur affiché sur l'écran d'accueil (« X joueurs en ligne »)
  if (urlPath === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ online: onlineCount(), rooms: rooms.size }));
    return;
  }
  const file = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);
  if (fs.existsSync(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('COBALT SECTOR — serveur multijoueur actif.\nBuildez le client (npm run build) pour le servir ici.');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { return; }
    const room: Room | undefined = (ws as any).room;
    switch (m.t) {
      case 'quick': {
        let target = [...rooms.values()].find(r => r.isPublic && !r.gs && r.players.length < roomCap(r));
        if (!target) {
          target = { code: newCode(), isPublic: true, quick: true, autoStartAt: 0, players: [], gone: [], emptyAt: 0, hostCfg: m.cfg, gs: null, fxBuf: [], loop: null, snapAcc: 0, snapSeq: -1 };
          rooms.set(target.code, target);
        }
        joinRoom(target, ws, m.name, String(m.token ?? ''));
        break;
      }
      case 'create': {
        const r: Room = { code: newCode(), isPublic: !!m.public, quick: false, autoStartAt: 0, players: [], gone: [], emptyAt: 0, hostCfg: m.cfg, gs: null, fxBuf: [], loop: null, snapAcc: 0, snapSeq: -1 };
        rooms.set(r.code, r);
        joinRoom(r, ws, m.name, String(m.token ?? ''));
        break;
      }
      case 'join': {
        const r = rooms.get(String(m.code ?? '').toUpperCase());
        if (!r) { send(ws, { t: 'err', msg: 'Salon introuvable' }); return; }
        joinRoom(r, ws, m.name, String(m.token ?? ''));
        break;
      }
      case 'rejoin': {
        // panne de connexion : le jeton de session redonne au joueur son équipe,
        // que l'IA pilotait en intérim depuis la coupure
        const token = String(m.token ?? '');
        let target: Room | undefined, ghost: Room['gone'][number] | undefined;
        if (token) {
          for (const r of rooms.values()) {
            const g = r.gone.find(g2 => g2.token === token);
            if (g && r.gs && r.gs.status === 'playing') { target = r; ghost = g; break; }
          }
        }
        if (!target || !ghost || !target.gs) { send(ws, { t: 'err', msg: 'Partie introuvable (terminée ou expirée)' }); return; }
        target.gone = target.gone.filter(g2 => g2 !== ghost);
        target.emptyAt = 0;
        target.players.push({ ws, name: ghost.name, team: ghost.team, token, input: emptyInput(), prevInput: emptyInput() });
        (ws as any).room = target;
        const t2 = target.gs.teams[ghost.team];
        if (t2) t2.isAI = false;
        const names: Record<number, string> = {};
        for (const pl of target.players) names[pl.team] = pl.name;
        send(ws, { t: 'start', you: ghost.team, names });
        ws.send(encodeSnap(target.gs, [], true));   // instantané complet immédiat
        console.log(`reconnexion : ${ghost.name} retrouve le salon ${target.code}`);
        break;
      }
      case 'count': {
        send(ws, { t: 'count', n: onlineCount() });
        break;
      }
      case 'start': {
        if (room && !room.gs && room.players[0]?.ws === ws) {
          if (room.players.length < 1) return;
          startRoom(room);
        }
        break;
      }
      case 'in': {
        if (room?.gs) {
          const p = room.players.find(p => p.ws === ws);
          if (p) p.input = m.i;
        }
        break;
      }
      case 'cmd': {
        if (room?.gs && room.gs.status === 'playing') {
          const p = room.players.find(p => p.ws === ws);
          if (!p) return;
          try {
            const err = runCmd(room.gs, p.team, String(m.name), m.args ?? {});
            if (err) send(ws, { t: 'hint', msg: err });
          } catch (e) {
            console.error('cmd error', m.name, e);
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const room: Room | undefined = (ws as any).room;
    if (!room) return;
    const idx = room.players.findIndex(p => p.ws === ws);
    if (idx < 0) return;
    const [p] = room.players.splice(idx, 1);
    // en partie : l'IA prend le relais, mais la place reste réservée (jeton)
    if (room.gs && room.gs.status === 'playing') {
      room.gone.push({ name: p.name, team: p.team, token: p.token });
      const t = room.gs.teams[p.team];
      if (t) t.isAI = true;
    }
    if (room.players.length === 0) {
      if (room.gs && room.gs.status === 'playing' && room.gone.length > 0) {
        // tout le monde a décroché en pleine partie : le salon survit 3 min
        // pour laisser une chance à la reconnexion
        room.emptyAt = Date.now();
      } else {
        if (room.loop) clearInterval(room.loop);
        rooms.delete(room.code);
      }
    } else if (!room.gs) {
      broadcastLobby(room);
    }
  });
});

// décompte des parties rapides : rafraîchit le lobby et lance à zéro ;
// et purge des salons abandonnés dont le délai de reconnexion est écoulé
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.emptyAt > 0 && Date.now() - room.emptyAt > REJOIN_GRACE_MS) {
      if (room.loop) clearInterval(room.loop);
      rooms.delete(room.code);
      continue;
    }
    if (room.gs || !room.quick || room.players.length === 0) continue;
    if (room.autoStartAt > 0 && Date.now() >= room.autoStartAt) startRoom(room);
    else broadcastLobby(room);
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`COBALT SECTOR — serveur multijoueur sur le port ${PORT}`);
  console.log(`  LAN      : les joueurs se connectent à ws://<votre-ip>:${PORT}`);
  console.log(`  En ligne : ouvrez le port ${PORT} sur la machine dédiée`);
  if (fs.existsSync(DIST)) console.log(`  Client servi sur http://<votre-ip>:${PORT}`);
});
