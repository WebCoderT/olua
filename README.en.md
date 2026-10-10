# olua

> [简体中文](README.md) | English

> **This project is written entirely by AI (Vibe Coding): every line of code in this repository was written by AI — not one line was typed by a human.**
> Humans do two things here — **request features and look at the result**. How it was built and what traces it left: [A project written entirely by AI](#a-project-written-entirely-by-ai).

A 2D character-growth and equipment gameplay prototype built on Cocos Creator 3.8.7, together with a companion NestJS server and a React admin console,
covering login, character creation, character growth, the equipment system, map exploration and combat gameplay (monster fighting / drops / skills / auto-battle) as a complete three-side demo.

## The three sides

The repository splits into three **peer directories**, each with its own README and FAQ; cross-side conventions and mechanisms live in this file and the root [FAQ.en.md](FAQ.en.md).

| Side | What it is | Tech stack | Directory | Docs |
| --- | --- | --- | --- | --- |
| **Client** | The Cocos Creator game (login / character select / combat / bag / mall…) | Cocos Creator 3.8.7 + TypeScript | [`client/`](client/) | [README](client/README.md) · [FAQ](client/FAQ.md) |
| **Server** | Account / character / admin APIs, SQLite persistence, Swagger docs | NestJS 12 + `node:sqlite` + JWT | [`server/`](server/) | [README](server/README.md) · [FAQ](server/FAQ.md) |
| **Admin** | The operator console (accounts / characters / administrators / audit logs) | React 19 + Vite + Tailwind v4 | [`admin/`](admin/) | [README](admin/README.en.md) · [FAQ](admin/FAQ.en.md) |

How they relate: the **client** is the game the player plays, the **server** is its only authoritative data source (local storage is just a cache), and the **admin** lets operators edit data.
The API contract is generated one-way from the server to the other two sides (see [Why are the API files (paths / types / methods) generated?](FAQ.en.md#why-are-the-api-files-paths--types--methods-generated-what-do-i-touch-to-add-an-endpoint)).

```
client (Cocos)    ─┐
                   ├─→  server (NestJS + SQLite)  ←─  admin (React)
admin (React)    ─┘      ↑ the only hand-written place for APIs
                         └─ swagger:emit → openapi.json → gen-api → generated API files on both consumers
```

## Project overview

The project currently covers:

- Login scene, character selection and creation scenes
- Game scene main loop and map switching (Loading transition scene with progress)
- Tiled map rendering driven by object groups: NPC positions, revive-point spawning, rectangular spawn zones, collision zones
- Minimap (HUD): the base image is the current map's `preview.jpg`, scaled proportionally to the view and panned with the character; the red dots land where the monsters really are
- Route indicator line: while pathfinding (click-to-move / quick-attack chasing / auto-grinding), both the ground of the big map and the minimap on the right draw a dotted white "character → target" route, with a bigger white ring marking the destination (same path data, destination updated live as the target moves)
- Character attributes, level and growth system (HP / MP / attack-defence range / HP recovery per second / combat power)
- Equipment system: equip and unequip, attribute aggregation, inner and outer appearance (8-direction placement / scale / rotation), **gender-specific default body when undressed** (male `role/1`, female `role/2`), equipment detail popup (three-segment coloured name / level / slot / attribute range)
- Equipment prefix and suffix variants: prefix (Common / Reinforced / Fine / Supreme / Godlike) × suffix (Human / Heaven / Divine) expands each base item into 15 variants, attributes scaled per-multiplier, names and texts coloured by quality
- Equipment quality borders and detail backgrounds: bag cells and worn-equipment icons play glowing **border animations** per prefix/suffix combination (all 84 atlases under `resources/borders` registered), and hovering the detail popup switches the **background animation** per the same combination (all 41 frame-sequence directories under `resources/backgrounds` registered); both take the first 15 sets and assign them by strength to the 15 combinations, leaving the rest for a custom table for special equipment
- Combat system: a single entry point for skill triggering, cooldown (converted from animation speed), magic cost, damage numbers, knockback, dash displacement (Ten Steps One Kill: teleport to the mouse position plus a landing effect)
- Monster system: zone spawning, AI behaviour (idle wandering / aggressive chasing / enraged chasing when hurt / basic attack), death animation, info panel, selection halo
- Death and revival: a monster only disappears after its death animation finishes; character death freezes controls and opens a popup to revive in place or safely at the revive point
- XP and levels: kills settle XP by the level gap between character and monster (a bigger gap yields less, no XP at a gap of 6+ levels), level-up recomputes attributes and refills status
- Drop system: weighted probabilistic drops, **drop count randomised per monster within its configured range** (e.g. `[1, 10]` means 1~10 items this time, the same item can be hit repeatedly), dropped items scattered on concentric rings without overlapping, picked up by walking over them or clicking; **each monster has its own drop list configured in `configs/monsterDrops` (key matching the monster one-to-one), each entry configuring weight / probability / count**, with all 555 equipment pieces spread across monsters by level bracket
- Drop light pillars: equipment on the ground plays a quality-based **light pillar effect** (all 6 sets under `resources/effect/light` registered, the first 5 assigned automatically Common→Godlike, the 6th reserved for a custom table for special equipment); ground drop names use three-segment colouring "prefix + name + suffix"
- Mall system: bottom "Mall" entry, **the entire equipment catalogue (555 pieces including prefix/suffix variants) is listed automatically**, priced 1 bound ingot each by default, purchases go straight into the bag; facade popup plus card grid with pagination (3 cards per row, 6 items per page), hover an icon for full details
- Bag operations: one-click tidy (merge stackables of the same kind + reorder by level/slot, filling from the first cell with empty cells sunk to the bottom), drag items between cells (move to empty / merge same kind / otherwise swap, dragging never pulls the popup along), **dragging out of the popup and releasing destroys the whole stack** (full-screen confirm: destroy / cancel returns it), one-click recycling into bound ingots, discard mode discards whole cells (irrecoverable); tidy and move rules are pure functions and unit-tested
- Auto-battle: quick-attack and idle-grinding toggles, obstacle-avoiding A* pathfinding for repositioning
- Status (Buff) system: statuses attached by skills, looping effects on the body, icon strip below the portrait
- Hover details: hovering a status icon shows name / description / remaining time; hovering a skill cell shows name / description / cooldown and other basics
- War Soul system: a 37-tier growth line (appearance from the war-soul assets), upgraded with bound ingots, attributes counted into combat power and map entry requirements, optionally shown at the character's top-right; entry is the "War Soul" button in the character info popup (stacked vertically with "Rank" and "Title", the NPC War Soul Envoy still works)
- Title system: 34 animated name plates (all registered under `resources/titles`) arranged into a tier 1~34 growth line; unlock/upgrade flow mirrors War Soul (bound ingot price curve), attributes generated by the curve; once unlocked the plate shows permanently above the character's head bar (same node as the rank red text / HP bar), entry is the "Title" button in the character info popup (no NPC involved)
- Rank system: a **100-tier** growth line (10 major segments × 10 tiers: Soldier → Commandant → Commandery Commandant → Leader of the Gentlemen → General → Distinguished General → Minister → Prince → Divine General → Myth), promoted with bound ingots, attributes generated as "equivalent-level base attributes × rate × major-segment factor" (sitting between Title and War Soul); the rank **has no assets of its own** — its appearance is the line of **red text** above the HP bar in the character's overhead info bar, updated immediately after promotion; entry is the "Rank" button in the character info popup (top of the three stacked buttons), and the 100-tier list in the left column is built once when opened rather than rebuilt on each selection change
- HP recovery per second: **level / defensive equipment / War Soul / Title / Rank** five sources summed into one attribute (N points per second), settled once per second by the main game loop and persisted (sharing one write with MP recovery); strength **derived from the max-HP ratio** (1% per second by default, the whole rate is tuned by changing only `configs/growth.attributeRange.hpRecoverRate`); **only defensive slots carry HP recovery** (chest 40% / head 20% / belt 20% / boots 20%); no recovery while dead, recovery **does not count towards combat power** (so it never raises any map's combat-power gate), monsters do not recover HP; old saves get the field backfilled
- Overhead display convention: **the character name sits in the middle of the body area** (same "body centre" convention as monster names, auto-centred against the `roleBody` height); the overhead info bar keeps only the rank red text / HP bar / HP number, with the title plate animation inserted above them
- Popup layering: with several popups open at once, **clicking one floats it above the others** (both touch and mouse input channels are taken over; transient layers such as toast tips and hover item details stay above popups, while the full-screen confirm dialog and the death mask stay above everything)
- Map teleport: the teleport officer popup groups maps by map type, maps whose level / combat power / War Soul requirements are unmet explain why on click
- Minimap popup: reads the map directory's `preview.jpg` for a large preview, left-click pathfinds automatically, right-click teleports directly
- Asset preloading: preloads the map, NPC / monster frame animations and the worn appearance before entering a map
- Joystick: a persistent joystick at the bottom left (base + draggable handle); hold and drag to move — **drag a little to walk, drag far to run** (dead zone / thresholds in `configs/role.joystickMove`); touch channel only, desktop mouse hold-and-drag works too, presses on the joystick do not fall through, and releasing never clears the selected target by accident
- Screen adaptation: fills the window (NO_BORDER) with no black bars, persistent HUD re-docked to the edges of the visible area; the character selection stage scales as one block (contain), so elements never leave the screen even when the window aspect ratio differs from the design resolution
- Server: account registration and login (scrypt salted digest), character data saved to the cloud (debounced merged pushes), revision-number optimistic locking, two token audiences, permission-point guards, login throttling, password reset and proactive token revocation, operator audit logs, announcement publishing with server-wide delivery, mail channel (templates + delivery queue + failure retry)
- Admin: account and character management (six-dimension filtering / structured editing / batch delete), administrators and permissions, audit log queries, my account

## A project written entirely by AI

**Every line of code in this repository was written by AI.** The client (Cocos Creator), the server (NestJS), the admin console (React),
plus every unit test and audit script under `client/tools/` and `tools/`, plus documents like `README.md` / `FAQ.md` — none of it came from human hands.

This is a **Vibe Coding** project: humans write no code; they only **state requirements in natural language, run it to see how it feels, and say what's wrong** — everything else is left to AI.

### Who does what

|            | Human                                | AI                                                     |
| ---------- | ------------------------------------ | ------------------------------------------------------ |
| Owns       | Requests features ("add a rank system", "the console needs to edit character attributes"), looks at the result, points out what's wrong, picks between options | Reads existing code → designs the approach → writes the implementation → writes unit tests and audit scripts → self-checks for regressions → syncs docs → **commits per feature** |
| Does not own | **Writes no code**, reads no API docs, formats nothing by hand | **Decides nothing** — when unsure, it lays out the options and asks |

### The traces this way of working left in the repo

- **Every pitfall turns into a script.** Regression is not prevented by memory here, but by automated guards: 25 unit-test suites under `client/tools/` and 7 audits under `tools/`, denser than the business code — whether configs leaked, whether addresses are hard-coded, whether generated artifacts match the server docs byte for byte, whether the combat-rules snapshot has drifted, whether the attributes the server computes match the client's version, whether UI clicks fall through to the world — all of it is watched by scripts.
- **Everything tunable lives in `client/assets/configs`.** Numbers, texts, layout, colours, durations and asset paths are never written into logic. This convention was forced by "AI keeps changing the numbers", not chosen for elegance.
- **All API files are generated from the server's Swagger document.** A signature mismatch between the sides becomes a **compile error**, not an `undefined` in production. For the same reason: when AI changes one side, the other two are stopped at compile time.
- **Regression is a hard gate.** Every change runs: server e2e (248 + 77 + 279 + 108 + 25 assertions) + typechecks on two sides + 25 unit-test suites + 7 audits — green means done.
- **One commit per problem solved.** A feature lands in its own commit the moment it's done, never a pile of mixed uncommitted changes — so "which change introduced this regression" can always be bisected.
- **Pitfalls went into the FAQ.** Each side's FAQ collects its own concrete problems; cross-side mechanisms and environment traps are in [FAQ.en.md](FAQ.en.md); every entry there was actually hit, including environment traps (for example an injected `NODE_OPTIONS` in some terminals makes the server **fail to start silently**).

### Expectation management

The code has full regression coverage and runs, but please read it as **a piece of AI work**: structural trade-offs lean towards "get it running first, converge later",
and some abstractions (config separated from logic, generated artifacts plus guards, pure functions plus unit tests) exist specifically **so AI can safely change things afterwards** — they may not be a human's first choice when writing code by hand.

If you want to see how far AI can take a project — the feature list below is the answer. Reviews, issues and brickbats welcome.

## Screenshots

**Login**

![Login](public/login.png)

**Character selection and creation**

![Character selection and creation](public/role_selector.png)

**Main game screen (character info / bag / skill popup)**

![Main game screen](public/game.png)

**Skill list**

![Skill list](public/skill.png)

**Monsters and combat**

![Monsters and combat](public/monster.png)

**Equipment drop light pillars (ground drops play quality-based light pillars: 5 tiers Common→Godlike assigned automatically, the 6th reserved for special equipment)**

![Equipment drop light pillars](public/drop-light.png)

**Minimap preview popup (large preview plus monster red dots / NPCs / spawn zones; left-click to pathfind, right-click to teleport)**

![Minimap preview popup](public/small-map.png)

**War Soul system**

![War Soul system](public/war-soul.png)

**Equipment quality borders and detail backgrounds (15 prefix/suffix quality borders in the bag; the hover detail popup shows a quality-matched background animation)**

![Equipment quality borders and detail backgrounds](public/border_bg.png)

**Mall (the whole equipment catalogue, 3 cards per row and 6 items per page; hover an icon for full details)**

![Mall](public/mall.png)

## Directory structure

```
olua/
├── README.md · FAQ.md      # overview and cross-side questions (this file)
├── client/                 # client: the Cocos Creator project (open this directory with it)
├── server/                 # server: NestJS
├── admin/                  # admin: React
├── tools/                  # project-level scripts (cross-side)
├── website/                # project website (static single page)
├── public/                 # screenshots and contact QR code
├── docs/                   # project docs (resume introduction, etc.)
└── equip-aligner/          # small tool for aligning equipment asset offsets
```

### client — the Cocos Creator project

> Convention: **core code only decides "how it runs"; everything tunable lives in `assets/configs`** —
> numbers, texts, layout, colours, durations and asset paths are never written into logic.
> Self-check: `node tools/audit-config-leak.cjs` (run from the repository root; finds tunables scattered in `ui/` and unregistered text keys).

> **Paths below are relative to `client/`** (so the full path of `assets/configs` is `client/assets/configs`).

- assets/configs: numbers and static config (one file per domain: role/monster/skill/equipments/items/drop/map/status/border/background/title/light/mall etc.)
  - configs/texts: **every player-facing text** (toast tips / validation reasons / UI labels / hover details / loading progress, with `{placeholder}` templates)
  - configs/bottomNav: bottom entry table (name / icon / unlock level / hotkey)
  - configs/network: **the client's only source for the server address** (base URL / timeout / retry / character progress sync debounce interval)
  - configs/layout: UI layout and styles (hud / dialogs / panels / scenes / borders / backgrounds / lights / images / sizes / theme)
- assets/types: pure type declarations (common/role/animation/good/skill/map/monster/drop/status/border/background/title/light)
- assets/entities: runtime entities (Role)
- assets/skills: skill behaviour implementations (skill implementations depend only on `SkillContext`, never on a global lookup)
- assets/ui: interface scripts
  - ui/core: static managers (GameHelper/LayerManager/MonsterManager/MonsterAI/DropManager/SkillManager/StatusManager/EffectManager/AutoBattle/PreloadManager/StorageManager/RoleUIManager/SceneManager etc.)
  - ui/components: grouped by responsibility (hud/panel/dialogs/role/input/map)
  - ui/helpers: UI generation (UiHelper base wrappers / GameUiHelper component library / AnimationHelper frame animation)
  - ui/utils: pure utility functions, split by domain (battle/drop/map/physics/resource/input/cursor/layout/node)
  - ui/utils/net: **every access to the server**
    - generated (never hand-edit): `ApiRoutes` path table / `ApiModels` types (mirroring the server DTOs) / `Api` methods (`HealthApi`·`AuthApi`·`RoleApi`)
    - hand-written: `HttpClient` wrapper and shared dispatch / `ApiCodes` business codes and text keys / `ApiError` error normalisation / `Session` / `RoleSync` progress sync / `NetworkSetup` wiring
- assets/resources: assets (map tmx, frame animations, atlases, icons, UI assets)
- assets/scenes: login, character selection, loading and game scenes
- tools: **client-only scripts** (25 unit-test suites + config generators `gen-monster-config.cjs` / `gen-monster-drops.cjs` + asset cleaner `clean-role-empty-frames.cjs` + the `lib/` unit-test sandbox)
- settings / profiles / native / package.json / tsconfig.json: Cocos project configuration (`package.json` describes the Cocos project, not npm scripts)
- library / temp / build: Cocos cache and build output (not version-controlled)
- Details in [client/README.md](client/README.md), questions in [client/FAQ.md](client/FAQ.md)

### server — the NestJS service

- src/common: unified response envelope, business codes, guards (auth `AuthGuard` / permission `PermissionGuard`), filters, interceptors, decorators
  - constants/permission: **the single source for permission points and admin roles** (role → permission mapping; the "required permission" in the docs is generated by looking it up)
  - constants/swagger-tags: documentation groups (public APIs / client / admin)
  - interceptors/audit.interceptor: **automatic logging of admin write APIs** (action taken from `operationId`, password-like fields masked before persisting)
  - security: pure-function login throttling decisions (`rate-limit.util`) + in-memory counter service (`login-throttle.service`)
- src/database: SQLite connection and the repository layer for the six tables (accounts / roles / admins / audit_logs / announcements / mail_queue, including backfilling columns in existing databases)
- src/modules: auth (player authentication) / roles (characters) / admin (console: auth / accounts / characters / administrators / passwords) / announcement (announcements: public pull + admin CRUD) / mail (mail: templates + delivery queue + background scheduler) / audit (audit logs) / token (JWT) / health
- src/swagger/setup: documentation mounting (extracted into a function so tests can also generate docs once to verify grouping / permission annotations / dangling `$ref`)
- src/swagger/emit: **offline production of `openapi.json`** (`npm run swagger:emit`, the only input to both consumers' API files)
- openapi.json: the machine-readable contract (committed to the repo; must be regenerated after any API change, or both consumers stay on the old contract)
- test/e2e.cjs: end-to-end cases (real server + real requests, 248 assertions: registration and login / character CRUD / privilege escalation / token audience isolation / full admin flows / doc grouping and permission points / four-level escalation and super-admin protection / announcement pull and time windows)
- test/e2e-roles.cjs: **character management focus** (77 assertions: revision-number optimistic locking / six-dimension filtering / structured field validation / batch and whole-account deletion / read-only observer escalation / docs)
- test/e2e-guard.cjs: **operations and security baseline focus** (279 assertions: password reset and token revocation / self-service password change / audit log persistence, masking, filtering, permissions / login throttling by username and by IP / kicking offline)
- test/e2e-mail.cjs: **mail channel focus** (108 assertions: verifying enqueue / delivery / retry and exhausting the limit / manual re-delivery / whole-channel disabling when SMTP is unconfigured, using an injectable **fake sender**; no real SMTP server needed)
- Details in [server/README.md](server/README.md), questions in [server/FAQ.md](server/FAQ.md)

### admin — the React console

- src/api: address config (single source `config.ts`) + request layer `http.ts` (interceptors / timeout / envelope unwrapping / error normalisation / redirect to login on 401)
  + **generated** `routes.ts` path table / `models.ts` types / `endpoints.ts` methods (`authApi`·`accountsApi`·`adminsApi`·`rolesApi`·`auditApi`·`announcementsApi`·`mailsApi`·`statsApi`·`systemApi`)
  + hand-written `types.ts` (business codes / permission points / action and target dictionaries) and `index.ts` (single entry point)
- src/pages: login / register / overview / account list and detail (reset password · kick offline · delete every character on the account) / character list (filtering + multi-select batch delete) and detail (basic info / common numbers / structured editing of equipment, skills and bag) / administrators (change role · enable-disable · reset password · delete) / announcements (publish · edit · delete · enable-disable + active status column) / mail (compose into queue + delivery records: status filter · retry count · failure reason · re-deliver) / audit logs (filter + pagination + expandable request body) / my account (self-service password change)
- Menus and buttons are shown or hidden by the **permission points** in the token (`store/session.hasPermission`); the server still validates independently
- Details in [admin/README.md](admin/README.en.md), questions in [admin/FAQ.md](admin/FAQ.en.md)

### tools — project-level scripts (cross-side)

- gen-api.cjs: **produces both consumers' API files from `server/openapi.json`** (the only code generator; called by the server's `npm run gen:api`)
- gen-battle-rules.cjs: **produces the server's combat-rules snapshot from `client/assets/configs`** (the foundation of server-authoritative combat, see `server/src/modules/combat/`) — levels 60 / War Soul 37 / Title 34 / Rank 100 + 7 combat-power weights + 555 equipment pieces (prefix/suffix variants already expanded)
- audit-api-generated.cjs: generated artifacts byte-identical to the docs / header markers / full endpoint coverage / no dangling types / paths only in the path table / Cocos `.meta` files complete
- audit-api-hardcode.cjs: no hard-coded addresses on any side, requests leaving only through the single exit, every environment variable key registered in `.env.example`
- audit-config-leak.cjs: no tunables leaking into client core code, and every key in `configs/texts` registered (allowlist `config-leak-allowlist.json`)
- audit-ui-click-through.cjs: do client UI clicks fall through to the world, and is press ownership wired up completely
- audit-battle-rules.cjs: is the combat-rules snapshot byte-identical to the client's `configs` (**data** drift raises no error, it just makes the two sides slowly compute different numbers)
- audit-combat-parity.cjs: do the character attributes the server computes match the client's `combatCalc` (**algorithm** drift). The expected values are not a copied formula — the real `GameHelper.combatCalc` is compiled into Node and run: 2849 input sets × 10 fields, covering all levels / all equipment / all War Soul, Title and Rank tiers

### Others

- website: project website (static single page: key features / screenshot gallery / contact info, logo and favicon in website/assets/icons)
- public: screenshots, showcase assets and the contact QR code
- docs: project docs (`resume.md` etc.)
- equip-aligner: small tool for aligning equipment asset offsets (ships with its own README and self-check script)

## Tech stack

- Cocos Creator 3.8.7
- TypeScript
- Cocos UI / 2D scene system / Box2D physics (rigid bodies and colliders)
- Server: NestJS 12 + `node:sqlite` (built into Node 22, no native module dependencies) + JWT (two audiences, player and admin) + Swagger
- Admin: React 19 + TypeScript + Vite + Tailwind CSS v4
- How it is built: **written entirely by AI (Vibe Coding)**, humans only request features and accept the result — see [A project written entirely by AI](#a-project-written-entirely-by-ai)

## Common commands (Makefile)

The repository root ships a Makefile collecting the three sides' routine actions in one place (`make` / `make help` lists everything, `make info` prints the current toolchain and key paths):

```bash
make install        # first time: install server / admin dependencies
make env            # generate server/.env (skipped if it already exists)
make dev            # start server :3100 and admin :5173 together; Ctrl-C exits both

make client-check   # client typecheck (Cocos' bundled tsc; 0 errors means pass)
make client-test    # client's 25 unit-test suites
make server-verify  # verify the server with one command (compile + five e2e suites + generated-artifact audit)
make admin-build    # admin typecheck + build
make gen-api        # after changing APIs: regenerate the contract and both consumers' API files
make audit          # 7 cross-side audit scripts

make check          # static checks: client tsc + admin typecheck + 7 audits
make test           # all tests: client's 25 suites + server's five e2e suites
make verify         # full gate: check + builds on all three sides + all tests (run this before committing)
```

- Run a single client suite: `make client-test-one T=test-bag-tidy`
- Different machine / different Cocos version: `make TSC=/path/to/tsc client-check`
- Client generators and cleaner: `make client-gen-monster` / `make client-clean-frames` (dry run) / `make client-clean-frames-apply`
- Restricted terminals (with `NODE_OPTIONS` injected) need **no special handling** — the Makefile clears it already; to use the pristine environment: `make RUN_ENV= <target>`

Below are each side's manual commands, runnable without `make`. Each side's README has the details and the full list of environment variables.

## Quick start

Each side's README has the details and every environment variable; here is the shortest path to a running stack.

### 1. Server (start it first — both the client and admin depend on it)

```bash
cd server
npm install
cp .env.example .env     # first time: port / secrets / limits all live here; each item explained in the comments
npm run dev              # development (watch mode); or npm run start for the built output
```

- API docs (Swagger): <http://localhost:3100/api-docs> (JSON at `/api-docs-json`)
- Health check: <http://localhost:3100/api/health>
- Verify everything with one command: `npm run verify` (compile + five e2e suites + generated-artifact consistency)
- Details in [server/README.md](server/README.md)

### 2. Client (Cocos)

1. Install and open Cocos Creator 3.8.7.
2. Open **`client/`** through Creator's "Open" / "Open Project" (it is the Cocos project root).
3. In the editor, open a scene under `client/assets/scenes`.
4. Run the project with the preview or play button.

The client has no npm scripts; it relies on the Cocos Creator editor to launch and preview.
Which server it talks to is decided solely by `baseUrl` in `client/assets/configs/network.ts` (use the LAN IP for on-device debugging).
Details in [client/README.md](client/README.md).

### 3. Admin (React)

```bash
cd admin
npm install
cp .env.example .env.development   # first time: the API base URL lives here (VITE_API_BASE_URL)
npm run dev                        # development; npm run build produces dist
```

Admin registration needs `ADMIN_REGISTER_CODE` set in `server/.env` (leave it empty for open registration), and registration asks for the same code.
The **first** administrator to register becomes the super administrator (all permissions); everyone after that is a regular administrator and needs to be promoted by the super admin on the "Administrators" page.
Details in [admin/README.md](admin/README.en.md).

### 4. Changing an API = changing the server + regenerating

The client and admin **hand-write no API files at all**: paths, method names, request/response types are all produced from the server's Swagger document.
That way "the server changed a field and the other two forgot" becomes a **compile error** instead of an `undefined` in production.

```bash
cd server && npm run gen:api     # = swagger:emit + node ../tools/gen-api.cjs
```

```
server/src (controller + DTO + decorators)  ← the only hand-written place
        │  cd server && npm run swagger:emit
        ▼
server/openapi.json (machine-readable contract, committed to the repo)
        │  node tools/gen-api.cjs
        ▼
client  client/assets/ui/utils/net/{ApiRoutes,ApiModels,Api}.ts
admin   admin/src/api/{routes,models,endpoints}.ts
```

**The standard steps for changing an API**:

1. Change the controller / DTO / decorators on the server (every endpoint must have an `operationId`, e.g. `role.save`);
2. Run `npm run gen:api` to regenerate the docs and both consumers' API files;
3. Run `tsc` / `npm run build` on both consumers — any incompatible signature is reported directly (fix call sites as they come up).

The generator reads these fields from the document (all conventions are written into the docs, nothing is guessed):

| Field in the docs | Written by | Decides |
|---|---|---|
| `operationId` (`<module>.<method>`) | `operationId` on `@ApiPublicDoc` / `@ApiPlayerDoc` / `@ApiAdminDoc` | Which module and method it generates into |
| `x-olua-audience` | same decorators (added automatically) | Whether a token is required (`public` → `auth: false`) |
| `x-olua-data-schema` / `x-olua-data-nullable` | `@ApiDataResponse(...)` | The type of `data` in the response (default = `null`) |
| `x-olua-query-schema` | `@ApiQueryModel(XxxQueryDto)` | The named type the query parameters map to |
| `x-olua-permissions` | `@ApiAdminDoc({ permissions })` | The "required permission" comment in the artifacts (handy for cross-checking) |

**Generated artifacts must never be hand-edited** — `tools/audit-api-generated.cjs` watches every one of them.
The full description of the contract pipeline: [FAQ.en.md](FAQ.en.md#why-are-the-api-files-paths--types--methods-generated-what-do-i-touch-to-add-an-endpoint).

### 5. The regression gate

Before merging, at least these three categories must run (green means done). With `make` installed it is one command:

```bash
make verify   # = check + builds on all three sides + all tests
```

Manual equivalent (no `make` needed):

```bash
# Client: 25 unit-test suites (run inside client/; scripts locate Cocos' bundled tsc themselves)
cd client && for t in tools/test-*.cjs; do node "$t" || exit 1; done

# Server: compile + five e2e suites (248 / 77 / 279 / 108 / 25) + generated-artifact consistency
cd server && npm run verify

# Admin: typecheck + build
cd admin && npm run build

# Project-level audits (run from the repository root)
node tools/audit-api-generated.cjs && node tools/audit-api-hardcode.cjs \
  && node tools/audit-config-leak.cjs && node tools/audit-ui-click-through.cjs
```

> In restricted environments (for example terminals with `NODE_OPTIONS` injected) you need to clear it for server child processes: `env -u NODE_OPTIONS npm run dev`. Details in [FAQ.en.md](FAQ.en.md).

## Feature list

> ✅ Done ❌ Not done  Fine-grained server and admin capabilities are listed in their own READMEs.

### Accounts and characters

| Feature | Description |  Status |
| --- | --- | :-: |
| Account registration / login | Accounts live on the server (SQLite), passwords hashed with scrypt plus salt; tokens are valid for 7 days, and failed logins do not distinguish "account does not exist" from "wrong password" |  ✅  |
| Character selection and creation | Up to 3 characters per account; both lists and data live on the server; a new character is generated from client configs (starter equipment / bag / hotkeys) |  ✅  |
| Cloud save of game progress | Character changes (levelling from kills / picking up / trading / changing gear / using potions) are written back automatically, **debounced and merged over 1.5 seconds**, with an immediate flush before map changes and quitting |  ✅  |
| Old-save auto migration | New fields and storage format changes are backfilled on read (equipment / bag id references etc.) |  ✅  |
| Delete character | "Manage" on the character selection screen enters management mode, a delete button appears above each character, and after two-step confirmation the server deletes it (irrecoverable) |  ✅  |
| New character starter bag | Generic items plus every base weapon/chest, and also **all prefix/suffix variants of the level 1 weapon (15 pieces by quality)** straight into the bag, so appearances and borders can be compared from birth |  ✅  |
| Admin console (React) | Admin login and registration, paginated account search and banning, viewing and editing every character of an account (attributes / online flag / delete), **resetting player passwords**, **kicking offline** → [admin/README.md](admin/README.en.md) |  ✅  |
| Console character management | Six-dimension filtering (keyword / online status / class / gender / level range / account); **all basic info editable** (name / class / gender / level / fashion / portrait / current map + gold / ingots / silver / XP / War Soul / Title / Rank); **structured editing of equipment / skills / bag** (the server validates structure only; the client configs are the single truth for item lists); multi-select batch delete, clearing every character on an account; renaming still bound by "no duplicate names per account" |  ✅  |
| Console edits consistent with online players | Characters carry a **revision** number (incremented by 1 on every write): players send it along to lock optimistically, and a mismatch means the console changed it — the server rejects the push and the client **re-fetches the latest and rebaseline on it** (console edits win; the player's old save never overwrites them); when a character is deleted or kicked by the console, the client self-heals back to character selection |  ✅  |
| Password management | A player who forgets their password can only have it **reset by support in the console** (no recovery flow in the client): the frontend generates a random password and **shows it exactly once** (the server stores only the hash); reusing the old password is rejected. An administrator changing **their own** password must confirm the current one, and the server issues a **new token** afterwards (otherwise they would kick themselves out right after changing it) |  ✅  |
| Proactive token revocation | Changing a password **invalidates every token issued before** (both tables carry `token_version`, written into the token on issue and compared against the database by the guard on every request) — a stateless JWT cannot kick old tokens after a password change, and this closes that gap |  ✅  |
| Login throttling | Counted on two dimensions, **username** (default 5 attempts / 10 minutes) and **source IP** (default 20 / 10 minutes); over the limit it locks and tells you how long to wait; the counter resets once the threshold is hit (a wrongly locked legitimate user isn't punished twice). Thresholds and switches live in `server/.env`, with a comment explaining the `TRUST_PROXY` trap behind reverse proxies |  ✅  |
| Kick offline | One click in the console clears an account's online characters; **clearing the flag alone cannot stop anyone** (the player is still running locally), so the server also rejects save pushes for that account's non-online characters (business code 20007), and the client shows a toast and returns to character selection — the character data is intact, picking it again is enough |  ✅  |
| Audit logs | Console **write** operations are recorded automatically (the action comes from the endpoint's `operationId`, so a new endpoint costs zero extra work; reads are not logged); password / token / register-code fields are recursively masked before persisting; both successful and **failed** logins are recorded (including source IP and attempted account name); filtering (keyword / action / target / result / time range) and pagination included; writing logs **never affects the main flow** (exceptions are swallowed internally, and the oldest are pruned automatically) |  ✅  |
| Permission management | Administrators come in three levels (super admin / admin / read-only observer), with permission points as fine as "per endpoint" (view / ban / delete / change role / reset password / read logs / publish announcements…); a single source for permission points plus real-time guard validation, and UI visibility follows permissions; the last enabled super admin is protected |  ✅  |
| Announcement publishing | Operators publish "title / body / level (important shown first)" in the console with an **active time window** (immediate or no end date), and disabling takes it down immediately; **"is it active right now" is decided by the server** (the same source the player side pulls from) — the console only displays it and never computes it from local clock |  ✅  |
| Mail delivery | Operators email players by template: **enqueue only, never wait for delivery** (a background scheduler sends, failures retry with exponential backoff, exhausting the limit marks it failed with a reason); delivery records expose status / retry count / failure reason and support re-delivery; **the whole channel is disabled when SMTP is unconfigured** (an explicit error rather than silently losing mail); templates are data, and missing required variables are rejected |  ✅  |
| API documentation | Swagger output (`/api-docs`) in three groups, **public APIs / client / admin**; every endpoint states its token requirement and required permission points; unified response envelope plus business codes |  ✅  |
| Idle XP | Continuously gain experience, with the XP bar and level updating dynamically |  ✅  |

### Maps and scenes

| Feature | Description |  Status |
| --- | --- | :-: |
| Scene switching with Loading transition | Map changes and entries show progress |  ✅  |
| Tiled object-group driven | NPC positions, revive points, rectangular spawn zones, collision zones |  ✅  |
| Revive-point spawning | Entering or teleporting always spawns at the revive point |  ✅  |
| Minimap | Real map base image (the map's `preview.jpg`, scaled to the view and panned with the character) + map name / world coordinates / black dot for the character / red dots for nearby monsters / pathfinding route |  ✅  |
| Minimap preview popup | Reads the map directory's `preview.jpg`; left-click pathfinds, right-click teleports; white dots and names for NPCs, names for spawn zones, and the route |  ✅  |
| Teleport officer popup | Grouped by `MapType`, title plus teleport buttons in a grid, new maps extend automatically |  ✅  |
| Map entry restrictions | Teleport is blocked with a reason when level / combat power / War Soul fall short |  ✅  |
| Collision-range debug visualisation | Toggleable display of collision boxes (colour-coded for characters / obstacles / monsters) |  ✅  |

### Character growth

| Feature | Description |  Status |
| --- | --- | :-: |
| Level attribute growth | Attack / defence ranges generated per level, combat power computed |  ✅  |
| Kill XP | Decays by the level gap between character and monster (no XP at a gap of 6+ levels), with a floating number at the kill position |  ✅  |
| Level-up flow | Attributes recomputed, HP and MP refilled, level-up effect |  ✅  |
| HP / MP | Health and mana orbs, overhead HP refreshing live, natural mana recovery |  ✅  |
| War Soul system | A single 37-tier growth line in a three-column popup, upgraded with bound ingots; entry = the "War Soul" button in the character info popup (next to "Title"), the NPC War Soul Envoy still works |  ✅  |
| War Soul attributes effective | Each tier's attributes count into character attributes and combat power, and act as map entry requirements |  ✅  |
| War Soul display | Once ticked in the popup, the current tier's animation hangs at the character's top-right and survives map changes and re-login |  ✅  |
| Title system | 34 animated name plates (all registered under `resources/titles`) arranged into a tier 1~34 growth line; unlock/upgrade flow mirrors War Soul (bound ingot price curve), attributes generated as "equivalent-level base attributes × rate × series factor" |  ✅  |
| Title display | Once unlocked, the plate shows **permanently above the character's head bar** (same node as the name / HP bar, native size, unscaled), no toggle, surviving map changes and re-login; entry is the "Title" button in the character info popup (next to "War Soul", no NPC involved) |  ✅  |
| Rank system | A single **100-tier** (10 major segments × 10 tiers) growth line in a three-column popup with a rank insignia; promotion with bound ingots (price = 30 × N²), attributes generated as "equivalent-level base attributes × rate × major-segment factor" (full rank ≈ 52.5% of base attributes, between Title's 39% and War Soul's 67%) |  ✅  |
| Rank display | The rank name shows as **red text permanently above the HP bar** in the character's overhead info bar (below the character name; the rank has no assets — that line of red text is its appearance), blank before any rank is granted, updated immediately after promotion, surviving map changes and re-login; entry is the "Rank" button in the character info popup (stacked vertically with "War Soul" and "Title", no NPC involved) |  ✅  |
| War Soul numbers and costs tuned per tier | Upgrade costs and attributes are formula placeholders, pending per-tier tuning |  ❌  |

### Equipment and items

| Feature | Description |  Status |
| --- | --- | :-: |
| Equip / unequip and attribute aggregation | Equip validation (level / gender / class), attributes recomputed live on gear changes |  ✅  |
| Id-reference storage | Equipment slots and the bag store item keys, so config changes take effect after a restart |  ✅  |
| Inner and outer appearance display | 8-direction placement / scale / rotation, inner placement, prefixes, suffixes and labels |  ✅  |
| Equipment / item configs | 12 chests, 20 weapons plus rings / necklaces / boots / helmets / belts, with icons and texts |  ✅  |
| Equipment prefix / suffix variants | 5 prefixes × 3 suffixes, each base item expanding to 15 variants (555 pieces total), attributes scaled by multiplier, names coloured by quality |  ✅  |
| Equipment quality borders | Bag and worn-equipment icons play glowing border **animations** per prefix/suffix combination (all 84 atlases under `resources/borders` registered, the first 15 assigned by strength to the 15 combinations), special equipment can configure custom borders |  ✅  |
| Equipment detail popup | Three-segment coloured name, level / slot, **recycle price**, attribute ranges and basic info; hover position computed by a pure function (**as close to the screen centre as possible while staying entirely inside the visible area**, fully visible at any window size and from any cell) |  ✅  |
| Equipment detail background | The popup shows a quality background **animation** per prefix/suffix combination (all 41 frame-sequence directories under `resources/backgrounds` registered, the first 15 assigned by strength to the 15 combinations), special equipment can configure custom backgrounds |  ✅  |
| Drop system | Weighted drop tables, random count within a range (`[1,10]` drops 1~10 items), scattered on concentric rings without overlapping, auto-pickup / click-to-pickup |  ✅  |
| Per-monster drop tables | `configs/monsterDrops` holds one list per monster, each entry configuring weight / probability / count plus the drop-count range; potions and materials tiered by level, equipment covering all 555 variants by level bracket |  ✅  |
| One-click bag tidy | One button at the popup bottom: merge stackables of the same kind + reorder by level / slot, **filling from the first cell with empty cells sunk to the bottom**, implemented as unit-testable pure functions |  ✅  |
| Bag item dragging | Hold an item and drag it to another cell: empty = move, same stackable kind = merge (overflow stays in the source cell), otherwise = swap; ghost icon follows with highlight on drop target, dragging **never pulls the whole popup along**, rules are unit-testable pure functions |  ✅  |
| One-click bag recycle | One button at the popup bottom: equipment in the bag turns into **bound ingots** (worn gear excluded), price = level curve × prefix/suffix multiplier, applied after two-step confirmation |  ✅  |
| Bag item discard | **Drag an item outside the bag popup and release** → full-screen confirm (confirm = destroy the whole stack, cancel = returns to its cell); there is also a "Discard" button at the popup bottom entering discard mode to click cells (two-step confirmation). Works for every item category and coexists with "one-click recycle" |  ✅  |
| Generic confirm dialog | `components/dialogs/ConfirmDialog`: full-screen modal scrim + panel + confirm/cancel, claiming both touch and mouse input for itself (neither lower UI nor the world is clickable); texts passed in by the caller from `configs/texts` |  ✅  |
| Equipment numbers filled in | Combat numbers tuned item by item |  ❌  |
| Bag stack count badge | Cells show the count of stackable items |  ❌  |
| Drop name prefix and suffix | Ground drop names are assembled as "prefix + name + suffix" and **coloured in three segments** (prefix/name in the prefix colour, suffix in the suffix colour), using **the same colour rule** as the equipment detail popup; non-equipment stays single-line white |  ✅  |
| Equipment drop light pillar | When equipment lands on the ground a quality **light pillar animation** plays below its icon (all 6 sets under `resources/effect/light` registered, the first 5 assigned automatically Common→Godlike, the 6th reserved for a custom table for special equipment), preloaded on map entry |  ✅  |
| Mall system | Bottom "Mall" entry (M): **the entire equipment catalogue** (555 pieces including prefix/suffix variants) listed automatically, priced 1 bound ingot each by default, purchases go straight into the bag (insufficient balance or a full bag means no charge and no change); the popup doubles as the mall facade background (`resources/mall/bg`), goods **3 cards per row with 6 items per page** (a full page rebuilds on page change, so opening never stutters), hover an icon for full details; goods and prices in `configs/mall` |  ✅  |

### Combat and skills

| Feature | Description |  Status |
| --- | --- | :-: |
| Skill system | Single trigger entry, cooldown / mana cost / distance checks, effects, knockback |  ✅  |
| Keyboard + mouse control | WASD/SHIFT + left-click walk and right-click run, drag to change direction live, left-click a monster to attack / right-click to select |  ✅  |
| Auto-battle | Quick-attack / grinding toggles, obstacle-avoiding A* pathfinding, retargeting when stuck |  ✅  |
| Route indicator line | While pathfinding, both the big-map ground and the minimap draw a dotted white route with a big white ring at the destination |  ✅  |
| Status Buff | Statuses attached by skills, looping effects on the body, icon countdown |  ✅  |
| Dash skill (Ten Steps One Kill) | Teleport to the mouse position: inside the range it lands exactly there, outside it lands at the farthest point the skill's distance allows, with a landing effect |  ✅  |
| Status numbers in damage | Numerical effects like block / damage reduction / defence bonus taking part in settlement |  ❌  |
| Monster skills | Monsters casting configured skills (currently only basic attacks) |  ❌  |
| Player being-hit feedback | Hit reactions / damage numbers and other polish |  ❌  |

### Monsters

| Feature | Description |  Status |
| --- | --- | :-: |
| Zone spawning | On map entry, monsters are generated randomly within the map's configured spawn rectangles |  ✅  |
| Monster AI | Idle wandering, aggressive chasing, passive monsters chasing in anger when hurt, basic-attack settlement |  ✅  |
| Death animation | Nodes are removed only after the death animation finishes; missing frames fall back to removing immediately |  ✅  |
| Monster map info | Name centred (aggressive red / passive yellow), overhead HP bar plus HP number |  ✅  |
| Monster info panel / selection halo | Click to select, HP and attributes shown live |  ✅  |
| Monster configs fully completed | For all 220 monsters, the **visible body size (contentSize) and appearance offset (outOffset) are measured from the assets' auto-trim data** (generated by `client/tools/gen-monster-config.cjs`, which decides collision boxes / hit-testing / HP bar placement; historically numbers 5~220 were 0×0 and unclickable); animation speeds converge on a `monsterDefaultSpeedRate` default table with per-entry overrides; aggressive monsters follow the rule "BOSS or body width ≥ 250px" (76/220); sale prices generated by level × role |  ✅  |
| Monster respawn timer | Replenished on a cycle after death (currently generated once when the map opens) |  ❌  |

### Death and revival

| Feature | Description |  Status |
| --- | --- | :-: |
| Character death flow | Death animation freezes on its last frame, all controls locked, monsters stop chasing the corpse |  ✅  |
| Revival popup | Black translucent mask + revive in place / safe revival (returns to the current map's revive point) |  ✅  |

### UI and others

| Feature | Description |  Status |
| --- | --- | :-: |
| Full HUD | Character info bar / health orb / mana orb / XP bar / hotkey bar (6 slots + cooldown) / minimap |  ✅  |
| Hover detail popup | Hovering a status icon shows name / description / remaining time; hovering a skill cell shows name / description / cooldown etc. |  ✅  |
| Custom mouse cursor | Attack cursor pointing at monsters, colour varies by item category when pointing at items |  ✅  |
| Asset preloading | Preloads map / NPC / monster / appearance frame animations before entry, cached per directory |  ✅  |
| UI hit testing | Clicking interface elements does not fall through to the world (no interrupted operations) |  ✅  |
| UI clicks not falling through (inside the UI) | Elements register on the mouse event channel too, so clicking a popup's close button or a panel never triggers lower HUD (e.g. opening the minimap popup by accident) |  ✅  |
| World-side press ownership | Press starts movement and release ends it: when the UI swallows the release, ownership is handed back to the world side (so movement never sticks); press start points are registered by each interface element itself (recording the hit target the engine gave, independent of bubbling order), every registration point first screened by `UITransform` (so the engine cannot be crashed by it); clicking NPCs never triggers movement by mistake nor interrupts grinding |  ✅  |
| Screen adaptation | Fills the window (NO_BORDER) + persistent HUD re-docked to edges; the character selection stage scales as one block, so elements stay inside the visible area at any window aspect ratio |  ✅  |
| Announcement display | **Login page**: entering the login scene pops "important" announcements (important only, not filtered by read state), closed with "Got it"; **in-game**: "Announcements" entry on the minimap plus an unread red dot, board split into two columns (left list layered "important first", ties keeping the server order; right column the body), opening marks the currently active announcements as read (you can still see which ones are new this time) |  ✅  |
| Asset gaps filled | Missing assets: last 4 frames per weapon direction, cloth 011/012/013, weapon 005/021 |  ❌  |
| UI polish and naming conventions | Unified overall visuals and asset naming |  ❌  |

## Documentation

| Doc | Contents |
| --- | --- |
| [README.en.md](README.en.md) | This file: project overview, index of the three sides, directory structure, quick start, feature list |
| [FAQ.en.md](FAQ.en.md) | **Cross-side**: single source of truth for addresses, the contract pipeline, how the three sides interact, environment traps, how to run regression |
| [client/README.md](client/README.md) · [client/FAQ.md](client/FAQ.md) | Client: how to open the Cocos project, client architecture and conventions, preview errors and gameplay config questions |
| [server/README.md](server/README.md) · [server/FAQ.md](server/FAQ.md) | Server: startup and environment variables, data model, authentication and permissions, contract generation, throttling and audit |
| [admin/README.md](admin/README.en.md) · [admin/FAQ.md](admin/FAQ.en.md) | Admin: startup and build, permission-driven visibility, page list, division of labour in the api layer |
| [docs/resume.md](docs/resume.md) | Project introduction for résumé purposes |

## Assets and contact

> The art assets are too large to keep under version control — contact me if you need them.

![WeChat QR code](public/qrcode.jpg)
