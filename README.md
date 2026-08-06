# COBALT SECTOR

Jeu de **stratégie / action spatiale en vue satellite (2.5D)**, low-poly, parties d'environ 20 minutes.
Solo contre 1 à 3 IA à personnalités (+ une flotte pirate neutre), 4 équipes : Rouge, Bleu, Vert, Jaune.

## Lancer le jeu

```bash
npm install
npm run dev
```

Puis ouvrir http://localhost:5173

- `npm run build` : build de production (dossier `dist/`)
- `npm run typecheck` : vérification TypeScript
- Test headless (simule des parties complètes sans navigateur) :
  `npx esbuild test/headless.ts --bundle --platform=node --format=cjs --outfile=.tmp-headless.cjs && node .tmp-headless.cjs`

## Contrôles (AZERTY natif — fonctionne aussi en QWERTY)

| Touche | Action |
|---|---|
| `Z Q S D` | Déplacer le vaisseau (vue action) / la carte (vue tactique) |
| Clic gauche / `Espace` | Arme principale (visée au curseur, arc + flèche) |
| `A` (maintenir) | Verrouillage missile — relâcher quand le réticule passe au vert |
| `E` | Arme secondaire |
| Clic molette | Lancer une mine vers le curseur (frag / EMP / aimant selon le vaisseau) |
| `F` (maintenir) | Miner l'astéroïde ou le nuage de gaz proche |
| `C` | Prendre le contrôle du vaisseau allié le plus proche |
| `& é " '` | Modes : croisière, radar, espion, saut spatial |
| `( - è _ ç` | Gadgets (fumée, camouflage, bouclier orbital, frappe orbitale, flotte de soutien) |
| `B` | Menu construction (avant-poste, mine spatiale, satellite) |
| `U` | Boutique de la station (amarré) : vaisseaux, armes, améliorations, niveaux de station |
| Molette | Zoom — dézoomer à fond ouvre la **vue tactique** |
| Double-clic (+ glisser) | Sélection (Ctrl = ajouter ; clic simple suffit en vue tactique) |
| `J` | Diplomatie : alliances, cibles communes (les IA font aussi des offres) |
| Clic droit | Menu d'ordres : attaquer, miner, escorter, coloniser, commercer… |
| `Échap` | Fermer les panneaux / pause |

## Boucle de jeu

- **Économie** : minez roche/minerai/gaz (vente auto en vous amarrant), colonisez des planètes
  (transporteur requis) pour un revenu périodique, construisez des mines spatiales près des
  astéroïdes, faites du commerce avec des cargos. Les épaves rapportent des crédits.
- **Militaire** : recrutez chasseurs, bombardiers, croiseurs ; créez des **flottes** en vue
  tactique (chef + membres + mission : attaque, escorte, minage auto, patrouilles int./bordure/ext.)
  avec 4 formations — les vaisseaux armés d'une flotte de minage escortent les mineurs.
- **Diplomatie** : alliances (vision partagée, commerce, cibles communes) — les IA proposent aussi.
- **Station** : 3 niveaux — débloque de nouvelles classes de vaisseaux et des gadgets.
- **Victoire** : détruisez les stations ennemies. Mort subite à 20 min, fin au score à 28 min.
- **Systèmes stellaires** : soleils jaune/rouge/bleu/violet (rare, +50 % d'énergie), naine
  blanche, systèmes binaire/triple, étoile à neutrons (impulsions EMP), trou noir (gravité),
  supergéante rouge (supernova à 14 min — gagnez avant !).
- **Pirates gris** : raids périodiques qui chassent vos vaisseaux civils et fuient les
  flottes plus puissantes qu'eux.

À votre mort : réapparition en corvette à votre station, améliorations conservées, cargaison perdue.
Le bouclier se recharge sur l'énergie ; sans bouclier ni énergie, la coque ne se régénère plus.

## Architecture (multijoueur-ready)

```
src/
  core.ts      Types, maths, RNG déterministe, état de jeu
  data.ts      Données : classes de vaisseaux, armes, gadgets, étoiles, personnalités IA
  world.ts     Génération procédurale de la carte
  entities.ts  Constructeurs d'entités + requêtes spatiales
  orders.ts    Ordres, flottes, formations
  sim.ts       Simulation à pas fixe (60 Hz) : physique, combat, économie, événements
  ai.ts        IA d'équipe (5 personnalités) + pirates
  meshes.ts    Constructeurs low-poly procéduraux (Three.js)
  render3d.ts  Rendu 2.5D, caméra action/tactique, effets
  hud.ts       Interface (radar, badges, boutique, menus)
  input.ts     Entrées via event.code (AZERTY/QWERTY natif)
  sfx.ts       Sons synthétisés WebAudio (zéro asset)
  main.ts      Boucle de jeu et liaison
```

La simulation est **déterministe** (RNG seedé, pas fixe, ordres = commandes sérialisables) :
prête pour un futur multijoueur LAN en lockstep. Debug : `__cobalt.step(30)` dans la console
avance la partie de 30 s.
