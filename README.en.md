# olua

> [简体中文](README.md) | English

> **This project is written entirely by AI (Vibe Coding): every line of code in this repository was written by AI — not one line was typed by a human.**
> Humans do two things here — **request features and look at the result**. How it was built and what traces it left: [A project written entirely by AI](#a-project-written-entirely-by-ai).
>
> **This is NOT a game project ready for live operation** — it is a learning / research project built together by people from different backgrounds (development and AI).

A 2D character-growth and equipment gameplay prototype built on Cocos Creator 3.8.7, together with a companion NestJS server and a React admin console,
covering login, character creation, character growth, the equipment system, map exploration and combat gameplay (monster fighting / drops / skills / auto-battle) as a complete three-side demo.

## Code lives on GitHub: Gitee is a read-only mirror

The primary repository lives on **GitHub** (`github.com/WebCoderT/olua`); [putiwan/olua](https://gitee.com/putiwan/olua) on Gitee is its **read-only sync mirror**:

- **Please go to GitHub for everything code-related** — issues, pull requests, commits, commit history and CI all happen on GitHub only;
- The **Gitee mirror** is fine for browsing the code, cloning / downloading, and the occasional star; it is synced periodically, **may lag behind, and GitHub is always authoritative**;
- Issues / PRs opened on Gitee **will not be handled** (the mirror takes no collaboration) — please file everything on GitHub instead.

Live mirror stats (official Gitee badges, generated on each page load):

[![star](https://gitee.com/putiwan/olua/badge/star.svg?theme=gvp)](https://gitee.com/putiwan/olua/stargazers)
[![fork](https://gitee.com/putiwan/olua/badge/fork.svg?theme=gvp)](https://gitee.com/putiwan/olua/members)

## The three sides

The repository splits into three **peer directories**, each with its own README and FAQ; cross-side conventions and mechanisms live in this file and the root [FAQ.en.md](FAQ.en.md).

| Side | What it is | Tech stack | Directory | Docs |
| --- | --- | --- | --- | --- |
| **Client** | The Cocos Creator game (login / character select / combat / bag / mall…) | Cocos Creator 3.8.7 + TypeScript | [`client/`](client/) | [README](client/README.en.md) · [FAQ](client/FAQ.en.md) |
| **Server** | Account / character / admin APIs, SQLite persistence, Swagger docs | NestJS 12 + `node:sqlite` + JWT | [`server/`](server/) | [README](server/README.en.md) · [FAQ](server/FAQ.en.md) |
| **Admin** | The operator console (accounts / characters / administrators / audit logs) | React 19 + Vite + Tailwind v4 | [`admin/`](admin/) | [README](admin/README.en.md) · [FAQ](admin/FAQ.en.md) |

How they relate: the **client** is the game the player plays, the **server** is its only authoritative data source (local storage is just a cache), and the **admin** lets operators edit data.
The API contract is generated one-way from the server to the other two sides (see [Why are the API files (paths / types / methods) generated?](FAQ.en.md#why-are-the-api-files-paths--types--methods-generated-what-do-i-touch-to-add-an-endpoint)).

```
client (Cocos)    ─┐
                   ├─→  server (NestJS + SQLite)  ←─  admin (React)
admin (React)    ─┘      ↑ the only hand-written place for APIs
                         └─ swagger:emit → openapi.json → gen-api → generated API files on both consumers
```

## Branches: master (landscape) / portrait (portrait)

The repository keeps two long-lived branches — **two screen versions of one codebase**, not old vs new, so never merge them into each other:

| Branch | Design resolution | What it is |
| --- | --- | --- |
| `master` | 1920×1080 | Main branch: landscape at a single resolution; later work continues here |
| `portrait` | 750×1624 | The portrait version: login and character selection re-laid-out from the `design/` mockups, one character per account, a device-generated account with automatic login; it holds the whole portrait batch and no longer follows master |

- **Switching versions means switching branches**: `git checkout portrait` for portrait, `git checkout master` for landscape;
- **Scope of the difference**: `git diff --stat master portrait` — changes concentrate in `client/`, and on the server it is only the character cap;
- **Assets do not follow the branch**: `client/assets/resources/` (the art package) and `design/` (the mockups) are not in the repository, so both branches share the same local copy. On the portrait line, `client/tools/gen-ui-assets.py` **overwrites in place** `login/login_bg.png` and `create_role/bg.png` (the main artwork becomes a frosted silhouette, with no backup taken), so after switching back to landscape those two must be restored from the originals — otherwise what you see is the portrait patch, not the landscape look;
- **On a fresh clone**, put the assets in place as described in [Quick start](#quick-start) first, then either branch can run.

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
- War Soul system: a 37-tier growth line (appearance from the war-soul assets), upgraded with bound ingots, attributes counted into combat power and map entry requirements, optionally shown at the character's top-right; entry is the "War Soul" button in the character info popup (stacked vertically with "Rank", "Title" and "Fashion", the NPC War Soul Envoy still works)
- Fashion system: **20 outfits** (out/in frames come from `resources/clothes`; name / description / sell price / attributes live in the `fashions` table and are editable in the admin); the "Fashion" button in the character info popup opens the wardrobe — a four-column grid where one click wears an outfit and another takes it off, and it **only swaps the look, never the numbers**: attributes, HP and combat power still come from equipment; the character on the map, the popup's in-show view and the pre-map preload all resolve the look the same way (fashion > equipment cloth > sex default body), and wearing one never shifts the character (geometry still follows the equipped cloth); this version is wardrobe-only — acquisition channels (mall / events / drops) ship in a separate slice
- Title system: 34 animated name plates (all registered under `resources/titles`) arranged into a tier 1~34 growth line; unlock/upgrade flow mirrors War Soul (bound ingot price curve), attributes generated by the curve; once unlocked the plate shows permanently above the character's head bar (same node as the rank red text / HP bar), entry is the "Title" button in the character info popup (no NPC involved)
- Rank system: a **100-tier** growth line (10 major segments × 10 tiers: Soldier → Commandant → Commandery Commandant → Leader of the Gentlemen → General → Distinguished General → Minister → Prince → Divine General → Myth), promoted with bound ingots, attributes generated as "equivalent-level base attributes × rate × major-segment factor" (sitting between Title and War Soul); the rank **has no assets of its own** — its appearance is the line of **red text** above the HP bar in the character's overhead info bar, updated immediately after promotion; entry is the "Rank" button in the character info popup (top of the three stacked buttons), and the 100-tier list in the left column is built once when opened rather than rebuilt on each selection change
- HP recovery per second: **level / defensive equipment / War Soul / Title / Rank** five sources summed into one attribute (N points per second), settled once per second by the main game loop and persisted (sharing one write with MP recovery); strength **derived from the max-HP ratio** (1% per second by default, the whole rate is tuned by changing only `configs/growth.attributeRange.hpRecoverRate`); **only defensive slots carry HP recovery** (chest 40% / head 20% / belt 20% / boots 20%); no recovery while dead, recovery **does not count towards combat power** (so it never raises any map's combat-power gate), monsters do not recover HP; old saves get the field backfilled
- Overhead display convention: **the character name sits in the middle of the body area** (same "body centre" convention as monster names, auto-centred against the `roleBody` height); the overhead info bar keeps only the rank red text / HP bar / HP number, with the title plate animation inserted above them
- Popup layering: with several popups open at once, **clicking one floats it above the others** (both touch and mouse input channels are taken over; transient layers such as toast tips and hover item details stay above popups, while the full-screen confirm dialog and the death mask stay above everything)
- Map teleport: the teleport officer popup groups maps by map type, maps whose level / combat power / War Soul requirements are unmet explain why on click
- Minimap popup: reads the map directory's `preview.jpg` for a large preview, left-click pathfinds automatically, right-click teleports directly
- Asset preloading: preloads the map, NPC / monster frame animations and the worn appearance before entering a map
- Joystick: a persistent joystick at the bottom left (base + draggable handle); hold and drag to move — **drag a little to walk, drag far to run** (dead zone / thresholds in `configs/role.joystickMove`); touch channel only, desktop mouse hold-and-drag works too, presses on the joystick do not fall through, and releasing never clears the selected target by accident
- Screen adaptation: a **single 1920×1080 resolution** (1 design pixel = 1 screen pixel); the runtime never sets the resolution and never relayouts on resize; when the window aspect differs the engine scales proportionally and leaves black bars, while in-game coordinates and element positions stay identical
- Server: account registration and login (scrypt salted digest), character data saved to the cloud (debounced merged pushes), revision-number optimistic locking, two token audiences, permission-point guards, login throttling, password reset and proactive token revocation, operator audit logs, announcement publishing with server-wide delivery, mail channel (templates + delivery queue + failure retry), realtime channel (a one-shot ticket exchanges for a WebSocket connection, heartbeat and liveness probing, one connection per account, online-heartbeat sweeping so crash / network-drop no longer leaves a role "online" forever), **server-side damage settlement** (the server computes monster-damage from the shared snapshot values, castId idempotency, death determination — the client only plays the presentation), **world authority** (monster instances owned by the server: seeding on map entry / shared across accounts / tick-based respawn / state persisted across restarts — the client only plays the presentation and merges deltas)
- Admin: account and character management (six-dimension filtering / structured editing / batch delete), administrators and permissions, audit log queries, my account; the character detail page shows equipment / skills / items / maps / War Soul, Title and Rank as **names** (taken from the game data all three sides share — the admin keeps no copy of its own)
- **There is one copy of the game data**: equipment / War Soul / Title / Rank / skills / items / maps are all defined in the client's `client/assets/configs`, which `tools/gen-shared-data.cjs` snapshots into `server/src/shared/game-data.generated.ts` — the server and the admin read **the same file** (`tools/audit-shared-data.cjs` keeps it byte-identical to the client's configs, asserts every table is present and non-empty, and rejects any second copy: a same-named table, a hand-written code list, or a copied-over Chinese name). Even the server's `occupation / sex` code lists and the `1 <name> / 2 <name> / …` list line in the API docs are **computed** from that data, so adding an occupation code on the client updates all three sides automatically.

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

- **Every pitfall turns into a script.** Regression is not prevented by memory here, but by automated guards: 58 unit-test suites under `client/tools/` and 13 audits under `tools/`, denser than the business code — whether configs leaked, whether addresses are hard-coded, whether generated artifacts match the server docs byte for byte, whether the combat-rules snapshot has drifted, whether the attributes the server computes match the client's version, whether UI clicks fall through to the world, whether module boundaries are bypassed — all of it is watched by scripts.
- **Everything tunable lives in `client/assets/configs`.** Numbers, texts, layout, colours, durations and asset paths are never written into logic. This convention was forced by "AI keeps changing the numbers", not chosen for elegance.
- **All API files are generated from the server's Swagger document.** A signature mismatch between the sides becomes a **compile error**, not an `undefined` in production. For the same reason: when AI changes one side, the other two are stopped at compile time.
- **Regression is a hard gate.** Every change runs: server e2e (248 + 120 + 283 + 120 + 28 + 59 + 130 + 24 + 14 + 639 + 87 + 32 + 60 + 47 + 35 + 48 + 24 + 50  + 87 + 55  + 39 + 51 + 67 + 73 assertions) + typechecks on two sides + 58 unit-test suites + 13 audits — green means done.
- **One commit per problem solved.** A feature lands in its own commit the moment it's done, never a pile of mixed uncommitted changes — so "which change introduced this regression" can always be bisected.
- **Pitfalls went into the FAQ.** Each side's FAQ collects its own concrete problems; cross-side mechanisms and environment traps are in [FAQ.en.md](FAQ.en.md); every entry there was actually hit, including environment traps (for example an injected `NODE_OPTIONS` in some terminals makes the server **fail to start silently**).

### Expectation management

The code has full regression coverage and runs, but please read it as **a piece of AI work**: structural trade-offs lean towards "get it running first, converge later",
and some abstractions (config separated from logic, generated artifacts plus guards, pure functions plus unit tests) exist specifically **so AI can safely change things afterwards** — they may not be a human's first choice when writing code by hand.

If you want to see how far AI can take a project — the feature list below is the answer. Reviews, issues and brickbats welcome.

## Screenshots

**Login**

![Login](website/assets/img/login.jpg)

**Character selection and creation**

![Character selection and creation](website/assets/img/role_selector.jpg)

**Main game screen (character info / bag / skill popup)**

![Main game screen](website/assets/img/game.jpg)

**Skill list**

![Skill list](website/assets/img/skill.jpg)

**Monsters and combat**

![Monsters and combat](website/assets/img/monster.jpg)

**Equipment drop light pillars (ground drops play quality-based light pillars: 5 tiers Common→Godlike assigned automatically, the 6th reserved for special equipment)**

![Equipment drop light pillars](website/assets/img/drop-light.jpg)

**Minimap preview popup (large preview plus monster red dots / NPCs / spawn zones; left-click to pathfind, right-click to teleport)**

![Minimap preview popup](website/assets/img/small-map.jpg)

**War Soul system**

![War Soul system](website/assets/img/war-soul.jpg)

**Equipment quality borders and detail backgrounds (15 prefix/suffix quality borders in the bag; the hover detail popup shows a quality-matched background animation)**

![Equipment quality borders and detail backgrounds](website/assets/img/border_bg.jpg)

**Mall (the whole equipment catalogue, 3 cards per row and 6 items per page; hover an icon for full details)**

![Mall](website/assets/img/mall.jpg)

## Directory structure

```
olua/
├── README.md · FAQ.md      # overview and cross-side questions (this file)
├── client/                 # client: the Cocos Creator project (open this directory with it)
├── server/                 # server: NestJS
├── admin/                  # admin: React
├── tools/                  # project-level scripts (cross-side)
├── website/                # project website (static single page)
├── docs/                   # project docs (resume introduction, etc.)
└── resources_dist/         # asset manifest (for releases)
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
    - generated (never hand-edit): `ApiRoutes` path table / `ApiModels` types (mirroring the server DTOs) / `Api` methods (`HealthApi`·`AuthApi`·`AnnouncementApi`·`RoleApi`·`RealtimeApi`)
    - hand-written: `HttpClient` wrapper and shared dispatch / `ApiCodes` business codes and text keys / `ApiError` error normalisation / `Session` / `RoleSync` progress sync / `NetworkSetup` wiring
- assets/resources: assets (map tmx, frame animations, atlases, icons, UI assets)
- assets/scenes: login, character selection, loading and game scenes
- tools: **client-only scripts** (58 unit-test suites + config generators `gen-monster-config.cjs` / `gen-monster-drops.cjs` + asset cleaner `clean-role-empty-frames.cjs` + the `lib/` unit-test sandbox)
- settings / profiles / native / package.json / tsconfig.json: Cocos project configuration (`package.json` describes the Cocos project, not npm scripts)
- library / temp / build: Cocos cache and build output (not version-controlled)
- Details in [client/README.md](client/README.en.md), questions in [client/FAQ.md](client/FAQ.en.md)

### server — the NestJS service

- src/common: unified response envelope, business codes, guards (auth `AuthGuard` / permission `PermissionGuard`), filters, interceptors, decorators
  - constants/permission: **the single source for permission points and admin roles** (role → permission mapping; the "required permission" in the docs is generated by looking it up)
  - constants/swagger-tags: documentation groups (public APIs / client / admin)
  - interceptors/audit.interceptor: **automatic logging of admin write APIs** (action taken from `operationId`, password-like fields masked before persisting)
  - security: pure-function login throttling decisions (`rate-limit.util`) + in-memory counter service (`login-throttle.service`)
- src/database: SQLite connection and the repository layer for 45 tables (accounts / roles / admins / audit_logs / announcements / mail_queue / world_monsters / map_spawn_areas / zones / world_meta / titles / souls / ranks / equipments / drugs / items / monsters / npcs / fashions / mall_prices / mall_settings / drop_tables / monster_drops / level_exps / growth_segments / growth_scalars / skills / statuses / monster_skills / guilds / guild_members / guild_applications / role_friends / role_enemies / role_blocks / role_reports / quests / quest_progress / achievements / role_achievements / role_mails / equip_aligns, including backfilling columns in existing databases)
- src/modules: auth (player authentication) / roles (characters) / admin (console: auth / accounts / characters / administrators / passwords) / announcement (announcements: public pull + admin CRUD) / mail (mail: templates + delivery queue + background scheduler) / audit (audit logs) / token (JWT) / health
- src/swagger/setup: documentation mounting (extracted into a function so tests can also generate docs once to verify grouping / permission annotations / dangling `$ref`)
- src/swagger/emit: **offline production of `openapi.json`** (`npm run swagger:emit`, the only input to both consumers' API files)
- openapi.json: the machine-readable contract (committed to the repo; must be regenerated after any API change, or both consumers stay on the old contract)
- test/e2e.cjs: end-to-end cases (real server + real requests, 248 assertions: registration and login / character CRUD / privilege escalation / token audience isolation / full admin flows / doc grouping and permission points / four-level escalation and super-admin protection / announcement pull and time windows)
- test/e2e-roles.cjs: **character management focus** (120 assertions: revision-number optimistic locking + guide-progress schema checks / six-dimension filtering / structured field validation / batch and whole-account deletion / read-only observer escalation / docs)
- test/e2e-guard.cjs: **operations and security baseline focus** (283 assertions: password reset and token revocation / self-service password change / audit log persistence, masking, filtering, permissions / login throttling by username and by IP / kicking offline)
- test/e2e-mail.cjs: **mail channel focus** (120 assertions: verifying enqueue / delivery / retry and exhausting the limit / manual re-delivery / whole-channel disabling when SMTP is unconfigured, using an injectable **fake sender**; no real SMTP server needed)
- test/e2e-account-email.cjs: **player email field focus** (28 assertions: viewers can neither see nor change it / backfill·clear / format and same-email dedup / mail falls back to the account's email)
- test/e2e-game-config.cjs: **game config focus** (44 assertions: title / soul seed identical to client configs / edit-only, no create or delete — POST and DELETE are 404 / partial updates and channel filtering / viewer can read but not write)
- test/e2e-blocks.cjs: **block and report focus** (50 assertions: one-way block rows, duplicate and self-block rejection / chat broadcast filtered per recipient and private messages with two different messages per direction / both incremental and full presence frames filtered / re-sending world join after unblocking / blocking also cuts friend and enemy ties / report dedup and invalid categories / read-only admin list and privilege escalation)
- test/e2e-party.cjs: **party focus** (79 assertions: invite creates the party / accept and decline / full party and duplicate invite / kick, transfer and the permission flip / leader leaving hands over automatically / disband clears all three sides / block wins with two different messages / presence frames carry partyId / exp sharing (killer keeps the full amount, same-map mates get 50%, other-map and level-gap mates get nothing) / dirty config falls back)
- test/e2e-rank.cjs: **leaderboard focus** (55 assertions: ranks and values checked one by one across three boards / ties share a rank under competition ranking / the combat board orders differently from the level board, so it is not a copy of level / page slicing, empty pages and size clamped to the cap / `me` returns a real rank both inside and outside the page, "no rank" when nothing is active / with the refresh period set to zero the snapshot ignores save changes / an entry has exactly eight fields and carries no accountId, data or online status / the periodic recompute really swaps in a new snapshot)
- test/e2e-achievement.cjs: **achievements focus** (39 assertions: snapshot delivery and condition expansion / cumulative kinds (kill any monster and a specific one, deliver quests) counted from events / state kinds (level, combat power, bag contents) **store no progress and are evaluated on read** / claiming grants rewards in a single write, re-claim and not-yet-achieved return 50133 and 50132 / a full bag **turns the whole reward into one in-game mail** while still recording the claim / admin edits plus refusal to delete once records exist / reference checks at generation time)
- test/e2e-game-mail.cjs: **in-game mail focus** (51 assertions: inbox with separate unread and unclaimed counters / re-marking read never overwrites the first timestamp / claiming grants gold, exp and items in one write, re-claim 50142, missing 50141, a mail without attachments never touches the save / attachments cannot be deleted before claiming 50143 / claim-all stops at a full bag / an achievement claim with a full bag turns into mail and is claimed from the inbox after freeing a slot / **channels**: all four badges always present, a per-channel claim only touches that channel, an unknown channel is 40000, a friend request lands in "social", a boss kill lands in "combat" while a normal monster does not)
- test/backup.cjs: **backup / restore focus** (87 assertions: `VACUUM INTO` consistent snapshot while running / restore archiving / protective refusal / automatic scheduled backup)
- Details in [server/README.md](server/README.en.md), questions in [server/FAQ.md](server/FAQ.en.md)

### admin — the React console

- src/api: address config (single source `config.ts`) + request layer `http.ts` (interceptors / timeout / envelope unwrapping / error normalisation / redirect to login on 401)
  + **generated** `routes.ts` path table / `models.ts` types / `endpoints.ts` methods (`authApi`·`rolesApi`·`questsApi`·`achievementsApi` and more — one method per endpoint; pages only import the name)
  + hand-written `types.ts` (business codes / permission points / action and target dictionaries) and `index.ts` (single entry point)
- src/pages: login / register / overview / account list and detail (reset password · kick offline · delete every character on the account) / character list (filtering + multi-select batch delete) and detail (basic info / common numbers / structured editing of equipment, skills and bag) / administrators (change role · enable-disable · reset password · delete) / announcements (publish · edit · delete · enable-disable + active status column) / mail (compose into queue + delivery records: status filter · retry count · failure reason · re-deliver) / audit logs (filter + pagination + expandable request body) / player reports (filter · pagination · row-expanded evidence, read-only) / my account (self-service password change) / **equipment alignment** (an eight-direction comparison workbench: with the bare model as the only reference, drag each garment and weapon into place in all 8 facings and **save straight to the server**, so the client sees it on its next load (no more exporting JSON and running a script)
- Menus and buttons are shown or hidden by the **permission points** in the token (`store/session.hasPermission`); the server still validates independently
- Details in [admin/README.md](admin/README.en.md), questions in [admin/FAQ.md](admin/FAQ.en.md)

### tools — project-level scripts (cross-side)

- gen-api.cjs: **produces both consumers' API files from `server/openapi.json`** (the only code generator; called by the server's `npm run gen:api`)
- gen-shared-data.cjs: **produces the game data shared by all three sides from `client/assets/configs`** (`server/src/shared/game-data.generated.ts` — the admin imports the *same file*) — combat numbers (levels 60 / War Soul 37 / Title 34 / Rank 100 + 7 combat-power weights + 555 equipment pieces with prefix/suffix variants already expanded + 12 skills with per-level damage coefficients + **220 monsters' maxHp and the six attack/defense ranges**) **plus** names and metadata (3 occupations / 566 items / 13 slots / 555 equipment display names / 12 skill names / 11 map names / every War Soul, Title and Rank tier name). To change a number or a label, edit the client config and regenerate — there is **no** second copy on any side
- audit-api-generated.cjs: generated artifacts byte-identical to the docs / header markers / full endpoint coverage / no dangling types / paths only in the path table / Cocos `.meta` files complete
- audit-api-hardcode.cjs: no hard-coded addresses on any side, requests leaving only through the single exit, every environment variable key registered in `.env.example`
- audit-config-leak.cjs: no tunables leaking into client core code, and every key in `configs/texts` registered (allowlist `config-leak-allowlist.json`)
- audit-ui-click-through.cjs: do client UI clicks fall through to the world, and is press ownership wired up completely
- audit-shared-data.cjs: is the shared game data byte-identical to the client's `configs`, and is every table present and non-empty (**data** drift raises no error, it just makes the two sides slowly compute different numbers); it also guards one cross-side numeric convention — the character cap must not exceed the character-select stand count, and the client holds no second limit number
- audit-combat-parity.cjs: do the character attributes the server computes match the client's `combatCalc` (**algorithm** drift). The expected values are not a copied formula — the real `GameHelper.combatCalc` is compiled into Node and run: 2849 input sets × 10 fields, covering all levels / all equipment / all War Soul, Title and Rank tiers
- audit-deploy.cjs: do the Docker / compose / nginx cross-file wirings line up (service names / ports / volumes / reverse-proxy prefixes / secret isolation)
- audit-docs-en.cjs: do the English translations stay in step with the Chinese (coverage / no leftover Chinese / section parity / no dropped numbers / anchors and links reachable / mutual links)
- audit-doc-numbers.cjs: do the numbers in the docs (endpoints / paths / models / permission points / tables / e2e assertions) match what is actually measured — these drift silently, leaving the docs confidently out of date (the per-end READMEs and the **project skills** are on the managed list too)
- gen-equip-align-catalog.cjs: produces the **equipment alignment workbench**'s read-only catalog from the client `configs` (2 bare models / 12 garments / 19 weapons × 8 directions, plus each item's current geometry) — a derived snapshot, never edited by hand
- audit-equip-align-catalog.cjs: is that catalog byte-for-byte identical to `configs` (without it the workbench hands you stale positions, you adjust and save, and the **second save silently overwrites the first result**), plus shapes that draw wrong without any error — expanded variants leaking in, a missing direction, an `outScale` of 0
- apply-equip-align.cjs: writes the JSON exported by the workbench back into `client/assets/configs/equipments.ts` and `role.ts` (geometry fields only, comments and indentation preserved). **Day-to-day saving does not need it** — the workbench writes straight to the `equip_aligns` table and the client applies it on its next load; this script is only for backups and for baking the final values into the shipped config

### Others

- website: project website (static single page: key features / screenshot gallery / three-tier architecture / engineering / contact info, logo and favicon in website/assets/icons)
- public: screenshots, showcase assets and the contact QR code
- docs: project docs (`resume.md` etc.)

## Tech stack

- Cocos Creator 3.8.7
- TypeScript
- Cocos UI / 2D scene system / Box2D physics (rigid bodies and colliders)
- Server: NestJS 12 + `node:sqlite` (built into Node 22, no native module dependencies) + JWT (two audiences, player and admin) + Swagger
- Admin: React 19 + TypeScript + Vite + Tailwind CSS v4
- How it is built: **written entirely by AI (Vibe Coding)**, humans only request features and accept the result — see [A project written entirely by AI](#a-project-written-entirely-by-ai)

### Storage and multiple processes: SQLite WAL (the #37 decision)

The storage choice is **one shared SQLite file with WAL**, not Postgres: single-machine deployment with naturally low write frequency (player saves are throttled, world state is flushed in 5-second batches), so a file database running `journal_mode = WAL` + `busy_timeout` comfortably covers multi-process "each writes its own tables" low-frequency concurrency; switching databases would mean one more container to operate, a rewritten SQL dialect, and a data migration — payoff that does not justify the cost. Only when servers multiply or write QPS rises should the switch happen — the repository layer (all SQL lives under `repositories/`) is the only layer that changes. Full reasoning in the [FAQ](FAQ.en.md#why-sqlite-instead-of-postgres-how-do-multiple-processes-share-it); the server process-split design is in issues #175 / #176.

## Common commands (Makefile)

The repository root ships a Makefile collecting the three sides' routine actions in one place (`make` / `make help` lists everything, `make info` prints the current toolchain and key paths):

```bash
make install        # first time: install server / admin dependencies
make env            # generate server/.env (skipped if it already exists)
make dev            # start server :3100 and admin :5173 together; Ctrl-C exits both

make client-check   # client typecheck (Cocos' bundled tsc; 0 errors means pass)
make client-test    # client's 58 unit-test suites
make server-verify  # verify the server with one command (compile + twenty-four e2e suites + generated-artifact audit)
make admin-build    # admin typecheck + build
make gen-api        # after changing APIs: regenerate the contract and both consumers' API files
make audit          # 13 cross-side audit scripts

make check          # static checks: client tsc + admin typecheck + 13 audits
make test           # all tests: client's 57 suites + server's twenty-four e2e suites
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
- Verify everything with one command: `npm run verify` (compile + twenty-four e2e suites + generated-artifact consistency)
- Details in [server/README.md](server/README.en.md)

### 2. Client (Cocos)

1. Install and open Cocos Creator 3.8.7.
2. Open **`client/`** through Creator's "Open" / "Open Project" (it is the Cocos project root).
3. In the editor, open a scene under `client/assets/scenes`.
4. Run the project with the preview or play button.

The client has no npm scripts; it relies on the Cocos Creator editor to launch and preview.
Which server it talks to is decided solely by `baseUrl` in `client/assets/configs/network.ts` (use the LAN IP for on-device debugging).
Details in [client/README.md](client/README.en.md).

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
# Client: 58 unit-test suites (run inside client/; scripts locate Cocos' bundled tsc themselves)
cd client && for t in tools/test-*.cjs; do node "$t" || exit 1; done

# Server: compile + twenty-four e2e suites (248 / 120 / 283 / 120 / 28 / 59 / 130 / 24 / 14 / 639 / 87 / 32 + 60 + 47 + 35 + 48 + 24 + 50  + 87 + 55  + 39 + 51 + 67 + 73) + generated-artifact consistency
cd server && npm run verify

# Admin: typecheck + build
cd admin && npm run build

# Project-level audits (run from the repository root)
node tools/audit-api-generated.cjs && node tools/audit-api-hardcode.cjs \
  && node tools/audit-config-leak.cjs && node tools/audit-ui-click-through.cjs
```

> In restricted environments (for example terminals with `NODE_OPTIONS` injected) you need to clear it for server child processes: `env -u NODE_OPTIONS npm run dev`. Details in [FAQ.en.md](FAQ.en.md).

### 6. Resources sync (resources is not committed; how do multiple developers stay in sync)

`client/assets/resources/` is large (raw art files) and **intentionally not committed** (see `.gitignore`). Multi-machine consistency is maintained by "manifest lock + GitHub Release distribution":

- **Manifest**: `resources.manifest.json` is committed to the repo and records the sha1 + size of every resource file (including `.meta` — Cocos uuids live in the meta files, so they must ship with the distribution; regenerating meta per machine drifts uuids and breaks prefab references).
- **Distribution**: split zips are attached to a GitHub Release (tag = `resources-<version>`), each volume capped at 1900MB (Release assets are limited to 2GiB, so oversized groups roll over into numbered parts automatically).

Daily actions:

```bash
make resources-verify                      # run after pulling: local resources vs manifest; mismatches are listed
make resources-download VERSION=<v>        # on mismatch or a fresh machine: download volumes from the Release, extract, verify
```

Publishing after changing resources (whoever changes resources publishes):

```bash
make resources-manifest VERSION=<v>        # regenerate the manifest (version is written into it, committed with the code)
make resources-pack VERSION=<v>            # pack split zips into resources_dist/<v>/
make resources-upload VERSION=<v>          # upload to the GitHub Release (requires a logged-in gh)
```

Convention: **merge the PR that carries the new manifest first, then upload** (once others pull the new manifest, `resources-verify` turns red; at that point `make resources-download VERSION=<v>` realigns them). The tool itself is `client/tools/resources_sync.py`.

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
| War Soul numbers and costs tuned per tier | Upgrade costs and attributes are **per-tier literal tables** (37 tiers, one editable row per tier in `soulUpgradeCosts` / `soulLevelAttributes` in `configs/soul`), no longer derived by a runtime formula; full tier ≈ 67.5% of level-60 base attributes, and the three-line ordering Title 39% < Rank 52.5% < War Soul 67.5% is locked by unit tests |  ✅  |

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
| Per-monster drop tables | `configs/monsterDrops` holds one list per monster, each entry configuring weight / probability / count plus the drop-count range; potions and materials tiered by level (percent potions are tier-free and dropped by every monster), equipment covering all 555 variants by level bracket |  ✅  |
| One-click bag tidy | One button at the popup bottom: merge stackables of the same kind + reorder by level / slot, **filling from the first cell with empty cells sunk to the bottom**, implemented as unit-testable pure functions |  ✅  |
| Bag item dragging | Hold an item and drag it to another cell: empty = move, same stackable kind = merge (overflow stays in the source cell), otherwise = swap; ghost icon follows with highlight on drop target, dragging **never pulls the whole popup along**, rules are unit-testable pure functions |  ✅  |
| One-click bag recycle | One button at the popup bottom: equipment in the bag turns into **bound ingots** (worn gear excluded), price = level curve × prefix/suffix multiplier, applied after two-step confirmation |  ✅  |
| Bag item discard | **Drag an item outside the bag popup and release** → full-screen confirm (confirm = destroy the whole stack, cancel = returns to its cell); there is also a "Discard" button at the popup bottom entering discard mode to click cells (two-step confirmation). Works for every item category and coexists with "one-click recycle" |  ✅  |
| Generic confirm dialog | `components/dialogs/ConfirmDialog`: full-screen modal scrim + panel + confirm/cancel, claiming both touch and mouse input for itself (neither lower UI nor the world is clickable); texts passed in by the caller from `configs/texts` |  ✅  |
| Equipment numbers filled in | Values = growth curve (level tier × slot share × set power) × prefix/suffix rates, all derived from `configs/growth`; curve properties (slot strength gaps / prefix-suffix ladder / level growth / monotonicity) covered by pure-function unit tests |  ✅  |
| Bag stack count badge | Stackable items show their count in the cell's bottom-right corner (hidden at count 1, full-stack gets a different colour); the "stackable" judgement has a single source in the `stackable` config field, and the rule is a pure function covered by unit tests |  ✅  |
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
| Server-side damage settlement | Monster damage is **computed by the server from the shared snapshot values** (castId idempotency prevents double settlement, death is decided by the server); the client cross-checks against the "legal band" and logs a `[combat-parity]` warning on outliers; falls back to the same local formula automatically when the realtime channel is unavailable |  ✅  |
| Dash skill (Ten Steps One Kill) | Teleport to the mouse position: inside the range it lands exactly there, outside it lands at the farthest point the skill's distance allows, with a landing effect |  ✅  |
| Status numbers in damage | Block = probability-based half damage / defence boost = multiplicative factor, settled in BattleMath pure functions (rules in client/FAQ.en.md) |  ✅  |
| Monster skills | Monsters cast skills from their mount table **inside the server AI** (damaging and status kinds both emit `casts` frames for the client to play effects; numbers are still server-computed) |  ✅  |
| Player being-hit feedback | Damage numbers (staggered, no smearing) / hit reaction (never interrupts casting or auto-battle) / hit screen flash |  ✅  |
| Multiple players on one map (player presence) | **Same-map players see each other**: position / HP / moving flag / **appearance** (cloth, weapon, fashion — the very same assembly code as the main character) broadcast incrementally every 200 ms; entering a map gets one full snapshot, and disconnect / map change / timeout each broadcast an explicit leave. Position is still client-reported (the server forwards, never validates); no field-of-view culling |  ✅  |

### Monsters

| Feature | Description |  Status |
| --- | --- | :-: |
| Zone spawning | On map entry, monsters are generated randomly within the map's configured spawn rectangles |  ✅  |
| World authority (monster state) | **monster instances are owned by the server** (instanceId issuance, hp / alive / respawn time); seeding is adopted only on an empty map, accounts share the same monsters, state persists across restarts; falls back to local spawning without the realtime channel |  ✅  |
| Monster AI | Idle wandering, aggressive chasing, passive monsters chasing in anger when hurt, basic-attack settlement |  ✅  |
| Death animation | Nodes are removed only after the death animation finishes; missing frames fall back to removing immediately |  ✅  |
| Monster map info | Name centred (aggressive red / passive yellow), overhead HP bar plus HP number |  ✅  |
| Monster info panel / selection halo | Click to select, HP and attributes shown live |  ✅  |
| Monster configs fully completed | For all 220 monsters, the **visible body size (contentSize) and appearance offset (outOffset) are measured from the assets' auto-trim data** (generated by `client/tools/gen-monster-config.cjs`, which decides collision boxes / hit-testing / HP bar placement; historically numbers 5~220 were 0×0 and unclickable); animation speeds converge on a `monsterDefaultSpeedRate` default table with per-entry overrides; aggressive monsters follow the rule "BOSS or body width ≥ 250px" (76/220); sale prices generated by level × role |  ✅  |
| Monster respawn timer | **respawned by the server tick when the realtime channel is available** (replenished on a cycle after death and broadcast as world frames); the local fallback still spawns once per map entry |  ✅  |

### Death and revival

| Feature | Description |  Status |
| --- | --- | :-: |
| Character death flow | Death animation freezes on its last frame, all controls locked, monsters stop chasing the corpse |  ✅  |
| Revival popup | Black translucent mask + revive in place / safe revival (returns to the current map's revive point) |  ✅  |

### Guilds and social

| Feature | Notes | Status |
| --- | --- | :-: |
| Guilds (#388) | Create / apply / review / roster / kick / transfer leadership / leave / disband; **one person can only be in one guild**, enforced by a unique index rather than business-level discipline; the leader has two identities (`guilds.leader_id` and the member row) changed in one transaction; the member limit comes from config (default 50, decoupled from guild level) | ✅ |
| Parties (#399) | Invite creates the party (the inviter with no party gets one with themselves as leader) / accept / decline / leave / kick / transfer / disband; **one party per role** is enforced by `party_members.role_id UNIQUE`, the leader is the only writer (no `is_leader` column on members); a leaving leader **hands over** to the earliest joiner; invites live in memory for 30 seconds, party size comes from config (default 4); **blocks win** — blocking him says "lift the block first", being blocked just says "not online" | ✅ |
| Party exp sharing (#399) | The killer keeps the full amount; every **online, same-map** mate gets `floor(their own level-gap exp × 50%)` (credited on the server and pushed as an `expGain` frame so the client `revision` keeps up); no even split (carrying someone would slow you down) and no bonus (it would invite multi-boxing); each mate's share is computed from their own level gap, so dragging a low-level alt to high-level monsters is stopped by the formula itself; drops and quest progress only credit the killer | ✅ |
| Party panel | Opened from the bottom bar (G) with two tabs: **Members** (pending invites on top with accept / decline; each row shows level and online / other-map / leader state, and the leader gets transfer / kick on other members) and **Invite** (nearby players, greyed out when already in the party or just invited); state is pushed **on change**, so leaving / being kicked / disbanding all arrive as the same empty snapshot | ✅ |
| Leaderboards (#400) | Three server-wide boards: **level** (`roles.level`), **combat** (the same number as the character detail, locked by `audit-combat-parity`) and **kills** (a new indexed `roles.kills` column, incremented by 1 on the server by combat settlement and unreachable from the client); **ordering, ranks, truncation and field trimming all happen on the server**, the client only renders. Ranks are **competition ranks** (ties share a rank) with roleId as the tie-breaker, so equal scores never swap places between recomputes; **offline characters are ranked too** (the board reads the save table). Materialisation happens **in-process and is never persisted**: the first request computes it lazily, then it is recomputed every `LEADERBOARD_REFRESH_MS` (default one minute) and the whole array is swapped atomically, so there is no second source of truth; the timer only starts **when someone first opens a board** (`unref`, and setting it to zero disables it). An entry has just eight fields — no accountId, no data and **no online flag** (it would invite camping); v1 is one board for the whole server, and `zoneId` on an entry is for display only | ✅ |
| Leaderboard panel | Opened from the small map's leaderboard tab (no new art, no room taken from the ten-slot bottom bar); switching tabs **refetches** (a cache would make players think "I levelled up and nothing moved"), and `page` plus `me` are fetched **concurrently from the same snapshot** (fetching them separately lets "I'm 37th" disagree with the 37th row); my own row is highlighted in place; a failed request **keeps the old data** and only shows a notice on top | ✅ |
| Friends and enemies (#389) | Add a friend (by roleId or by character name; **if the other side is already waiting, the add itself becomes the accept**) / accept / reject (leaves no trace) / cancel / delete (both sides disappear); enemies are **one-directional** — I mark mine and the other side is never told; friendships are stored as **two mirrored rows** (changed in pairs, always in a transaction), the limit comes from config (default 100) | ✅ |
| Name colours by relation (#389) | Blocked grey > enemy red > **party gold (#399)** > same-guild blue > friend green > same-map white > normal grey; precedence and palette live in exactly one place (`resolveRelation` in `configs/social.ts`), and the presence frame carries `roleId/guildId/guildName` (same 5-second lazy refresh as appearance, no extra queries); when the relation changes, the `Label` colour is updated in place — nodes are never rebuilt | ✅ |
| Blocks (#398) | A block is **one one-way row**, but the **filtering happens on the server**: world and guild chat drop the recipient, private messages are refused in both directions, presence frames never carry him (including the `full` snapshot) — the client simply never learns who blocked it (deliberately not sent). Blocking also cuts friend and enemy ties (leaving a "friend" label would be harder than the block itself); friend requests are the only channel that could bypass a block, so a hit reuses the "role not found" code | ✅ |
| Reports (#398) | Four fixed categories (abuse / cheat / name / other) plus a 200-character note; one pending report per (me → him) pair (50120); stored only, no penalty; the table has **no foreign keys** (evidence must outlive a deleted account) and names are joined at query time | ✅ |
| Social dialog | The fifth slot of the character-info dialog, five tabs: **Guild** (not in a guild = create form + full guild list; in a guild = info / notice / roster / pending applications / leave or disband), **Friends** (incoming / accepted / outgoing requests + add by name), **Enemies** (marked + mark by name), **Nearby** (whoever is visible on this map right now — sourced from presence frames, not a server roster), **Blocked** (who I blocked, block by name, unblock; each row also exposes report); **which buttons appear is decided by `canReview/canManage/canDisband` from the server** — the client never re-derives ranks itself | ✅ |
| Admin reports page | Player report list: keyword / category / status filters + pagination + row-expanded description and both role ids; **read-only in this release** (handling needs the full trail of who changed what and why, and a half-built button is worse than none); `report:read` is not granted to the viewer | ✅ |
| Achievements (#401) | Conditions split into two kinds with **completely different storage needs**: **cumulative** (kill N monsters / deliver N quests) can only be counted +1 from events, with progress in `role_achievements.progress`; **state kinds** (level / combat power / bag holdings) **store no progress and are evaluated on every read** — a stored projection only ever produces "the character got stronger but progress did not move". Kills have exactly one collection point: settlement emits `monster:killed` and quests plus achievements subscribe on the bus (each subscriber swallows its own errors; a failed write never rolls back a real kill). **Achieving and claiming are two different things**: `achieved_at` non-null means claimable, `claimed_at` non-null means claimed, and **rewards are never granted automatically** (stuffing every bag at deploy time is an incident); claiming reuses the same grant entry as quest turn-in, and a full bag **turns the whole reward into one in-game mail** (#429, a non-null `mailId`, claimed from the inbox) instead of dead-ending on "free up a slot first". Progress is always clamped to the threshold, so the client never has to clamp | ✅ |
| In-game mail (#429) | A player inbox with attachment claiming; **only the server can send mail** (achievement fallback, later operator grants), the client can only read, claim and delete. Attachments only enter the bag **on claim**, through the same grant entry as quests and achievements (one write, revision +1); **a mail with unclaimed attachments cannot be deleted** (deleting it would throw away the player's reward); claiming is idempotent via `claimed_at IS NULL` in SQL; claim-all walks oldest first and **stops at a full bag** (already-claimed mails stay claimed, `stoppedByBag` says there is more). Nothing to do with `mail_queue` (the outbound SMTP queue): different tables, different jobs. The small-map `mail` icon is now a **message center**: the mail panel carries the announcement entry, and the dot means "unread mail + unclaimed attachments + unread announcements". **Channel tabs** (#436): `channel` is a four-value enum (system / reward / social / combat) stored per row, deliberately separate from the source tag `kind` (achievement / friend / boss) — players only care "is this a reward". The endpoint does **no channel filtering** (one full snapshot plus per-channel badges, so switching tabs sends no request and the dot always counts everything), **claim-all follows the active tab** (`claim-all?channel=`, an unknown value is 40000 rather than "all"), and the **combat channel only records boss kills** (hundreds of normal monsters a day would turn it into a log) | ✅ |
| Achievement panel | 24 achievements (a gradient in each of the three categories plus 3 hidden ones). Opened from the second icon in the small map's left column (the art already existed; it used to be a placeholder), with three category tabs (battle / growth / explore) that **refetch on every tab switch**; the action button has three states (claimable green / claimed grey / not achieved grey), a successful claim shows a tip and a full bag now says "the reward went to your mailbox" (#429 turns the whole reward into a mail); **hidden achievements do not spoil their condition before being achieved**; a failed fetch **keeps the old data** and only shows a line in the list | ✅ |
| Admin achievements page | CRUD for achievement config: category / label and description / condition (labelled as "counted from events" or "evaluated on read") / rewards (gold, exp, items); **references are re-checked on save** (a kill target must be a real monster key or `*`, hold targets and reward items must exist) — a typo shows up as "the player can never unlock it", which an operator cannot see in the console; **deletion is refused once any player record exists** (even progress only) | ✅ |
| Admin guild page | Guild list (by member count desc) and roster; rename / edit notice / force-disband (members and pending applications go with it, the confirm dialog spells out the cost); the read-only viewer can look but not change | ✅ |

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
| Screen adaptation | A single 1920×1080 resolution (1 design pixel = 1 screen pixel): the runtime never changes the resolution and never relayouts on resize; windows with another aspect ratio get proportional scaling and black bars |  ✅  |
| Announcement display | **Login page**: entering the login scene pops "important" announcements (important only, not filtered by read state), closed with "Got it"; **in-game**: "Announcements" entry on the minimap plus an unread red dot, board split into two columns (left list layered "important first", ties keeping the server order; right column the body), opening marks the currently active announcements as read (you can still see which ones are new this time) |  ✅  |
| Asset gaps (decision: accepted) | Gaps = last 4 frames per weapon direction, cloth 011/012/013, weapon 021; zero live-config references (fashionClothes fully commented out), runtime degrades silently to valid frames — art will not be added, see #18 closing note |  ✅  |
| UI polish and naming conventions | Unified overall visuals and asset naming |  ❌  |
| Tutorial (#402) | A new character automatically walks through 6 steps: **move → fight → loot → bag → skills → chat and quests**. A cut-out mask highlights the current target (joystick / skill bar / bottom entries) with a bubble explaining what to do and an always-visible skip button; **progress advances on events, not on a "Next" click** (actually walked / killed one / picked something up / opened a panel), and the mask **neither blocks clicks nor locks movement** — getting stuck is an incident. Progress lives in the character save (`guide.step / done / skipped`), so reconnects and device changes resume where you were; **existing characters never see it** (no field means "already done"), and skipping is an explicit choice that persists. The step table lives in `configs/guide` (text / target / trigger event are all config) |  ✅  |

## Documentation

| Doc | Contents |
| --- | --- |
| [README.en.md](README.en.md) | This file: project overview, index of the three sides, directory structure, quick start, feature list |
| [FAQ.en.md](FAQ.en.md) | **Cross-side**: single source of truth for addresses, the contract pipeline, how the three sides interact, environment traps, how to run regression |
| [client/README.md](client/README.en.md) · [client/FAQ.md](client/FAQ.en.md) | Client: how to open the Cocos project, client architecture and conventions, preview errors and gameplay config questions |
| [server/README.md](server/README.en.md) · [server/FAQ.md](server/FAQ.en.md) | Server: startup and environment variables, data model, authentication and permissions, contract generation, throttling and audit |
| [admin/README.md](admin/README.en.md) · [admin/FAQ.md](admin/FAQ.en.md) | Admin: startup and build, permission-driven visibility, page list, division of labour in the api layer |
| [docs/resume.md](docs/resume.md) | Project introduction for résumé purposes |

## Assets and contact

> The art assets are too large to keep under version control — contact me if you need them.

![QQ group](website/assets/img/qq-group.jpg)
![WeChat group](website/assets/img/wechat-group.png)
