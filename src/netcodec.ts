// ============ COBALT SECTOR — sérialisation des instantanés réseau ============
// Le serveur exécute la vraie simulation et diffuse des instantanés (~12 Hz).
// On retire ce qui ne voyage pas : le RNG (fonction), la sélection (locale),
// et les fx sont accumulés entre deux instantanés côté serveur.
import type { GameState, FxEvent } from './core';

export interface InputMsg {
  thrust: { x: number; y: number };
  aim: { x: number; y: number };
  fire: boolean;      // arme principale maintenue
  fireE: boolean;     // arme secondaire E maintenue
  mineF: boolean;     // touche F maintenue (minage)
}

export function encodeSnap(gs: GameState, fxBuf: FxEvent[]): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(gs)) {
    if (k === 'rng' || k === 'fx' || k === 'selection') continue;
    if (k === 'alliances') { out[k] = [...(v as Set<string>)]; continue; }
    out[k] = v;
  }
  out.fx = fxBuf;
  return JSON.stringify({ t: 'snap', s: out });
}

export function decodeSnap(payload: Record<string, unknown>): GameState {
  const gs = payload as unknown as GameState;
  gs.alliances = new Set(payload.alliances as string[]);
  // le client ne simule pas : ce RNG ne sert qu'aux rares effets visuels locaux
  gs.rng = () => Math.random();
  gs.selection = [];
  return gs;
}
