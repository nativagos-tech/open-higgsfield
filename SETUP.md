# Installation locale — notes de reprise

Journal de mise en route sur macOS (18 septembre 2026), pour repartir sur une
autre machine sans refaire l'analyse. Le README décrit l'app ; ce fichier décrit
ce qu'il faut faire *autour* pour qu'elle tourne.

## Prérequis

- **Node ≥ 20.9** (Next 16 l'exige). Testé avec Node 20.20.
- **pnpm 10** via corepack. pnpm 12 a changé de layout binaire et corepack 0.34
  ne sait pas le lancer (`Cannot find module .../pnpm/12.x/bin/pnpm.cjs`) :

  ```bash
  rm -rf ~/.cache/node/corepack          # seulement si l'erreur ci-dessus apparaît
  corepack enable
  corepack prepare pnpm@10 --activate
  ```

- Le lockfile est en v9 → compatible pnpm 10.

## Installation

```bash
git clone <ce repo> && cd HIGGSFIELD
CI=true pnpm install       # CI=true évite l'invite TTY si node_modules existe déjà
cp .env.example .env       # puis remplir, voir ci-dessous
pnpm dev                   # http://localhost:3000
```

## Variables d'environnement (`.env`, non commité)

| Variable | Valeur | Obligatoire |
| --- | --- | --- |
| `HF_API_BASE_URL` | `https://platform.higgsfield.ai` (fonctionne ; la doc récente indique `https://api.higgsfield.ai`, même API) | Oui |
| `OPEN_HIGGSFIELD_READ_WRITE_TOKEN` | Token **Vercel Blob** read-write (Vercel → Storage → Blob → créer un store) | Seulement pour uploader des médias d'entrée (start/end frame, références). Text-to-image et text-to-video tournent sans. |
| `ANTHROPIC_API_KEY` | Clé API Anthropic (console.anthropic.com) | Seulement pour l'onglet « From a brief » et « Polish with AI » de l'assistant de prompt. L'onglet « Build » (formulaire) fonctionne sans. Chaque appel coûte quelques centimes (Claude Opus 5). |

Higgsfield doit pouvoir **télécharger** les médias d'entrée, donc ils doivent
être sur une URL publique — Vercel Blob s'en charge ; un serveur local ne suffit pas.

## Clé API (saisie dans l'UI, pas dans `.env`)

- Compte **Higgsfield API** (console.higgsfield.ai), facturation séparée de
  l'abonnement higgsfield.ai. Créer une clé dans *API Keys* : on obtient un
  **Key ID** et un **Key Secret** (affiché une seule fois).
- Dans l'app : bouton **Add key** → coller `KEY_ID:KEY_SECRET` (les deux, séparés
  par `:`). Le message `API key must be id:secret` signifie qu'il manque une des
  deux moitiés.
- La clé est stockée dans un cookie httpOnly (30 jours), donc **par navigateur** :
  à ressaisir sur chaque machine.
- Vérifier une clé hors app :
  `curl -H "Authorization: Key ID:SECRET" https://platform.higgsfield.ai/requests/x/status`
  → `Invalid credentials` = clé fausse, autre réponse = clé OK.

## Diagnostic

Le serveur dev logge chaque appel plateforme (`[platform] request` / `response`)
avec l'URL, le body envoyé et la réponse brute. C'est là qu'il faut regarder en
premier : un `400 … is not one of [...]` est presque toujours un écart entre le
catalogue local et ce que l'API accepte réellement (voir ci-dessous).

## Catalogue : ce qui a été corrigé et ce qui reste à vérifier

Le catalogue (`src/generation/catalog/`) est écrit à la main, il n'est pas
synchronisé avec l'API. Deux conséquences :

1. **Modèles absents** — *Marketing Studio Image* est maintenant ajouté
   (`POST /marketing-studio/image`, résolution `1k|2k|4k`, ratio
   `auto|1:1|3:2|2:3|4:3|3:4|16:9|9:16|21:9`, `quality low|medium|high`,
   jusqu'à 16 `image_urls` en référence pour l'édition), en **mode direct
   uniquement** : `enhance_prompt` reste à `false`. Le mode enhanced exige un
   `preset_id` tiré d'un catalogue paginé (`GET /marketing-studio/image/presets`),
   géré dans leur CMS — pas représentable en enum statique, à faire plus tard si
   besoin. Référence : console.higgsfield.ai → modèle → onglet *API*.
2. **Réglages faux** — `videoModel()` dans `defaults.ts` donne à tous les modèles
   vidéo génériques `720p/1080p`, ratio `16:9|9:16|1:1`, durée 4–10 s. Ce n'est
   pas ce que chaque modèle accepte.
   - **MiniMax H3** corrigé : `2K` uniquement, ratio
     `auto|adaptive|21:9|16:9|4:3|1:1|3:4|9:16`, durée 5–15 s.
   - **Kling 2.5 Turbo** (Standard + Pro) corrigé : `duration 5|10`, `cfg_scale 0–1`,
     pas de ratio ni de résolution.
   - **Non audités** : Hailuo 2.3, Wan 2.6/2.7/3, LTX, PixVerse, Grok, Happy
     Horse… Même méthode : comparer avec la page playground du modèle sur
     console.higgsfield.ai (les modèles ne sont pas tous dans docs.higgsfield.ai
     ni dans `/docs/openapi.json`).

`parseSettings` a maintenant un mode `lenient` utilisé côté client : quand une
valeur mémorisée en localStorage n'est plus valide après une correction de
catalogue, elle retombe sur le défaut au lieu de casser le composer. Le serveur
reste strict.

## Modèles ajoutés le 19/09/2026 (source : console.higgsfield.ai)

Soul Standard, Genjutsu Motion Transfer, Genjutsu Object Swap
(`higgsfiled/genjutsu/...` — la faute est dans le chemin officiel), Kling 2.5
Turbo Pro. Genjutsu prend 1 vidéo source obligatoire + jusqu'à 8 images, et
facture à la seconde de vidéo d'entrée.

Hors périmètre : la section « Workflows & agents » de la console (Product shots,
Graphic ads, Marketplace design, Cinema Studio 4.0) — pipelines multi-étapes,
pas des modèles à requête unique.

## Modèles probablement retirés de l'API

Au 19/09/2026, **Soul Cinema, DoP et Flux 3** n'ont plus de page dans la console
ni de résultat de recherche. Ils sont conservés dans le catalogue faute d'un test
qui confirme l'échec ; à retirer (comme Veo 3.1 / Nano Banana avant eux) si une
génération renvoie 404. **Flux 2** est aussi absent de la console mais fonctionne
(références comprises) : la console n'est donc pas exhaustive.

## Modèles image : qui lit vraiment les références (audit du 19/09/2026)

Le helper `imageModel()` donnait 8 références à tous les modèles image et
`mapByPaths` les envoyait en `image_urls` — que l'endpoint les accepte ou non.
L'API répond 200 et ignore le champ : le modèle génère sans voir les images.
Corrigé d'après les schémas de la console :

| Modèle | Images d'entrée | Notes |
| --- | --- | --- |
| Marketing Studio Image | `image_urls` ×16 | |
| Flux 2 | oui | constaté |
| Grok Imagine 2.0 | `image_urls` | résolution 1k/2k, `quality low|medium` |
| Ideogram 4.0 | **une** `image_url` + `image_weight` | pas de `resolution` ; `rendering_speed` |
| Qwen Image 3 Edit (nouveau) | `image_urls` ×1–3 **obligatoires** | `alibaba/qwen-image-3/edit` |
| Qwen Image 3, Recraft 4.1, Z-Image Turbo, Soul | **aucune** | tray masqué ; Recraft 1k seul ; Z-Image prompt ≤ 800 car. |

## Assistant de prompt (composer → icône étincelle)

Deux onglets. **Build** : un formulaire par bloc (sujet, action, décor,
lumière, caméra, style, son, contraintes) dont les champs obligatoires /
masqués dépendent du modèle sélectionné (`src/prompting/profiles.ts`, dérivé de
`PROMPTS.md` §3–4) ; le prompt est assemblé en direct (`assemble.ts`) puis
inséré dans le composer. **From a brief** : un brief libre (toute langue) →
Claude rédige le prompt anglais final avec le méta-prompt de `PROMPTS.md` §5
plus la fiche du modèle (`src/prompting/actions.ts`, nécessite
`ANTHROPIC_API_KEY`). « Polish with AI » envoie les champs du formulaire au
même circuit. Pour ajuster les règles d'un modèle : éditer son profil dans
`profiles.ts`, et garder `PROMPTS.md` cohérent.

## Guide des modèles

`MODELS.md` décrit, pour chaque modèle du catalogue, sa singularité et son usage
prioritaire, avec un tableau « Choisir vite » par besoin. `PROMPTS.md` donne la
structure de prompt idéale (générique + variantes par modèle), un gabarit JSON,
une grille « quoi demander à l'utilisateur » et un méta-prompt pour LLM — base
d'un futur générateur de prompts. Les deux sont servis dans l'app sous
`/docs/models` et `/docs/prompts`. À mettre à jour à chaque ajout ou retrait de
modèle.

## Réordonner le plateau (08/10/2026)

L'ordre des vignettes est celui que la plateforme reçoit et celui que le prompt
doit citer (« the hiker from @Image1 », `PROMPTS.md` §3.6) : il se règle
maintenant en déplaçant la vignette, au lieu de la retirer et de la rajouter.

- **Souris, stylet, tactile** : on attrape la vignette et on la dépose où l'on
  veut. L'ordre se réécrit *pendant* le glisser, pas au relâcher — le plateau
  montre donc toujours ce que le prompt comptera. Rien ne bouge avant quelques
  pixels parcourus (une pression qui ne voyage pas n'est pas un déplacement).
- **Clavier** : la poignée (pastille à six points, en haut à gauche de la
  vignette, visible au survol ou au focus) — Entrée soulève, les flèches
  déplacent, Origine/Fin vont au bout du rôle, Entrée ou Échap repose.
- **Un rôle à la fois** : seules les vignettes du même rôle s'échangent, parce
  que la plateforme reçoit *un tableau par rôle* : une vignette REF ne peut pas
  passer devant un START. Une vignette n'est déplaçable que si son rôle accepte
  plusieurs entrées (`model.roles[role] > 1`) et en porte plus d'une — la
  numérotation et la poignée apparaissent sous la même condition.
- L'ordre est persisté avec le reste du plateau (zustand + localStorage), et
  chaque déplacement est annoncé (`role="status"`) : l'ordre est tout l'objet du
  geste et un lecteur d'écran ne peut pas le voir changer.

Code : `moveMediaItem` (`src/generation/stores/media.ts`) applique l'ordre — un
ordre *interne au rôle*, les autres rôles ne bougent pas ; `dropBefore`
(`src/openhiggsfield/reorder.ts`) lit la géométrie du pointeur (ligne du haut
dépassée, ligne du bas pas encore atteinte, milieu de la vignette comme ligne
de partage dans la ligne courante). Le glisser écoute `window` et non la
vignette : React réinsère le nœud à chaque déplacement, un écouteur posé sur le
nœud perdrait le pointeur en cours de route. Pas de HTML5 drag-and-drop : il
ignore le tactile et ne dit rien pendant le vol.

Vérifié hors navigateur (jsdom + React) sur les deux gestes : seuil, dépôt,
arrêt aux extrémités, poignée absente quand le rôle est unique. **À confirmer à
la main** sur un vrai plateau — le tactile en particulier.

## État au 19/09/2026 (soir) et fils ouverts

Fait : catalogue audité contre la console (44 modèles ; Marketing Studio,
Soul Standard, Genjutsu ×2, Kling 2.5 Turbo Pro, Qwen Image 3 Edit ajoutés ;
MiniMax H3, Kling 2.5, Grok, Ideogram, Recraft, Qwen, Z-Image corrigés),
guides `MODELS.md` / `PROMPTS.md` servis sous `/docs/*` et menu « Guides »,
assistant de prompt (Build + IA), vignettes numérotées. Fork :
github.com/Bizarbizar/open-higgsfield (`origin`), amont `wide-trace` en `upstream`.

À faire / à décider :
- `ANTHROPIC_API_KEY` dans `.env` pour activer « From a brief » et « Polish with
  AI » — le chemin IA de l'assistant n'a pas encore été testé de bout en bout.
- Soul Cinema, DoP, Flux 3 : absents de la console, jamais testés → tester une
  génération et retirer si 404.
- Marketing Studio mode *enhanced* (presets via `GET /marketing-studio/image/presets`).
- Réordonner les références dans le plateau : **fait le 08/10/2026** (section
  « Réordonner le plateau »), à confirmer sur un vrai plateau tactile.
- Modèles vidéo « non audités » (Hailuo 2.3, Wan, LTX, PixVerse, Grok Video,
  Happy Horse, Kling 2.6/O1/O3) : vérifier leurs réglages réels comme pour H3.
- « Workflows & agents » de la console (Product shots, Graphic ads, Cinema
  Studio 4.0) : hors périmètre pour l'instant.

Session Claude Code : https://claude.ai/code/session_012NABabbcX15cE95nYfoEt7

## Fichiers générés par `next dev`

`AGENTS.md`, `CLAUDE.md` et le contenu de `next-env.d.ts` sont réécrits par
Next 16 à chaque `next dev`. Ils sont commités pour garder l'arbre propre.
