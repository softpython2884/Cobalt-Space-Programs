// ============ COBALT SECTOR — types, maths, RNG, état de jeu ============

// ---------- Vecteurs 2D (plan XZ du monde ; y écran = z monde) ----------
export interface V2 { x: number; y: number }

export const v2 = (x = 0, y = 0): V2 => ({ x, y });
export const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: V2, s: number): V2 => ({ x: a.x * s, y: a.y * s });
export const len = (a: V2): number => Math.hypot(a.x, a.y);
export const dist = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a: V2, b: V2): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const norm = (a: V2): V2 => { const l = len(a); return l > 1e-6 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 }; };
export const angleOf = (a: V2): number => Math.atan2(a.y, a.x);
export const fromAngle = (t: number, l = 1): V2 => ({ x: Math.cos(t) * l, y: Math.sin(t) * l });
export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
/** Tourne `cur` vers `target` au max de `rate` rad. */
export function turnToward(cur: number, target: number, rate: number): number {
  const d = wrapAngle(target - cur);
  return cur + clamp(d, -rate, rate);
}

// ---------- RNG déterministe (mulberry32) ----------
export type RNG = () => number;
export function makeRng(seed: number): RNG {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rr = (rng: RNG, a: number, b: number) => a + rng() * (b - a);
export const ri = (rng: RNG, a: number, b: number) => Math.floor(rr(rng, a, b + 1));
export const pick = <T,>(rng: RNG, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

// ---------- Constantes ----------
export const WORLD_R = 1500;            // rayon jouable de la carte
export const SIM_DT = 1 / 60;
export const PIRATE_TEAM = 4;
export const NO_TEAM = -1;
export const TACTICAL_ZOOM = 260;       // hauteur caméra à partir de laquelle on passe en vue tactique

export type Res = 'roche' | 'minerai' | 'gaz';
export const RES_LIST: Res[] = ['roche', 'minerai', 'gaz'];

// ---------- Identifiants de données (définis dans data.ts) ----------
export type ShipClassId = 'corvette' | 'chasseur' | 'bombardier' | 'croiseur' | 'mineur' | 'cargo' | 'transporteur' | 'raider' | 'colosse';
export type WeaponId = 'canon' | 'canon_auto' | 'laser' | 'stase' | 'torpille' | 'plasma' | 'canon_lourd' | 'missile' | 'salve' | 'brise_monde';
export type MineType = 'frag' | 'emp' | 'aimant';
export type StructType = 'station' | 'avantposte' | 'mine' | 'satellite' | 'labo' | 'depot' | 'usine';
export type PlanetType = 'tellurique' | 'glace' | 'lave' | 'gazeuse' | 'oceanique' | 'desert';
export type StarType = 'sol_jaune' | 'sol_rouge' | 'sol_bleu' | 'sol_violet' | 'naine_blanche' | 'binaire' | 'triple' | 'neutron' | 'trou_noir' | 'supergeante';
export type PersonaId = 'agressif' | 'econome' | 'opportuniste' | 'defensif' | 'equilibre';
export type FormationId = 'ligne' | 'coin' | 'cercle' | 'colonne';
export type ShipMode = 'normal' | 'croisiere' | 'radar' | 'espion';
export type GadgetId = 'fumee' | 'camouflage' | 'frappe' | 'soutien' | 'bouclier_orbital';

// ---------- Ordres ----------
// (les 4 derniers sont des missions de flotte, jamais des ordres de vaisseau)
export type OrderKind = 'idle' | 'move' | 'attack' | 'mine' | 'trade' | 'escort' | 'colonize' | 'guard' | 'dock' | 'flee' | 'salvage' | 'orbit'
  | 'mine_auto' | 'patrol_in' | 'patrol_border' | 'patrol_out' | 'protect' | 'trade_auto' | 'patrol_civil' | 'plan';
export interface Order {
  kind: OrderKind;
  pos?: V2;            // destination (move/guard)
  targetId?: number;   // entité ciblée (attack/mine/escort/colonize/salvage/dock)
}
export const IDLE: Order = { kind: 'idle' };

// ---------- Entités ----------
export interface WeaponSlot { wid: WeaponId; cd: number }

export interface Ship {
  id: number; kind: 'ship';
  team: number; cls: ShipClassId;
  pos: V2; vel: V2; heading: number;
  radius: number;
  hull: number; hullMax: number;
  shield: number; shieldMax: number;
  energy: number; energyMax: number;
  weapons: WeaponSlot[];          // [0] = principale, [1..2] = secondaires
  cargo: Record<Res, number>; cargoMax: number;
  mineType: MineType | null; mineCount: number; mineMax: number;
  order: Order; fleetId: number | null;
  mode: ShipMode;
  // état temporel
  stasisT: number; empT: number; cloakT: number; smokeT: number; invulnT: number;
  jumpT: number;                  // canal de saut spatial en cours (>0)
  lastDmgT: number;               // temps sim du dernier dégât reçu
  aiCd: number;                   // délai avant prochaine réflexion de pilotage
  avoidSeed: number;
  isFlagship: boolean;
  alive: boolean;
  supportT: number;               // >0 : vaisseau de soutien temporaire, disparaît à 0
  lockT: number;                  // progression du verrouillage missile (s)
  lockTargetId: number;           // cible du verrouillage (-1 = aucune)
  miningRes: Res | null;          // ressource en cours de minage (visuel)
  colonizeT: number;              // canal de colonisation en cours
  tradePhase: 0 | 1;              // 0 = va vers la planète, 1 = retourne à la station
  kills: number;
}

export interface Structure {
  id: number; kind: 'structure';
  team: number; stype: StructType;
  pos: V2; radius: number;
  hull: number; hullMax: number;
  shield: number; shieldMax: number;
  level: number;                  // niveau de station (1..3)
  fireCd: number;
  incomeT: number;
  lastDmgT: number;               // le bouclier ne régénère qu'après 10 s sans dégât
  pendingCredits: number;         // dépôt : valeur stockée (propriétaire), écoulée à débit limité
  pendingAllied: Record<number, number>;  // dépôt : valeur en attente par équipe alliée
  buildT: number;                 // usine d'assemblage : chantier restant (s), 0 = inactif
  alive: boolean;
}

export interface Planet {
  id: number; kind: 'planet';
  ptype: PlanetType; name: string;
  pos: V2; radius: number;
  owner: number;                  // NO_TEAM si neutre
  colonyHp: number; colonyHpMax: number;
  incomeT: number;
  dyingT: number;                 // >0 : frappe orbitale reçue, explose à 0
  alive: boolean;
}

export interface Roid {
  id: number; kind: 'roid';
  rtype: 'roche' | 'minerai';
  pos: V2; radius: number; amount: number;
  alive: boolean;
}

export interface GasCloud {
  id: number; kind: 'gas';
  pos: V2; radius: number; amount: number;
  alive: boolean;
}

export interface Wreck {
  id: number; kind: 'wreck';
  pos: V2; value: number; t: number;
  cls: ShipClassId;
  alive: boolean;
}

export interface Projectile {
  id: number;
  team: number; wid: WeaponId;
  pos: V2; vel: V2; ttl: number; dmg: number;
  homingId: number | null;
  alive: boolean;
}

export interface MineEnt {
  id: number;
  team: number; mtype: MineType;
  pos: V2; vel: V2; timer: number; armed: number;
  alive: boolean;
}

export interface SmokeZone { id: number; pos: V2; radius: number; t: number }

/** Événements visuels/sonores produits par la sim, consommés par le rendu. */
export interface FxEvent {
  type: 'tir' | 'impact' | 'explosion' | 'beam' | 'saut' | 'onde' | 'frappe' | 'bulle' | 'fumee' | 'colonise' | 'minage' | 'eclair' | 'stase_fx' | 'rayon';
  pos: V2; pos2?: V2; color?: number; size?: number; wid?: WeaponId;
}

export type Entity = Ship | Structure | Planet | Roid | GasCloud | Wreck;

// ---------- Équipes ----------
export interface TeamState {
  id: number;
  name: string;
  color: number;      // couleur three.js
  cssColor: string;
  credits: number;
  isAI: boolean;
  persona: PersonaId;
  alive: boolean;
  stationId: number;
  upgrades: Record<string, number>;  // moteur/coque/bouclier/energie/soute -> niveau 0..3
  gadgets: GadgetId[];               // gadgets débloqués
  gadgetCd: Record<string, number>;
  secondaries: WeaponId[];           // armes secondaires achetées (joueur)
  aiCd: number;                      // réflexion macro IA
  respawnT: number;                  // délai de réapparition de l'amiral
  colossusUsed: boolean;             // le Colosse ne peut être créé qu'une seule fois
  score: number;
  kills: number;
}

// ---------- Flottes ----------
export type Stance = 'feu' | 'defense' | 'paix';   // à vue / riposte / ne pas tirer

export interface Fleet {
  id: number;
  team: number;
  name: string;
  leaderId: number;
  members: number[];      // ids de vaisseaux (hors chef)
  formation: FormationId;
  mission: Order;
  patrolAngle: number;    // progression des patrouilles / rotation des points
  stance: Stance;
}

// ---------- Plan d'attaque (vue tactique) ----------
export type PlanFilter = 'stations' | 'structures' | 'armes' | 'tout';
export interface PlanState {
  filter: PlanFilter;
  objective: V2 | null;
  armed: boolean;         // ENTRÉE pressée : les flottes avancent vers l'objectif
}

// ---------- Météores (arrivent en feu depuis les bords, minables à l'impact) ----------
export interface Meteor {
  id: number; kind: 'meteor';
  pos: V2; vel: V2; target: V2;
  alive: boolean;
}

// ---------- Nuages électriques ----------
export interface StormCloud {
  id: number; kind: 'storm';
  pos: V2; vel: V2; radius: number;
  boltT: number;
  alive: boolean;
}

// ---------- Diplomatie ----------
export interface DiploOffer {
  id: number;
  from: number; to: number;
  type: 'alliance' | 'target' | 'defend';
  target?: number;        // équipe à cibler (type 'target')
  expiresT: number;       // temps sim d'expiration
}

export const allyKey = (a: number, b: number) => a < b ? `${a}-${b}` : `${b}-${a}`;
export function areAllied(gs: GameState, a: number, b: number): boolean {
  if (a === b) return true;
  if (a < 0 || b < 0 || a === PIRATE_TEAM || b === PIRATE_TEAM) return false;
  return gs.alliances.has(allyKey(a, b));
}

// ---------- Config de partie ----------
export interface MatchConfig {
  seed: number;
  playerColorIdx: number;      // 0 rouge, 1 bleu, 2 vert, 3 jaune
  aiCount: number;             // 1..3
  personaChoice: PersonaId | 'aleatoire';
  starChoice: StarType | 'aleatoire';
  difficulty: 'facile' | 'normal' | 'difficile';
}

export interface StarBody { pos: V2; radius: number; color: number; orbitR: number; orbitSpeed: number; phase: number }

export interface MapInfo {
  starType: StarType;
  starName: string;
  bodies: StarBody[];        // 1 à 3 astres centraux
  killRadius: number;        // rayon de destruction autour du centre
  supernovaAt: number;       // temps sim de la supernova (-1 sinon)
  neutronPeriod: number;     // période d'impulsion EMP (-1 sinon)
  blackHole: boolean;
  energyBonus: number;       // multiplicateur de régén d'énergie (violet)
}

// ---------- État global ----------
export interface GameState {
  t: number;
  seed: number;
  rng: RNG;
  cfg: MatchConfig;
  map: MapInfo;
  nextId: number;

  teams: TeamState[];          // index 0..3 (+ PIRATE_TEAM logique à part)
  activeTeams: number[];       // ids des équipes en jeu

  ships: Ship[];
  structures: Structure[];
  planets: Planet[];
  roids: Roid[];
  clouds: GasCloud[];
  wrecks: Wreck[];
  projectiles: Projectile[];
  minesArmed: MineEnt[];
  smokes: SmokeZone[];
  fleets: Fleet[];
  fx: FxEvent[];

  playerTeam: number;
  playerShipId: number;        // -1 si mort/en attente
  selection: number[];         // ids sélectionnés (vaisseaux du joueur)

  status: 'playing' | 'over';
  winner: number;              // -1 tant que non déterminé
  overReason: string;

  neutronT: number;            // compte à rebours prochaine impulsion
  pirateT: number;             // prochain raid pirate
  supernovaWave: number;       // rayon de l'onde (-1 = pas déclenchée)

  alliances: Set<string>;      // paires alliées (allyKey)
  allianceSince: Record<string, number>;  // temps sim de formation (expire après 15 min)
  diploOffers: DiploOffer[];   // propositions en attente (surtout vers le joueur)
  focusTargets: Record<number, number>;  // équipe -> cible convenue avec un allié

  storms: StormCloud[];        // nuages électriques (apparaissent en cours de partie)
  stormT: number;              // prochain spawn de nuage
  meteors: Meteor[];           // météores en vol
  meteorT: number;             // prochaine pluie de météores
  plan: PlanState;             // plan d'attaque du joueur

  log: { t: number; text: string; color: string }[];
  alertText: string; alertT: number; alertColor: string;
}

// ---------- Utilitaires d'état ----------
export function shipById(gs: GameState, id: number): Ship | undefined {
  return gs.ships.find(s => s.id === id && s.alive);
}
export function structById(gs: GameState, id: number): Structure | undefined {
  return gs.structures.find(s => s.id === id && s.alive);
}
export function planetById(gs: GameState, id: number): Planet | undefined {
  return gs.planets.find(p => p.id === id && p.alive);
}
export function anyById(gs: GameState, id: number): Ship | Structure | Planet | Roid | GasCloud | Wreck | undefined {
  return shipById(gs, id) ?? structById(gs, id) ?? planetById(gs, id)
    ?? gs.roids.find(r => r.id === id && r.alive)
    ?? gs.clouds.find(c => c.id === id && c.alive)
    ?? gs.wrecks.find(w => w.id === id && w.alive);
}

export function addLog(gs: GameState, text: string, color = '#8fa8c8') {
  gs.log.push({ t: gs.t, text, color });
  if (gs.log.length > 60) gs.log.shift();
}
export function setAlert(gs: GameState, text: string, dur = 4.5, color = '#ff4b4b') {
  gs.alertText = text; gs.alertT = dur; gs.alertColor = color;
}

/** Nom de secteur : anneau (1-3) × secteur angulaire (grec). */
const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta'];
export function sectorName(pos: V2): string {
  const d = len(pos);
  if (d < 220) return 'Cœur Stellaire';
  const ring = d < 700 ? 'I' : d < 1150 ? 'II' : 'III';
  let a = Math.atan2(pos.y, pos.x); if (a < 0) a += Math.PI * 2;
  const idx = Math.floor(a / (Math.PI * 2) * 8) % 8;
  return `Secteur ${GREEK[idx]}-${ring}`;
}

/** Équipe qui contrôle la zone autour de `pos` (structures dans un rayon de 260), ou NO_TEAM. */
export function territoryOwner(gs: GameState, pos: V2): number {
  let best = NO_TEAM, bestD = Infinity;
  for (const st of gs.structures) {
    if (!st.alive || st.team < 0 || st.team === PIRATE_TEAM) continue;
    const r = st.stype === 'station' ? 340 : st.stype === 'avantposte' ? 260 : 160;
    const d = dist(st.pos, pos);
    if (d < r && d < bestD) { bestD = d; best = st.team; }
  }
  for (const p of gs.planets) {
    if (!p.alive || p.owner < 0) continue;
    const d = dist(p.pos, pos);
    if (d < 200 && d < bestD) { bestD = d; best = p.owner; }
  }
  return best;
}
