// ============ COBALT SECTOR — données de jeu (classes, armes, gadgets, étoiles, IA) ============
import type { GadgetId, MineType, PersonaId, PlanetType, Res, ShipClassId, StarType, StructType, WeaponId } from './core';

// ---------- Couleurs des équipes ----------
export interface TeamDef { name: string; color: number; cssColor: string }
export const TEAM_DEFS: TeamDef[] = [
  { name: 'Rouge', color: 0xff4b4b, cssColor: '#ff4b4b' },
  { name: 'Bleu', color: 0x4b8bff, cssColor: '#4b8bff' },
  { name: 'Vert', color: 0x4bff7a, cssColor: '#4bff7a' },
  { name: 'Jaune', color: 0xffd84b, cssColor: '#ffd84b' },
];
export const PIRATE_DEF: TeamDef = { name: 'Pirates', color: 0x9aa0a8, cssColor: '#9aa0a8' };
export const NEUTRAL_CSS = '#8a93a0';

// ---------- Armes ----------
export interface WeaponDef {
  id: WeaponId; nom: string;
  type: 'proj' | 'beam' | 'homing';
  dmg: number; cd: number; range: number; energy: number;
  speed?: number;          // projectiles
  spread?: number;         // dispersion (rad)
  slowFactor?: number;     // stase
  slowDur?: number;
  aoe?: number;            // rayon d'explosion
  color: number;
  prix: number;
  desc: string;
}
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  canon: { id: 'canon', nom: 'Canon', type: 'proj', dmg: 9, cd: 0.45, range: 200, energy: 4, speed: 260, color: 0xffd27a, prix: 0, desc: 'Polyvalent et fiable.' },
  canon_auto: { id: 'canon_auto', nom: 'Canon automatique', type: 'proj', dmg: 3, cd: 0.11, range: 160, energy: 1.4, speed: 300, spread: 0.07, color: 0xffe9a8, prix: 250, desc: 'Cadence élevée, faible portée.' },
  laser: { id: 'laser', nom: 'Laser', type: 'beam', dmg: 13, cd: 0.8, range: 190, energy: 7, color: 0xff5d5d, prix: 350, desc: 'Touche instantanément.' },
  stase: { id: 'stase', nom: 'Rayon de stase', type: 'beam', dmg: 3, cd: 1.0, range: 170, energy: 8, slowFactor: 0.45, slowDur: 1.6, color: 0x9c6bff, prix: 400, desc: 'Ralentit fortement la cible.' },
  torpille: { id: 'torpille', nom: 'Torpille', type: 'homing', dmg: 42, cd: 2.4, range: 280, energy: 12, speed: 110, aoe: 18, color: 0x7adfff, prix: 500, desc: 'Lente, dévastatrice contre les structures.' },
  plasma: { id: 'plasma', nom: 'Canon à plasma', type: 'proj', dmg: 22, cd: 1.1, range: 210, energy: 9, speed: 200, aoe: 10, color: 0x6dff8a, prix: 450, desc: 'Gros dégâts de zone.' },
  canon_lourd: { id: 'canon_lourd', nom: 'Canon lourd', type: 'proj', dmg: 30, cd: 1.5, range: 250, energy: 11, speed: 230, color: 0xffb35d, prix: 600, desc: 'L\'artillerie des croiseurs.' },
};

// ---------- Classes de vaisseaux ----------
export interface ShipClassDef {
  id: ShipClassId; nom: string; role: string;
  hull: number; shield: number; energy: number;
  speed: number; accel: number; turn: number;
  radius: number; sensor: number;
  cargo: number;
  weapons: WeaponId[];          // armement par défaut ([0] = principale)
  secondarySlots: number;       // 0..2
  mineType: MineType | null; mineMax: number;
  prix: number; unlockLevel: number;
  power: number;                // puissance de combat (IA / fuite pirate)
  civil: boolean;               // cible privilégiée des pirates
  canMine: boolean; canColonize: boolean;
  desc: string;
}
export const SHIP_CLASSES: Record<ShipClassId, ShipClassDef> = {
  corvette: {
    id: 'corvette', nom: 'Corvette', role: 'Polyvalent',
    hull: 100, shield: 60, energy: 100, speed: 68, accel: 130, turn: 4.5,
    radius: 5, sensor: 240, cargo: 25,
    weapons: ['canon'], secondarySlots: 1, mineType: 'frag', mineMax: 2,
    prix: 250, unlockLevel: 1, power: 10, civil: false, canMine: true, canColonize: false,
    desc: 'Le vaisseau de départ. Solide, sans éclat.',
  },
  chasseur: {
    id: 'chasseur', nom: 'Chasseur', role: 'Interception',
    hull: 70, shield: 45, energy: 90, speed: 92, accel: 190, turn: 6,
    radius: 4, sensor: 260, cargo: 10,
    weapons: ['canon_auto'], secondarySlots: 1, mineType: 'frag', mineMax: 2,
    prix: 350, unlockLevel: 1, power: 12, civil: false, canMine: false, canColonize: false,
    desc: 'Rapide et agressif, fragile.',
  },
  bombardier: {
    id: 'bombardier', nom: 'Bombardier', role: 'Anti-structure',
    hull: 120, shield: 55, energy: 110, speed: 55, accel: 95, turn: 3,
    radius: 6, sensor: 230, cargo: 15,
    weapons: ['torpille'], secondarySlots: 1, mineType: 'emp', mineMax: 3,
    prix: 700, unlockLevel: 2, power: 18, civil: false, canMine: false, canColonize: false,
    desc: 'Ses torpilles rasent les bases.',
  },
  croiseur: {
    id: 'croiseur', nom: 'Croiseur', role: 'Ligne de front',
    hull: 260, shield: 140, energy: 160, speed: 46, accel: 70, turn: 2.2,
    radius: 9, sensor: 300, cargo: 30,
    weapons: ['canon_lourd'], secondarySlots: 2, mineType: 'aimant', mineMax: 4,
    prix: 1200, unlockLevel: 2, power: 34, civil: false, canMine: false, canColonize: false,
    desc: 'Le poing de la flotte.',
  },
  mineur: {
    id: 'mineur', nom: 'Mineur', role: 'Extraction',
    hull: 90, shield: 40, energy: 110, speed: 50, accel: 90, turn: 3.5,
    radius: 6, sensor: 220, cargo: 70,
    weapons: [], secondarySlots: 0, mineType: null, mineMax: 0,
    prix: 350, unlockLevel: 1, power: 2, civil: true, canMine: true, canColonize: false,
    desc: 'Extrait roche, minerai et gaz.',
  },
  cargo: {
    id: 'cargo', nom: 'Cargo', role: 'Commerce',
    hull: 110, shield: 50, energy: 100, speed: 55, accel: 85, turn: 3,
    radius: 7, sensor: 200, cargo: 150,
    weapons: [], secondarySlots: 0, mineType: null, mineMax: 0,
    prix: 400, unlockLevel: 1, power: 2, civil: true, canMine: false, canColonize: false,
    desc: 'Routes commerciales vers vos colonies.',
  },
  transporteur: {
    id: 'transporteur', nom: 'Transporteur', role: 'Colonisation',
    hull: 130, shield: 60, energy: 120, speed: 52, accel: 80, turn: 2.8,
    radius: 7, sensor: 220, cargo: 60,
    weapons: [], secondarySlots: 0, mineType: null, mineMax: 0,
    prix: 450, unlockLevel: 1, power: 3, civil: true, canMine: false, canColonize: true,
    desc: 'Le seul capable de coloniser une planète.',
  },
  raider: {
    id: 'raider', nom: 'Raider pirate', role: 'Pillage',
    hull: 65, shield: 30, energy: 85, speed: 85, accel: 170, turn: 5.5,
    radius: 4, sensor: 280, cargo: 40,
    weapons: ['canon_auto'], secondarySlots: 0, mineType: null, mineMax: 0,
    prix: 0, unlockLevel: 99, power: 10, civil: false, canMine: false, canColonize: false,
    desc: 'Chasse les convois isolés.',
  },
};
export const BUYABLE_SHIPS: ShipClassId[] = ['corvette', 'chasseur', 'mineur', 'cargo', 'transporteur', 'bombardier', 'croiseur'];

// ---------- Mines larguées ----------
export interface MineDef { id: MineType; nom: string; dmg: number; radius: number; fuse: number; color: number; desc: string }
export const MINES: Record<MineType, MineDef> = {
  frag: { id: 'frag', nom: 'Mine à fragmentation', dmg: 55, radius: 26, fuse: 4, color: 0xff8c42, desc: 'Explosion classique.' },
  emp: { id: 'emp', nom: 'Mine EMP', dmg: 5, radius: 34, fuse: 4, color: 0x7adfff, desc: 'Vide l\'énergie, désactive 2 s.' },
  aimant: { id: 'aimant', nom: 'Mine aimant', dmg: 10, radius: 46, fuse: 4, color: 0xc86bff, desc: 'Attire les vaisseaux ennemis.' },
};

// ---------- Structures ----------
export interface StructDef {
  stype: StructType; nom: string; hull: number; shield: number;
  radius: number; sensor: number; prix: number;
  weaponRange: number; weaponDmg: number; weaponCd: number;
  desc: string;
}
export const STRUCTS: Record<StructType, StructDef> = {
  station: { stype: 'station', nom: 'Station spatiale', hull: 2200, shield: 450, radius: 22, sensor: 380, prix: 0, weaponRange: 235, weaponDmg: 16, weaponCd: 0.45, desc: 'Votre cœur. Si elle tombe, tout tombe.' },
  avantposte: { stype: 'avantposte', nom: 'Avant-poste', hull: 520, shield: 160, radius: 12, sensor: 300, prix: 600, weaponRange: 190, weaponDmg: 12, weaponCd: 0.6, desc: 'Tourelle défensive, étend le territoire.' },
  mine: { stype: 'mine', nom: 'Mine spatiale', hull: 200, shield: 40, radius: 10, sensor: 140, prix: 400, weaponRange: 0, weaponDmg: 0, weaponCd: 0, desc: 'Revenu passif si placée près d\'astéroïdes.' },
  satellite: { stype: 'satellite', nom: 'Satellite', hull: 60, shield: 20, radius: 5, sensor: 420, prix: 150, weaponRange: 0, weaponDmg: 0, weaponCd: 0, desc: 'Œil lointain, très fragile.' },
};

// ---------- Économie ----------
export const RES_PRICE: Record<Res, number> = { roche: 4, minerai: 9, gaz: 14 };
export const START_CREDITS = 600;
export const PLANET_INCOME = 70;          // crédits / 30 s / planète
export const PLANET_INCOME_PERIOD = 30;
export const MINE_INCOME = 30;            // crédits / 12 s si près d'astéroïdes
export const MINE_INCOME_PERIOD = 12;
export const PASSIVE_INCOME = 12;         // crédits / 10 s (station vivante)
export const PASSIVE_INCOME_PERIOD = 10;
export const COLONIZE_COST = 300;
export const COLONIZE_TIME = 8;
export const KILL_BOUNTY: Record<ShipClassId, number> = {
  corvette: 40, chasseur: 45, bombardier: 80, croiseur: 150, mineur: 35, cargo: 50, transporteur: 55, raider: 60,
};
export const WRECK_VALUE: Record<ShipClassId, number> = {
  corvette: 35, chasseur: 30, bombardier: 60, croiseur: 120, mineur: 45, cargo: 70, transporteur: 55, raider: 40,
};
export const MINE_RESTOCK_PRICE = 30;
export const TRADE_PROFIT = 90;           // par livraison cargo → planète → retour

// ---------- Améliorations (persistantes, appliquées au vaisseau du joueur/amiral) ----------
export interface UpgradeDef { id: string; nom: string; desc: string; mult: number; prix: number[] }
export const UPGRADES: UpgradeDef[] = [
  { id: 'moteur', nom: 'Moteurs', desc: '+18 % vitesse par niveau', mult: 0.18, prix: [200, 400, 800] },
  { id: 'coque', nom: 'Coque renforcée', desc: '+22 % coque par niveau', mult: 0.22, prix: [200, 400, 800] },
  { id: 'bouclier', nom: 'Boucliers', desc: '+25 % bouclier par niveau', mult: 0.25, prix: [250, 500, 900] },
  { id: 'energie', nom: 'Réacteur', desc: '+20 % énergie par niveau', mult: 0.2, prix: [200, 400, 800] },
  { id: 'soute', nom: 'Soute étendue', desc: '+30 % soute par niveau', mult: 0.3, prix: [150, 300, 600] },
];

// ---------- Gadgets (capacités actives) ----------
export interface GadgetDef {
  id: GadgetId; nom: string; icon: string; cd: number; dur: number;
  prix: number; unlockLevel: number; desc: string;
}
export const GADGETS: Record<GadgetId, GadgetDef> = {
  fumee: { id: 'fumee', nom: 'Écran de fumée', icon: '🌫', cd: 35, dur: 12, prix: 250, unlockLevel: 1, desc: 'Nuage qui brouille le ciblage ennemi.' },
  camouflage: { id: 'camouflage', nom: 'Camouflage', icon: '👻', cd: 45, dur: 8, prix: 400, unlockLevel: 2, desc: 'Invisible 8 s (rompu si vous tirez).' },
  bouclier_orbital: { id: 'bouclier_orbital', nom: 'Bouclier orbital', icon: '🛡', cd: 60, dur: 6, prix: 500, unlockLevel: 2, desc: 'Invulnérable 6 s.' },
  frappe: { id: 'frappe', nom: 'Frappe orbitale', icon: '☄', cd: 90, dur: 0, prix: 800, unlockLevel: 3, desc: 'Cible le vaisseau visé : dégâts massifs.' },
  soutien: { id: 'soutien', nom: 'Flotte de soutien', icon: '🚀', cd: 600, dur: 180, prix: 1000, unlockLevel: 3, desc: '3 chasseurs alliés en saut spatial pendant 3 min.' },
};
export const GADGET_ORDER: GadgetId[] = ['fumee', 'camouflage', 'bouclier_orbital', 'frappe', 'soutien'];

// ---------- Modes du vaisseau amiral ----------
export interface ModeDef { id: string; nom: string; icon: string; desc: string }
export const MODES: ModeDef[] = [
  { id: 'croisiere', nom: 'Croisière', icon: '💨', desc: '+70 % vitesse, tir impossible.' },
  { id: 'radar', nom: 'Radar', icon: '📡', desc: 'Portée capteurs ×2, vitesse −40 %, signature ×2.' },
  { id: 'espion', nom: 'Espion', icon: '🕶', desc: 'Signature réduite de 65 %, tir impossible.' },
  { id: 'saut', nom: 'Saut spatial', icon: '🌀', desc: 'Retour à la base. Consomme toute l\'énergie.' },
];

// ---------- Station : niveaux ----------
export const STATION_UPGRADE_PRICE = [0, 1000, 2500];  // vers niveau 2, 3
export const STATION_LEVEL_DESC = [
  '',
  'Niv. 2 : débloque Bombardier, Croiseur, Camouflage, Bouclier orbital.',
  'Niv. 3 : débloque Frappe orbitale et Flotte de soutien.',
];

// ---------- Personnalités IA ----------
export interface PersonaDef {
  id: PersonaId; nom: string;
  aggression: number;      // 0..1 propension à attaquer
  ecoFocus: number;        // 0..1 priorité économie
  raid: number;            // 0..1 cible les civils
  defense: number;         // 0..1 garde à la maison
  desc: string;
}
export const PERSONAS: Record<PersonaId, PersonaDef> = {
  agressif: { id: 'agressif', nom: 'Agressif', aggression: 0.9, ecoFocus: 0.3, raid: 0.35, defense: 0.2, desc: 'Attaque tôt, attaque fort.' },
  econome: { id: 'econome', nom: 'Économe', aggression: 0.25, ecoFocus: 0.95, raid: 0.1, defense: 0.5, desc: 'Colonise et mine tout ce qui brille.' },
  opportuniste: { id: 'opportuniste', nom: 'Opportuniste', aggression: 0.55, ecoFocus: 0.5, raid: 0.85, defense: 0.3, desc: 'Frappe les convois et les faibles.' },
  defensif: { id: 'defensif', nom: 'Défensif', aggression: 0.2, ecoFocus: 0.6, raid: 0.05, defense: 0.95, desc: 'Une forteresse qui attend son heure.' },
  equilibre: { id: 'equilibre', nom: 'Équilibré', aggression: 0.5, ecoFocus: 0.6, raid: 0.3, defense: 0.5, desc: 'Un peu de tout, correctement.' },
};
export const PERSONA_LIST: PersonaId[] = ['agressif', 'econome', 'opportuniste', 'defensif', 'equilibre'];

// ---------- Types d'étoiles ----------
export interface StarDef {
  id: StarType; nom: string; weight: number;
  color: number; glow: number; radius: number;
  bodies: number;          // 1..3
  killRadius: number;
  neutronPeriod: number;   // -1 sinon
  blackHole: boolean;
  supernovaDelay: number;  // -1 sinon (secondes)
  energyBonus: number;
  desc: string;
}
export const STARS: Record<StarType, StarDef> = {
  sol_jaune: { id: 'sol_jaune', nom: 'Soleil jaune', weight: 20, color: 0xffd84b, glow: 0xffb347, radius: 90, bodies: 1, killRadius: 130, neutronPeriod: -1, blackHole: false, supernovaDelay: -1, energyBonus: 1, desc: 'Un système tranquille.' },
  sol_rouge: { id: 'sol_rouge', nom: 'Soleil rouge', weight: 16, color: 0xff6b4b, glow: 0xff3b1f, radius: 100, bodies: 1, killRadius: 140, neutronPeriod: -1, blackHole: false, supernovaDelay: -1, energyBonus: 1, desc: 'Vieille étoile paisible.' },
  sol_bleu: { id: 'sol_bleu', nom: 'Soleil bleu', weight: 14, color: 0x7ab8ff, glow: 0x3b8cff, radius: 85, bodies: 1, killRadius: 135, neutronPeriod: -1, blackHole: false, supernovaDelay: -1, energyBonus: 1, desc: 'Jeune, chaud, lumineux.' },
  sol_violet: { id: 'sol_violet', nom: 'Soleil violet', weight: 4, color: 0xb06bff, glow: 0x8c3bff, radius: 88, bodies: 1, killRadius: 135, neutronPeriod: -1, blackHole: false, supernovaDelay: -1, energyBonus: 1.5, desc: 'Rare. Régénération d\'énergie +50 % pour tous.' },
  naine_blanche: { id: 'naine_blanche', nom: 'Naine blanche', weight: 12, color: 0xe8f4ff, glow: 0xbcd8ff, radius: 45, bodies: 1, killRadius: 75, neutronPeriod: -1, blackHole: false, supernovaDelay: -1, energyBonus: 1, desc: 'Petite, dense, discrète.' },
  binaire: { id: 'binaire', nom: 'Système binaire', weight: 12, color: 0xffd84b, glow: 0xff8c42, radius: 65, bodies: 2, killRadius: 220, neutronPeriod: -1, blackHole: false, supernovaDelay: -1, energyBonus: 1, desc: 'Deux soleils en danse.' },
  triple: { id: 'triple', nom: 'Système triple', weight: 7, color: 0x7ab8ff, glow: 0xffd84b, radius: 55, bodies: 3, killRadius: 260, neutronPeriod: -1, blackHole: false, supernovaDelay: -1, energyBonus: 1, desc: 'Trois soleils, zéro stabilité.' },
  neutron: { id: 'neutron', nom: 'Étoile à neutrons', weight: 8, color: 0xbfe8ff, glow: 0x7adfff, radius: 30, bodies: 1, killRadius: 90, neutronPeriod: 40, blackHole: false, supernovaDelay: -1, energyBonus: 1, desc: 'Impulsion EMP toutes les 40 s.' },
  trou_noir: { id: 'trou_noir', nom: 'Trou noir', weight: 4, color: 0x000000, glow: 0xff8c42, radius: 40, bodies: 1, killRadius: 70, neutronPeriod: -1, blackHole: true, supernovaDelay: -1, energyBonus: 1, desc: 'Il attire tout. Partie très spéciale.' },
  supergeante: { id: 'supergeante', nom: 'Supergéante rouge', weight: 5, color: 0xff4b2f, glow: 0xff2200, radius: 150, bodies: 1, killRadius: 200, neutronPeriod: -1, blackHole: false, supernovaDelay: 840, energyBonus: 1, desc: 'SUPERNOVA dans 14 min. Gagnez avant.' },
};
export const STAR_LIST: StarType[] = ['sol_jaune', 'sol_rouge', 'sol_bleu', 'sol_violet', 'naine_blanche', 'binaire', 'triple', 'neutron', 'trou_noir', 'supergeante'];

// ---------- Planètes ----------
export interface PlanetTypeDef { id: PlanetType; nom: string; colors: number[]; hasRing?: boolean }
export const PLANET_TYPES: Record<PlanetType, PlanetTypeDef> = {
  tellurique: { id: 'tellurique', nom: 'Tellurique', colors: [0x8a7a5f, 0x6f8a5f, 0x4a6f8a] },
  glace: { id: 'glace', nom: 'Glacée', colors: [0xbfe8ff, 0x8fc8e8, 0xe8f4ff] },
  lave: { id: 'lave', nom: 'Volcanique', colors: [0x3a2a24, 0xff5d2a, 0x8a3a24] },
  gazeuse: { id: 'gazeuse', nom: 'Gazeuse', colors: [0xc8a86b, 0xa8c86b, 0x6ba8c8], hasRing: true },
  oceanique: { id: 'oceanique', nom: 'Océanique', colors: [0x2a5f8a, 0x3a7fb0, 0x8ac8e8] },
  desert: { id: 'desert', nom: 'Désertique', colors: [0xd8b878, 0xc89858, 0xe8d8a8] },
};
export const PLANET_TYPE_LIST: PlanetType[] = ['tellurique', 'glace', 'lave', 'gazeuse', 'oceanique', 'desert'];
export const PLANET_NAMES = ['Kepler', 'Thessia', 'Vorash', 'Ilos', 'Rannoch', 'Eden', 'Tuchanka', 'Noveria', 'Feros', 'Virmire', 'Horizon', 'Elysium', 'Terra Nova', 'Onyx', 'Cyrene'];

// ---------- Divers gameplay ----------
export const RESPAWN_DELAY = 4;
export const PIRATE_FIRST_RAID = 100;      // premier raid (s)
export const PIRATE_RAID_PERIOD = [70, 130] as const;
export const HULL_REGEN_DELAY = 25;        // s sans dégât avant régén
export const HULL_REGEN_RATE = 3;          // pv/s
export const SHIELD_RECHARGE_RATE = 8;     // pts/s (puise dans l'énergie)
export const ENERGY_REGEN = 9;             // pts/s
export const SALVAGE_RANGE = 18;
export const DOCK_RANGE = 60;
export const MINING_RANGE = 34;
export const MINING_RATE = 6;              // unités/s
export const DIFF_MULT = { facile: 0.6, normal: 1.0, difficile: 1.45 };
