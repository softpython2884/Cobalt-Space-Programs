// ============ COBALT SECTOR — sérialisation des instantanés réseau ============
// Le serveur exécute la vraie simulation et diffuse des instantanés (~12 Hz).
// On retire ce qui ne voyage pas : le RNG (fonction), la sélection (locale),
// et les fx sont accumulés entre deux instantanés côté serveur.
//
// GROS COMBATS : pour éviter la saturation du tuyau (saccades, « rollbacks »),
// deux poids d'instantané circulent :
//   - COMPLET (~1 Hz)  : tout l'état, y compris le décor quasi statique ;
//   - LÉGER  (le reste) : sans astéroïdes/nuages/épaves/journal/carte/config —
//     le client les recycle du dernier instantané complet.
// Et tous les nombres non entiers sont arrondis à 2 décimales : invisible à
// l'écran, mais le JSON pèse environ deux fois moins.
import type { GameState, FxEvent } from './core';

export interface InputMsg {
  thrust: { x: number; y: number };
  aim: { x: number; y: number };
  fire: boolean;      // arme principale maintenue
  fireE: boolean;     // arme secondaire E maintenue
  mineF: boolean;     // touche F maintenue (minage)
}

// clés quasi statiques : lourdes et lentes à changer → instantanés complets uniquement
const HEAVY_KEYS = ['roids', 'clouds', 'wrecks', 'log', 'map', 'cfg'] as const;

// tableaux d'objets homogènes (fabriqués par les mêmes constructeurs) : encodés en
// COLONNES — les noms de champs voyagent une seule fois, les lignes ne portent que
// les valeurs. C'est là que dort l'essentiel du poids (40 champs × N vaisseaux…).
const PACKED_KEYS = [
  'ships', 'projectiles', 'structures', 'planets', 'fleets', 'minesArmed',
  'smokes', 'storms', 'meteors', 'wrecks', 'roids', 'clouds',
] as const;

function packArr(arr: unknown): unknown {
  if (!Array.isArray(arr) || arr.length === 0 || typeof arr[0] !== 'object' || arr[0] === null) return arr;
  const keys = Object.keys(arr[0] as object);
  return { pk: keys, r: (arr as Record<string, unknown>[]).map(o => keys.map(k => o[k])) };
}

function unpackArr(v: unknown): unknown {
  const p = v as { pk?: string[]; r?: unknown[][] } | null;
  if (!p || !Array.isArray(p.pk) || !Array.isArray(p.r)) return v;
  const keys = p.pk;
  return p.r.map(row => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) o[keys[i]] = row[i];
    return o;
  });
}

export function encodeSnap(gs: GameState, fxBuf: FxEvent[], full = true): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(gs)) {
    if (k === 'rng' || k === 'fx' || k === 'selection') continue;
    if (!full && (HEAVY_KEYS as readonly string[]).includes(k)) continue;
    if (k === 'alliances') { out[k] = [...(v as Set<string>)]; continue; }
    out[k] = (PACKED_KEYS as readonly string[]).includes(k) ? packArr(v) : v;
  }
  out.fx = fxBuf;
  return JSON.stringify({ t: 'snap', s: out, full }, (_k, v) =>
    typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v);
}

/** Reconstruit l'état. Un instantané léger a besoin du précédent (`prev`) pour
 *  récupérer le décor ; sans référence, il est ignoré (retour null) le temps
 *  qu'un instantané complet arrive (au plus ~1 s). */
export function decodeSnap(payload: Record<string, unknown>, prev: GameState | null, full: boolean): GameState | null {
  const gs = payload as unknown as GameState;
  for (const k of PACKED_KEYS) {
    if (k in payload) payload[k] = unpackArr(payload[k]);
  }
  if (!full) {
    if (!prev) return null;
    for (const k of HEAVY_KEYS) payload[k] = (prev as unknown as Record<string, unknown>)[k];
  }
  gs.alliances = new Set(payload.alliances as string[]);
  // le client ne simule pas : ce RNG ne sert qu'aux rares effets visuels locaux
  gs.rng = () => Math.random();
  gs.selection = [];
  return gs;
}
