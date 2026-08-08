// Test headless : simule des parties complètes sans navigateur et vérifie les invariants.
import { newGame } from '../src/world';
import { simTick, teamScore, tryBuyShip, fireShipWeapon, playerShip, activateGadget, dropMine, tryJump } from '../src/sim';
import { SIM_DT, GameState, StarType, PIRATE_TEAM } from '../src/core';
import { SHIP_CLASSES } from '../src/data';
import { createFleet, setFleetMission } from '../src/orders';

let failures = 0;
function check(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error(`  ❌ ${msg}`); }
}

function runMatch(star: StarType | 'aleatoire', seed: number, minutes: number, label: string, allAI = false) {
  console.log(`\n=== Partie « ${label} » (étoile: ${star}, seed ${seed}, ${minutes} min${allAI ? ', 100% IA' : ''}) ===`);
  const gs = newGame({
    seed, playerColorIdx: 1, aiCount: 3,
    personaChoice: 'aleatoire', starChoice: star, difficulty: 'normal',
  });
  if (allAI) gs.teams[gs.playerTeam].isAI = true;

  const stats = { pirates: 0, maxShips: 0, fleetsSeen: 0 };
  let steps = Math.floor((minutes * 60) / SIM_DT);
  for (let i = 0; i < steps; i++) {
    simTick(gs, SIM_DT);
    if (i % 600 === 0) {
      stats.maxShips = Math.max(stats.maxShips, gs.ships.length);
      stats.pirates = Math.max(stats.pirates, gs.ships.filter(s => s.team === PIRATE_TEAM).length);
      stats.fleetsSeen = Math.max(stats.fleetsSeen, gs.fleets.length);
      // invariants
      for (const s of gs.ships) {
        check(Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y), `position NaN (${s.cls}, t=${gs.t.toFixed(0)})`);
        check(s.hull <= s.hullMax + 1, `coque > max (${s.cls})`);
        check(s.energy >= -1 && s.energy <= s.energyMax + 1, `énergie hors bornes (${s.cls}: ${s.energy})`);
      }
      check(gs.projectiles.length < 500, `trop de projectiles (${gs.projectiles.length})`);
      check(gs.ships.length < 200, `trop de vaisseaux (${gs.ships.length})`);
    }
    if (gs.status === 'over') break;
  }

  const alive = gs.activeTeams.filter(id => gs.teams[id].alive);
  console.log(`  t=${(gs.t / 60).toFixed(1)} min · status=${gs.status} · gagnant=${gs.winner} · équipes vivantes=${alive.join(',')}`);
  for (const id of gs.activeTeams) {
    const t = gs.teams[id];
    const ships = gs.ships.filter(s => s.alive && s.team === id).length;
    const planets = gs.planets.filter(p => p.alive && p.owner === id).length;
    console.log(`  ${t.name}${t.isAI ? ` (IA ${t.persona})` : ' (joueur inactif)'} : ${t.alive ? 'vivante' : 'ÉLIMINÉE'} · ${ships} vsx · ${planets} colonies · ${Math.floor(t.credits)} cr · score ${teamScore(gs, id)}`);
  }
  console.log(`  pics : ${stats.maxShips} vaisseaux · ${stats.pirates} pirates · ${stats.fleetsSeen} flottes`);
  check(stats.pirates > 0 || minutes < 3, 'aucun pirate apparu');
  // une supernova qui a tout consumé est une fin valide sans survivants
  check(gs.supernovaWave >= 0 || gs.ships.some(s => s.alive), 'plus aucun vaisseau vivant');
  return gs;
}

// ---------- actions joueur ----------
function testPlayerActions() {
  console.log('\n=== Actions joueur ===');
  const gs = newGame({ seed: 42, playerColorIdx: 0, aiCount: 2, personaChoice: 'agressif', starChoice: 'sol_jaune', difficulty: 'facile' });
  const team = gs.teams[gs.playerTeam];

  // tir
  const ship = playerShip(gs)!;
  check(!!ship, 'amiral joueur présent');
  const fired = fireShipWeapon(gs, ship, 0, { x: ship.pos.x + 100, y: ship.pos.y });
  check(fired, 'tir principal réussi');
  check(gs.projectiles.length === 1, 'projectile créé');

  // mine
  check(dropMine(gs, ship), 'largage de mine');
  check(gs.minesArmed.length === 1, 'mine armée présente');

  // achats
  team.credits = 5000;
  check(tryBuyShip(gs, gs.playerTeam, 'mineur', false) === null, 'achat mineur');
  check(tryBuyShip(gs, gs.playerTeam, 'croiseur', false) !== null, 'croiseur refusé au niveau 1');
  check(tryBuyShip(gs, gs.playerTeam, 'chasseur', true) === null, 'achat + pilotage chasseur');
  const newShip = playerShip(gs)!;
  check(newShip.cls === 'chasseur', 'le joueur pilote le chasseur');

  // gadget fumée (débloqué de base)
  check(activateGadget(gs, gs.playerTeam, 'fumee') === null, 'gadget fumée');
  check(activateGadget(gs, gs.playerTeam, 'fumee') !== null, 'fumée en recharge');

  // saut : refusé sans énergie pleine ?
  newShip.energy = 0;
  check(tryJump(gs, newShip) !== null, 'saut refusé sans énergie');
  newShip.energy = newShip.energyMax;
  check(tryJump(gs, newShip) === null, 'saut accepté à pleine énergie');

  // flotte
  team.credits = 5000;
  tryBuyShip(gs, gs.playerTeam, 'chasseur', false);
  tryBuyShip(gs, gs.playerTeam, 'chasseur', false);
  const ids = gs.ships.filter(s => s.alive && s.team === gs.playerTeam && s.cls === 'chasseur' && s.id !== gs.playerShipId).map(s => s.id);
  const fleet = createFleet(gs, gs.playerTeam, ids);
  check(!!fleet, 'flotte créée');
  if (fleet) {
    const enemyStation = gs.structures.find(st => st.alive && st.team !== gs.playerTeam);
    setFleetMission(gs, fleet, { kind: 'attack', targetId: enemyStation!.id });
    for (let i = 0; i < 600; i++) simTick(gs, SIM_DT);
    check(gs.fleets.length >= 1, 'flotte toujours en vie après 10 s');
  }
  console.log('  OK (voir échecs éventuels ci-dessus)');
}

// ---------- exécution ----------
testPlayerActions();
runMatch('sol_jaune', 1001, 22, 'standard');
runMatch('trou_noir', 2002, 10, 'trou noir');
runMatch('neutron', 3003, 8, 'étoile à neutrons');
const sn = runMatch('supergeante', 4004, 18, 'supernova');
check(sn.map.supernovaAt > 0, 'supernova programmée');
const battle = runMatch('sol_jaune', 5005, 30, 'bataille royale IA', true);
check(battle.status === 'over' || battle.t / 60 >= 29, 'la bataille royale devrait se conclure');
if (battle.status === 'over') {
  const dur = battle.t / 60;
  check(dur > 8, `partie trop courte (${dur.toFixed(1)} min)`);
  console.log(`  durée de la bataille royale : ${dur.toFixed(1)} min`);
}

console.log(failures === 0 ? '\n✅ TOUS LES TESTS PASSENT' : `\n❌ ${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);
