# client · Client (Cocos Creator)

> [简体中文](README.md) | English

> This is **the root directory of the Cocos Creator project** — open this directory in Cocos Creator, not the repository root.
>
> Project overview: [../README.en.md](../README.en.md); client questions: [FAQ.en.md](FAQ.en.md);
> admin questions: [../admin/README.en.md](../admin/README.en.md); cross-side FAQ: [../FAQ.en.md](../FAQ.en.md). The English edition of the server document lands in a follow-up issue and will be linked here once available.

A **Cocos Creator 3.8.7** prototype of 2D character growth and equipment gameplay, covering login, character selection, map exploration, combat, the bag and the mall,
plus three growth lines (war soul / title / rank). The server is authoritative for character data; the local copy is only a cache.
**Monster instances, damage settlement, drop rolling and bag writes are server-side too** (#581): entering a map only
sends `sendWorldJoin`, incoming instances become nodes, incoming rewards are played out, and clicking a ground item only
sends a pick request — there is no local fallback that "computes it anyway" when the server is unreachable.

## Requirements

- **Cocos Creator 3.8.7** (the project uses its bundled `tsc` for typechecking; TypeScript need not be installed separately)
- Node.js (only for running the local unit tests and config generators under `tools/`; it takes no part in bundling)
- A running server (see [../server/README.md](../server/README.en.md)) — login and the character list need it

## How to open and preview

1. Install and start Cocos Creator 3.8.7;
2. Open **this directory** (`client/`) through Creator's **Open Project**;
3. Open a scene under `assets/scenes` in the editor;
4. Run it with the preview or play button.

> On first open, Creator regenerates `library/` and `temp/` (neither goes into version control; whatever ships with the project is just cache and can be deleted and rebuilt).
>
> The project has no npm scripts: launching and previewing always go through the Cocos Creator editor.

## Scenes

| Scene | What it does |
| --- | --- |
| Login | Account registration / login, gets the token from the server |
| Character selection | Character list and creation, entering the game, deleting a character in manage mode; the complete server data for a character is pulled from here before entering the game |
| Loading | Map transition (with a progress display) |
| Game | The main loop: map / combat / HUD / various dialogs |

## Which server it connects to

**The single source is `baseUrl` in `assets/configs/network.ts`**, and one switch decides the environment:
dev mode (`DEV_MODE = true`) uses `http://<page host>:3100/api`, a packaged build uses same-origin `/api`.

**On-device LAN debugging needs no configuration**: in dev mode the API host follows **the current page** —
opening the preview on your machine gives `localhost`, opening it from a phone via the machine's LAN IP gives
that IP (`localhost` on a phone means the phone itself). The server side must match: leave `SERVER_HOST`
empty to listen on all interfaces, and the startup log prints the address to type on the phone
(the save process and the realtime process share this value — opening up only the former gives you
"login works, but entering a map disconnects").
There is no second address literal anywhere in the code — `node ../tools/audit-api-hardcode.cjs` watches that.

## Three iron rules

1. **Core code only decides "how it runs"; everything tunable lives in `assets/configs`**
   Numbers, text, layout, colours, durations and asset paths are never written into logic. Self-check: `node ../tools/audit-config-leak.cjs`
   - All text goes through `configs/texts` (templates use `{placeholder}`, read them with `getText(key, params)`), and no Chinese is written into code
   - Layout goes through `configs/layout/*`, whose barrel entry is `configs/hudLayout`
   - `configs/` and `types/` **do not depend on the UI layer** (configs describe data only; callbacks and branches stay in components)
   - **Data has exactly one home: the database** (factory copy = `server/data/config-sync.sql`, written by `make config-export` and checked by `make config-check`). The matching `configs/*.ts` files are **empty runtime tables**, rebuilt wholesale from the config snapshot on entering the game — **do not write data into them again**, that would just create a second truth
   - **"Who owns this data, where do I change it, when does the client get it" → see [`CONFIG-DATA.md`](CONFIG-DATA.md)** (snapshot segment / apply function / client table / database table / admin page)
2. **The API files are generated, never hand-edited**
   `assets/ui/utils/net/{ApiRoutes,ApiModels,Api}.ts` are generated from the server Swagger document (see [../FAQ.en.md](../FAQ.en.md#why-are-the-api-files-paths--types--methods-generated-what-do-i-touch-to-add-an-endpoint)).
   To add an endpoint → change the server → `cd server && npm run gen:api` → fix call sites by following the compile errors.
3. **The single home for a tunable value is `configs`**; keeping a second copy anywhere else drifts sooner or later. Segment 1 of `audit-config-leak` exists specifically to catch that.
   Turned around: a tunable value belongs to exactly one table in the database — the client only holds runtime containers that the snapshot fills. Editing a `configs/*.ts` file to "add data" recreates the second truth this rule exists to prevent.

## Directory structure

```
client/                          ← Cocos project root (open this in Creator)
├── assets/
│   ├── configs/                 numbers and static config (one file per domain)
│   │   ├── texts.ts             ← every player-facing string
│   │   ├── network.ts           ← single source for the server address
│   │   ├── layout/              UI layout and styling (hud/dialogs/panels/scenes/…)
│   │   ├── growth.ts            growth-curve leftovers (equipment prefix/suffix rates / recycle-price curve / roleMaxLevel runtime value; the curves themselves live in the server growth-seed, #590)
│   │   └── …                    role/monster/skill/equipments/items/drop/map/status/border/background/title/light/mall/announcement
│   ├── types/                   pure type declarations
│   ├── entities/                runtime entities (Role)
│   ├── skills/                  skill behaviour implementations (depend only on SkillContext, never look globals up)
│   ├── ui/
│   │   ├── core/                static managers (GameHelper/LayerManager/MonsterManager/MonsterAI/
│   │   │                        DropManager/SkillManager/StatusManager/EffectManager/AutoBattle/
│   │   │                        PreloadManager/StorageManager/RoleUIManager/SceneManager/AnnouncementReadStore)
│   │   ├── components/          grouped by responsibility (hud/panel/dialogs/role/input/map)
│   │   ├── helpers/             UI construction (UiHelper base wrapper / GameUiHelper parts library / AnimationHelper frame animation)
│   │   ├── utils/               pure functions, split by domain (battle/drop/map/physics/resource/input/cursor/layout/node)
│   │   └── utils/net/           every access to the server (including 3 generated files)
│   ├── resources/               asset directory (map tmx, frame animations, atlases, icons, UI art; not version controlled)
│   └── scenes/                  login, character selection, Loading, game
├── tools/                       client-only scripts (see below)
├── build-templates/web-desktop/ build-template override: canvas fills the window, no fixed frame (see the FAQ entry on why the view used to ignore the window)
├── settings/ · profiles/ · native/ · .creator/   Cocos project configuration
├── package.json · tsconfig.json                 Cocos project description (not npm scripts)
└── library/ · temp/ · build/                    Cocos cache and build output (not version controlled)
```

## Client tools (`tools/`)

All of them are **local verification scripts** that take no part in bundling; run them directly with `node` from the `client/` directory.

> The repository-root `make` targets are shortcuts for these actions: `make client-check` (typecheck) ·
> `make client-test` · `make client-test-one T=test-bag-tidy` ·
> `make client-gen-monster` / `make client-gen-drops` ·
> `make client-clean-frames[-apply]` · `make client-open`. `make help` lists everything.

### Unit tests

The scripts locate Cocos Creator's bundled `tsc` themselves (`TSC=/path/to/tsc node …` overrides it manually).

```bash
cd client
for t in tools/test-*.cjs; do node "$t" || exit 1; done      # run everything
node tools/test-bag-tidy.cjs                                 # run one suite
```

| Group | Scripts |
| --- | --- |
| Bag | `test-bag-tidy` (tidy sorting) · `test-bag-drag` (drag to swap cells) · `test-bag-recycle` (recycle all) · `test-bag-discard` (discard / drag out to destroy) |
| Equipment and items | `test-equipment-appearance` (appearance slicing) · `test-equipment-border` (quality border) · `test-equipment-detail-background` (detail background) · `test-equipment-light` (drop light pillar) · `test-good-detail-placement` (detail dialog placement) · `test-drop-name` (drop names) |
| Growth | `test-rank` (rank) · `test-title` (title) · `test-hp-recover` (health per second) · `test-role-default-cloth` (default body) |
| Interface and input | `test-dialog-top` (dialog raise to top) · `test-joystick` (movement joystick) · `test-scene-stage` (login / character selection full-screen fit) · `test-announcement` (announcement display: sorting / unread / time window / login notice / read records) |
| Config and assets | `test-monster-config` (monster config and geometry) · `test-role-frames` (character frame assets) · `test-texts` (text templates) · `test-skill-decouple` (skill data decoupled from implementations: field-by-field values for all 12 skills / zero engine dependency in the data module / id→implementation identity) · `test-skill-snapshot` (skill / status snapshot overwrite and cast limits: in-place overwrite / owner split / omitted combat dimensions stay undefined / wiring source assertions) · `test-equip-align-apply` (equipment appearance geometry delivered from the server: base key hits all 15 variants / asset paths untouched / nude model per sex / deleting the row restores the factory value / geometry is re-fetched on every entry) |
| Networking and saves | `test-client-net` (network layer: envelope unwrap / token / silent / debounced sync) · `test-role-delete` (deleting a character and "kicked offline") · `test-mall` (mall purchase chain) |

### Config generators (output is never hand-edited)

| Script | Produces | Notes |
| --- | --- | --- |
| `gen-monster-config.cjs` | writes the geometry columns of the server's `monster_presentation` table | Monster presentation manifest: geometry measured from atlas plist base frames (the client keeps no copy); the measurement rules live in the script header, rerun `make monster-config` after changing them |
| `clean-role-empty-frames.cjs` | cleans up empty frame assets | Dry-run lists entries first, `--apply` actually acts; it backs up to the repository-root `.workbuddy/backup/` beforehand |

### Unit test sandbox (`tools/lib/`)

`configs-sandbox.cjs` / `storage-sandbox.cjs` / `layer-sandbox.cjs` / `net-sandbox.cjs`
— **the real core code** is copied into a temporary directory, only the imports pointing at the UI layer are swapped for stubs, and a minimal `cc` shim stands in for the engine,
so node can assert against real config tables, the real `StorageManager`, the real `LayerManager` and the real network layer (rather than a reimplementation).
Details: [FAQ.en.md](FAQ.en.md#how-do-unit-tests-run-real-cocos-code-in-node).

## Typechecking

The project installs no TypeScript; it uses the one bundled with Cocos Creator:

```bash
cd client
/Applications/Cocos/Creator/3.8.7/CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin/tsc \
  -p tools/tsconfig.check.json
```

`tools/tsconfig.check.json` is a hand-written check config (not generated by Cocos, and **committed to the repository**), enabling only `noUnusedLocals`, with **all paths relative** so moving the project does not break it.
It lives in `tools/` rather than `temp/` because `temp/` is wholesale rebuilt by Cocos and is not version controlled. `temp/tsconfig.cocos.json` is the Cocos-generated one, which `tsconfig.json` extends.

## A few client-specific mechanisms

Worth knowing before changing client code (pitfalls are detailed in [FAQ.en.md](FAQ.en.md)):

- **Single exit for persistence**: `StorageManager.updateOnlineRole` — it is simultaneously **the only trigger for syncing to the server**, so no gameplay system needs its own save call
- **Where floating tips mount**: always through `GameUiHelper.createTip / createErrorTip / createTipText / createErrorTipText`, which internally pick the mount point by "is the container in the current scene" (the UI layer in game, the scene root on login / character selection). **Business code must never call `addToUILayer(tip)` directly**
- **Dialog layering = raise on click**: always through `LayerManager.addDialogToUILayer` + `GameUiHelper.bindDialogRaiseOnPress`; temporary layers (tips / hover details) / HUD / the death mask still use `addToUILayer`
- **Three input channels**: keyboard > joystick > mouse (priority in `getMoveIntent`); register only `TOUCH_*`, and **never register `MOUSE_*` on a node**
  (the engine simulates mouse events as touch, so mixing registrations dispatches twice; `MOUSE_MOVE` registered on a node also swallows global pointer tracking)
- **`isValid(node)` does not check "pending destroy"**: pair invalidence checks with data checks instead of trusting `isValid` alone
- **`[...map.values()]` is forbidden**: bundling compiles iterator spread in loose mode down to `[].concat()` (always a single element),
  so convert with `Array.from` / `forEach` only — this pitfall surfaces only in bundled output and does not raise an error

## Data ownership: the client holds zero monster data (#588)

Every piece of monster data lives on the server; the client keeps only one purely presentational
constant (region 15 of `configs/game-config.ts`: `monsterDefaultSpeedRate` = the 11-action speed-rate
baseline). **Behaviour parameters (attack interval / range / cast lock / idle wander rhythm / push
duration) moved to the server in #670** — their single source is the `runtime_params.monster_ai` row,
and keeping a copy on the client would only invite a second AI to grow back locally. **Before changing anything, be clear which kind of data you are touching**:

| Kind | Fields | Single source | How a change takes effect |
|---|---|---|---|
| Numbers | `label` / `level` / `tier` / `maxHp` / six attack & defence ranges | server table `monsters` (factory values expanded from `server/data/config-sync.sql`, editable in admin) | takes effect on save; the client pulls a snapshot on next login |
| Presentation | `icon` / `out` / `outOffset` / `contentSize` / `moveSpeed` / `aggressive` / `detectRange` / `speedRate` overrides | server table `monster_presentation` (geometry columns written by `client/tools/gen-monster-config.cjs` from measured atlas plists, editable in admin) | rerun the generator (or edit in admin) + restart the server |
| Drops | per-monster drop tables | server table `monster_drops` (edited in admin) | takes effect on save |

The two client runtime maps (`monsterRuntime` / `monsterResource` in region 16 of
`configs/game-config.ts`) are filled entirely from the snapshot: the
numeric rows via `applyMonsterRows`, the presentation rows via `applyMonsterPresentations`. There is
**no local copy** — a missing snapshot row degrades numbers to "label = key, attack/defence [0,0]"
(warned once), and a missing presentation row makes spawn skip the monster entirely (a monster that
cannot be rendered is worse than no monster). Ownership is enforced by a guard
(`node ../tools/audit-world-authority.cjs`: the monster regions must not grow numeric fields again, the runtime
maps must be filled by both snapshot segments, and MonsterManager must not keep its own monster data).

**Adding a monster = three steps**: 1) get the assets in and run `client/tools/gen-monster-config.cjs`;
2) add one row in the admin "monsters" page (the database is the only place numbers are written; run
`make config-export` so the new row becomes part of the factory snapshot);
3) restart the server (the new key seeds itself). The key set is cross-checked in both directions
across asset directories / seed / drop tables — missing one side is an error.

**Where monsters live is not the client's call either**: spawn areas (position / area size / count) live in the
server table `map_spawn_areas`, and the client must not spawn from the TMX on its own (#581). A spawn area also
has to sit entirely inside the map rectangle — world coordinates start at the map's top-left corner with y
pointing up, so anything outside `[0, width] × [-height, 0]` is out of bounds (#566 / #586; the admin map page
marks it red).

## Assets

`assets/resources` is large and **not version controlled** (see the repository-root `.gitignore`). Contact the repository author for the assets.
Always back up before deleting or editing assets: `assets/resources` is outside git's protection.

> Note: **an asset's file extension must match its real format**. Historically a batch of "`.png` shell + BMP core" empty frame assets made Cocos spam errors;
> the cleanup tool is `tools/clean-role-empty-frames.cjs`.

## Related documents

- [FAQ.en.md](FAQ.en.md) — preview errors, engine pitfalls, how to tune gameplay config
- [../README.en.md](../README.en.md) — project overview, directory structure, feature list
- [../FAQ.en.md](../FAQ.en.md) — cross-side mechanics (single source of truth for addresses, contract pipeline, three-side interaction)
- [../server/README.md](../server/README.en.md) — the server the client depends on
