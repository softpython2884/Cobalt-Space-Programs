// ============ COBALT SECTOR — client réseau (LAN & en ligne, même protocole) ============
import type { GameState, MatchConfig, FxEvent } from './core';
import { decodeSnap, InputMsg } from './netcodec';

export interface LobbyInfo {
  code: string;
  players: { name: string; team: number; host: boolean }[];
  isHost: boolean;
  myTeam: number;
  countdown: number | null;
}

export class Net {
  private ws: WebSocket | null = null;
  state: 'off' | 'connecting' | 'lobby' | 'playing' = 'off';
  myTeam = 0;
  names: Record<number, string> = {};
  lobby: LobbyInfo | null = null;
  private snap: GameState | null = null;
  private lastGs: GameState | null = null;   // référence pour fusionner les instantanés légers
  private lastInputT = 0;
  /** Jeton de session : permet de retrouver sa place après une coupure. */
  token = '';

  onLobby: (l: LobbyInfo) => void = () => {};
  onStart: () => void = () => {};
  onError: (msg: string) => void = () => {};
  onClosed: () => void = () => {};
  onHint: (msg: string) => void = () => {};

  connect(addr: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = addr.startsWith('ws') ? addr : `ws://${addr}`;
      try {
        this.ws = new WebSocket(url);
      } catch (e) {
        reject(new Error('Adresse invalide'));
        return;
      }
      this.state = 'connecting';
      const to = window.setTimeout(() => { this.ws?.close(); reject(new Error('Connexion impossible (délai dépassé)')); }, 5000);
      this.ws.onopen = () => { window.clearTimeout(to); resolve(); };
      this.ws.onerror = () => { window.clearTimeout(to); reject(new Error('Connexion refusée — le serveur tourne-t-il ?')); };
      this.ws.onclose = () => {
        const was = this.state;
        this.state = 'off';
        if (was === 'lobby' || was === 'playing') this.onClosed();
      };
      this.ws.onmessage = ev => this.onMsg(String(ev.data));
    });
  }

  private onMsg(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'lobby':
        this.state = 'lobby';
        this.myTeam = m.you;
        this.lobby = { code: m.code, players: m.players, isHost: m.host, myTeam: m.you, countdown: m.cd ?? null };
        this.onLobby(this.lobby);
        break;
      case 'start':
        this.state = 'playing';
        this.myTeam = m.you;
        this.names = m.names ?? {};
        this.lastGs = null;            // repart d'un instantané complet
        this.onStart();
        break;
      case 'snap': {
        const gs = decodeSnap(m.s, this.lastGs, m.full !== false);
        if (!gs) break;                // léger sans référence : on attend le complet
        gs.playerTeam = this.myTeam;   // chaque client voit la partie depuis son équipe
        this.lastGs = gs;
        this.snap = gs;
        break;
      }
      case 'err':
        this.onError(m.msg ?? 'Erreur serveur');
        break;
      case 'hint':
        this.onHint(m.msg ?? '');
        break;
    }
  }

  private send(o: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  quick(name: string, cfg: MatchConfig) { this.send({ t: 'quick', name, cfg, token: this.token }); }
  create(name: string, cfg: MatchConfig, isPublic = false) { this.send({ t: 'create', name, cfg, public: isPublic, token: this.token }); }
  join(code: string, name: string) { this.send({ t: 'join', code, name, token: this.token }); }
  /** Après une coupure : réclame sa place dans la partie en cours via le jeton. */
  rejoin() { this.send({ t: 'rejoin', token: this.token }); }
  start() { this.send({ t: 'start' }); }
  leave() { this.ws?.close(); this.state = 'off'; this.snap = null; this.lastGs = null; }

  /** Entrées continues du vaisseau (30 Hz max). */
  sendInput(input: InputMsg) {
    const now = performance.now();
    if (now - this.lastInputT < 33) return;
    this.lastInputT = now;
    this.send({ t: 'in', i: input });
  }

  /** Commande de jeu ponctuelle (achats, ordres, gadgets…). */
  cmd(name: string, args: Record<string, unknown>) {
    this.send({ t: 'cmd', name, args });
  }

  /** Dernier instantané reçu (consommé). */
  poll(): GameState | null {
    const s = this.snap;
    this.snap = null;
    return s;
  }
}
