# client · Client (Cocos Creator)

> [简体中文](README.md) | English

> This is **the root directory of the Cocos Creator project** — open this directory in Cocos Creator, not the repository root.
>
> Project overview: [../README.en.md](../README.en.md); client questions: [FAQ.en.md](FAQ.en.md);
> admin questions: [../admin/README.en.md](../admin/README.en.md); cross-side FAQ: [../FAQ.en.md](../FAQ.en.md). The English edition of the server document lands in a follow-up issue and will be linked here once available.

A **Cocos Creator 3.8.7** prototype of 2D character growth and equipment gameplay, covering login, character selection, map exploration, combat, the bag and the mall,
plus three growth lines (war soul / title / rank). The server is authoritative for character data; the local copy is only a cache.

## Requirements

- **Cocos Creator 3.8.7** (the project uses its bundled `tsc` for typechecking; TypeScript need not be installed separately)
- Node.js (only for running the local unit tests and config generators under `tools/`; it takes no part in bundling)
- A running server (see [../server/README.md](../server/README.md)) — login and the character list need it

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

**The single source is `baseUrl` in `assets/configs/network.ts`** (default `http://localhost:3100/api`).
Switch it to a LAN IP for on-device debugging. There is no second address literal anywhere in the code — `node ../tools/audit-api-hardcode.cjs` watches that.

## Three iron rules

1. **Core code only decides "how it runs"; everything tunable lives in `assets/configs`**
   Numbers, text, layout, colours, durations and asset paths are never written into logic. Self-check: `node ../tools/audit-config-leak.cjs`
   - All text goes through `configs/texts` (templates use `{placeholder}`, read them with `getText(key, params)`), and no Chinese is written into code
   - Layout goes through `configs/layout/*`, whose barrel entry is `configs/hudLayout`
   - `configs/` and `types/` **do not depend on the UI layer** (configs describe data only; callbacks and branches stay in components)
2. **The API files are generated, never hand-edited**
   `assets/ui/utils/net/{ApiRoutes,ApiModels,Api}.ts` are generated from the server Swagger document (see [../FAQ.en.md](../FAQ.en.md#why-are-the-api-files-paths--types--methods-generated-what-do-i-touch-to-add-an-endpoint)).
   To add an endpoint → change the server → `cd server && npm run gen:api` → fix call sites by following the compile errors.
3. **The single home for a tunable value is `configs`**; keeping a second copy anywhere else drifts sooner or later. Segment 1 of `audit-config-leak` exists specifically to catch that.

## Directory structure

```
client/                          ← Cocos project root (open this in Creator)
├── assets/
│   ├── configs/                 numbers and static config (one file per domain)
│   │   ├── texts.ts             ← every player-facing string
│   │   ├── network.ts           ← single source for the server address
│   │   ├── layout/              UI layout and styling (hud/dialogs/panels/scenes/…)
│   │   ├── growth.ts            growth curve (shared piecewise-linear setup for level/equipment/monster/war soul/title/rank)
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

### Unit tests (25 suites)

The scripts locate Cocos Creator's bundled `tsc` themselves (`TSC=/path/to/tsc node …` overrides it manually).

```bash
cd client
for t in tools/test-*.cjs; do node "$t" || exit 1; done      # run everything
node tools/test-bag-tidy.cjs                                 # run one suite
```

| Group | Scripts |
| --- | --- |
| Bag | `test-bag-tidy` (tidy sorting) · `test-bag-drag` (drag to swap cells) · `test-bag-recycle` (recycle all) · `test-bag-discard` (discard / drag out to destroy) · `test-new-role-bag` (starter bag) |
| Equipment and items | `test-equipment-appearance` (appearance slicing) · `test-equipment-border` (quality border) · `test-equipment-detail-background` (detail background) · `test-equipment-light` (drop light pillar) · `test-good-detail-placement` (detail dialog placement) · `test-drop-name` (drop names) |
| Growth | `test-rank` (rank) · `test-title` (title) · `test-hp-recover` (health per second) · `test-role-default-cloth` (default body) |
| Interface and input | `test-dialog-top` (dialog raise to top) · `test-joystick` (movement joystick) · `test-scene-stage` (login / character selection full-screen fit) · `test-announcement` (announcement display: sorting / unread / time window / login notice / read records) |
| Config and assets | `test-monster-config` (monster config and geometry) · `test-role-frames` (character frame assets) · `test-texts` (text templates) |
| Networking and saves | `test-client-net` (network layer: envelope unwrap / token / silent / debounced sync) · `test-role-delete` (deleting a character and "kicked offline") · `test-mall` (mall purchase chain) |

### Config generators (output is never hand-edited)

| Script | Produces | Notes |
| --- | --- | --- |
| `gen-monster-config.cjs` | `assets/configs/monster.ts` | Geometry measured from asset `.meta` auto-trim data (no PNG decoding); rules are written in the script header, rerun after changing them |
| `gen-monster-drops.cjs` | `assets/configs/monsterDrops.ts` | One independent drop table per monster |
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

## Assets

`assets/resources` is large and **not version controlled** (see the repository-root `.gitignore`). Contact the repository author for the assets.
Always back up before deleting or editing assets: `assets/resources` is outside git's protection.

> Note: **an asset's file extension must match its real format**. Historically a batch of "`.png` shell + BMP core" empty frame assets made Cocos spam errors;
> the cleanup tool is `tools/clean-role-empty-frames.cjs`.

## Related documents

- [FAQ.en.md](FAQ.en.md) — preview errors, engine pitfalls, how to tune gameplay config
- [../README.en.md](../README.en.md) — project overview, directory structure, feature list
- [../FAQ.en.md](../FAQ.en.md) — cross-side mechanics (single source of truth for addresses, contract pipeline, three-side interaction)
- [../server/README.md](../server/README.md) — the server the client depends on
