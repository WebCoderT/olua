# server · Server (NestJS)

> [简体中文](README.md) | English

> The server behind accounts / characters / admin interfaces: SQLite-backed, Swagger-documented.
> **It is also the single source of truth for the three-end interface contract** — both the client's `ApiRoutes/ApiModels/Api.ts` and the admin's `routes/models/endpoints.ts` are generated from its `openapi.json`.
>
> Project overview: [../README.en.md](../README.en.md); server questions: [FAQ.en.md](FAQ.en.md);
> client / admin / cross-cutting: [../client/](../client/) · [../admin/](../admin/) · [../FAQ.en.md](../FAQ.en.md).

## Tech stack

- **NestJS 12** + TypeScript
- **`node:sqlite`** (built into Node 22, **no native modules needed**, no need to compile sqlite3)
- **JWT** (`@nestjs/jwt`) — two audiences (`aud`) for players and the admin console
- **Swagger** (`@nestjs/swagger`) — both human docs and the machine-readable source for the two ends' interface files
- Passwords: `node:crypto`'s `scrypt` (built-in salt + `timingSafeEqual`, format `scrypt$salt$hash`, algorithm can be swapped smoothly)

## Environment requirements

- **Node.js 22+** (`node:sqlite` needs 22.5+)
- No Docker / no external database needed

## Quick start

```bash
cd server
npm install
cp .env.example .env     # first time: port / keys / caps are all here; every line is commented
npm run dev              # dev (ts-node hot reload); npm run build && npm run start runs the built output
```

- API docs: <http://localhost:3100/api-docs> (JSON at `/api-docs-json`, feedable straight to Postman / codegen)
- Health check: <http://localhost:3100/api/health>
- Database: default `server/data/olua.db` (SQLite, WAL mode; auto-creates tables + patches columns on first startup)

> ⚠️ **Won't run in a restricted terminal** (no logs, no port listened, no error shown) is usually because the environment injected `NODE_OPTIONS`:
> `env -u NODE_OPTIONS npm run dev`. See [FAQ.en.md](FAQ.en.md#tests-keep-waiting-for-the-server-to-start-and-time-out-with-no-logs--why).

## npm scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev mode (ts-node runs the source directly) |
| `npm run build` | Compile to `dist/` |
| `npm run start` | Run the built output |
| `npm run swagger:emit` | Compile + emit `openapi.json` from source (the single source of the contract) |
| `npm run gen:api` | `swagger:emit` + `node ../tools/gen-api.cjs` — **regenerate both ends' interface files** |
| `npm run test:e2e` | Main e2e (248 assertions) |
| `npm run test:e2e:roles` | Role-management suite (110 assertions) |
| `npm run test:e2e:guard` | Operations & security base (283 assertions) |
| `npm run test:e2e:mail` | Mail channel (120 assertions; **fake mailer**, no SMTP server needed) |
| `npm run test:e2e:account-email` | Player email field (28 assertions) |
| `npm run test:e2e:realtime` | Realtime channel (50 assertions; **real WebSocket handshake**, no browser needed) |
| `npm run test:e2e:backup` | Backup / restore (87 assertions) |
| `npm run db:backup` | Backup the data file (`VACUUM INTO`, can run while the service is up) |
| `npm run db:restore` | Restore from backup (with "service may be running" detection and old-db archiving) |
| `npm run verify:api` | `swagger:emit` + generated-file consistency audit |
| `npm run verify` | **one command for everything**: compile + nine e2e suites + generated-file audit |

> The repo-root `make` is a shortcut for these: `make server-dev` / `make server-verify` /
> `make gen-api` / `make server-e2e-guard`, etc.; `make help` lists them all.
> The Makefile already handles `env -u NODE_OPTIONS` uniformly, so you don't have to hand-write the prefix in a restricted terminal.

## Environment variables

All in `server/.env` (template in `.env.example`, **every item is commented**).
Literal values of these keys must not appear in code — `node ../tools/audit-api-hardcode.cjs` checks "every key used is registered in `.env.example`".

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3100` | Listen port |
| `API_PREFIX` | `api` | Global route prefix (Swagger is fixed at `/api-docs`, no prefix) |
| `DB_PATH` | `data/olua.db` | SQLite file (relative to `server/`); `:memory:` drops on process exit |
| `JWT_SECRET` | dev placeholder | **Must be a random long string in production** |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `ADMIN_REGISTER_CODE` | has value | Admin registration code; empty = open registration |
| `ROLE_MAX_PER_ACCOUNT` | `3` | Max characters per account (**lower only**: must not exceed the character-select UI's stand count `roleSelectorLayout.rolePositions`; a guard enforces this) |
| `CORS_ORIGINS` | `*` | Allowed CORS origins, comma-separated |
| `NODE_ENV` | `development` | Only affects flags, does not change behavior |
| `LOG_REQUESTS` | `true` | Whether to log each request (method/path/latency only, **no request body**) |
| `TRUST_PROXY` | `false` | Whether to trust the client IP from a reverse proxy (**two-way trap, see below**) |
| `LOGIN_MAX_FAILURES` | `5` | How many consecutive failures on one username before lockout |
| `LOGIN_LOCK_MS` | `600000` | Username-dimension lock duration (10 minutes) |
| `LOGIN_IP_MAX_FAILURES` | `20` | How many failures from one IP within the lock window before lockout |
| `LOGIN_IP_LOCK_MS` | `600000` | IP-dimension lock duration |
| `AUDIT_LOG_MAX_ROWS` | `20000` | Audit-log retention cap (oldest auto-purged beyond it; `0` = never purge) |
| `MAIL_RETENTION_DAYS` | `90` | Mail-delivery record retention days (older ones auto-purged; `0` = no time-based purge) |
| `MAIL_QUEUE_MAX_ROWS` | `20000` | Mail-delivery record retention cap (only sent / failed, so undelivered mail is never dropped; `0` = never purge) |
| `REALTIME_TICKET_TTL_MS` | `30000` | Lifetime of a realtime connection ticket (one-shot, burned on use; the ticket can appear in a URL, so it only lives 30 seconds) |
| `REALTIME_HEARTBEAT_MS` | `30000` | WebSocket liveness-probe interval (the server sends protocol-level pings; the client uses it to pace its application-level `ping`) |
| `REALTIME_EMBEDDED` | `true` | whether the realtime channel is embedded in the main process; `false` = standalone form (the main process mounts neither the WS channel nor the ticket endpoint; `main.realtime.ts` boots a dedicated realtime process, #37) |
| `REALTIME_PORT` | `3101` | the realtime process listen port (only used in standalone form; nginx reverse-proxies `/api/realtime*` to it) |
| `REALTIME_KICK_POLL_MS` | `3000` | kick-offline sweep interval (polls the online-role flag in the database and closes connections once cleared; `0` = off) |

> **The `TRUST_PROXY` two-way trap**: behind Nginx / a gateway you **must set `true`** — otherwise every request's source IP is the proxy's,
> and login rate limiting would treat all players as one person and lock them all out; conversely, **when exposed directly you must keep it `false`** — leaving it on lets the caller
> forge `X-Forwarded-For` to bypass IP limiting. This is also spelled out in `.env.example`.

> **`ROLE_MAX_PER_ACCOUNT` can only go down**: on the client, "how many characters you can have" is the **UI capacity** —
> the character-select layout `configs/layout/scenes` has `roleSelectorLayout.rolePositions` **stands**, i.e. as many as are drawn,
> and the client's pre-check is exactly "all stands are taken". So this value must **not exceed the stand count**: raising it would
> let a player create a character the UI has nowhere to place (the extra one stacks at the origin). The two are no longer "the
> same thing", so they no longer have to change together — adding stands is layout / art work, while this knob only goes down.
> The committed defaults are enforced by `tools/audit-shared-data.cjs`; the **deployment's `.env` is not in the repo**, so the guard
> cannot see it — do not set it above the stand count.

## Directory structure

```
server/
├── src/
│   ├── main.ts                     bootstrap (NestExpressApplication + trust proxy + ValidationPipe + CORS)
│   ├── app.module.ts
│   ├── config/configuration.ts     ← the only place all env vars are read (with type conversion and defaults)
│   ├── common/
│   │   ├── constants/biz-code.ts       business codes (1xxxx accounts / 2xxxx characters / 3xxxx admin / 4xxxx common)
│   │   ├── constants/permission.ts     ← the only source of permission points and admin roles
│   │   ├── constants/swagger-tags.ts    doc grouping (order = display order)
│   │   ├── constants/status.ts         status constants
│   │   ├── decorators/                 api-doc / api-data-response / api-query-model /
│   │   │                               audience / audit-target / current-user / permission / public
│   │   ├── dto/api-envelope.dto.ts     unified response envelope
│   │   ├── errors/biz.exception.ts     business exception
│   │   ├── filters/all-exceptions.filter.ts   unified error sink
│   │   ├── guards/auth.guard.ts        audience check + per-request DB re-check (ban/delete/token-version take effect instantly)
│   │   ├── guards/permission.guard.ts  permission-point check (registered after AuthGuard)
│   │   ├── interceptors/audit.interceptor.ts   auto-logs admin write interfaces
│   │   ├── interceptors/transform.interceptor.ts · logging.interceptor.ts
│   │   ├── interfaces/api-envelope.interface.ts
│   │   ├── security/login-throttle.service.ts   in-memory counter (username + IP dimensions)
│   │   └── utils/password.util.ts (scrypt) · rate-limit.util.ts (rate-limit pure functions)
│   ├── database/
│   │   ├── database.service.ts      connect / create tables / ensureColumn patch / ensureSuperAdmin backstop
│   │   ├── database.module.ts
│   │   ├── rows.ts                  row types and JSON-column parsing
│   │   └── repositories/           21 repositories: account / admin / role / audit / system / announcement / mail / world-monster / title / soul / growth / rank / equipment / drug / item / monster / npc / mall / fashion / drop-table / monster-drop
│   ├── modules/
│   │   ├── auth/                   player register/login (JWT, token version)
│   │   ├── roles/                  character CRUD / online selection / save push (with 20006 / 20007 judgment)
│   │   ├── admin/                  admin console: auth / accounts / characters / admins / passwords / announcements
│   │   ├── announcement/           announcements: client pulls "active" (public) + admin CRUD
│   │   ├── mail/                   mail: templates + delivery queue + background scheduler (sending only enqueues)
│   │   ├── realtime/               realtime: ticket exchanges for a WebSocket connection / heartbeat / graceful shutdown
│   │   ├── audit/                  operation-log query
│   │   ├── system/                 system info (runtime / per-table row counts / masked config snapshot)
│   │   ├── token/                  JWT issue & verify (dual audience)
│   │   └── health/
│   ├── shared/
│   │   ├── game-data.generated.ts  shared game-data artifact (**the one source all three sides read**; @generated,
│   │   │                           regenerate with node tools/gen-shared-data.cjs)
│   │   └── game-data.ts            server facade (hand-written): derives the occupation / sex code lists and doc text
│   └── swagger/
│       ├── setup.ts                doc mounting (factored into a function so tests can also generate once to verify grouping/permissions/dangling $ref)
│       ├── models.ts               response models for docs
│       └── emit.ts                 ← offline emit of openapi.json
├── scripts/                        backup / restore (VACUUM INTO + five-step restore, see scripts/lib/db-tooling.cjs)
├── test/
│   ├── e2e.cjs                     248 assertions (real server + real HTTP requests)
│   ├── e2e-roles.cjs               110 assertions
│   ├── e2e-guard.cjs               283 assertions
│   ├── e2e-mail.cjs                120 assertions (fake mailer: enqueue / deliver / retry cap / disabled when off)
│   ├── e2e-account-email.cjs       28 assertions (email visibility / backfill dedup / mail falls back to the account)
│   ├── e2e-realtime.cjs            50 assertions (ticket exchange / refused handshake / heartbeat and takeover / graceful shutdown)
│   ├── e2e-combat.cjs              32 assertions (server-side damage: band check / idempotent replay / targets resolved from world instances / reset does not revive)
│   ├── e2e-world.cjs               22 assertions (world authority: seeding & sharing / settlement lands in world / tick respawn / graceful flush / restart recovery)
│   ├── e2e-dual.cjs                14 assertions (dual-process form: archive vs realtime processes / cross-process token checks / kick-poll disconnect / WAL cross-process writes)
│   └── backup.cjs                  87 assertions (backup while running / restore archiving / protective refusal / automatic scheduled backup)
├── openapi.json                    machine-readable contract (committed to the repo)
├── data/                          SQLite data files (not versioned)
└── .env.example · package.json · tsconfig.json · tsconfig.build.json
```

## Data model

23 tables, all created by `DatabaseService` at startup via `CREATE TABLE IF NOT EXISTS`; **existing databases are patched by `ensureColumn` (PRAGMA table_info)**, no migration scripts needed.

| Table | Stores | Key points |
| --- | --- | --- |
| `accounts` | player accounts | password is a scrypt digest; `status` ban bit; **`token_version`** token version |
| `roles` | characters | `data` column stores a **JSON string** of the client's `entities/Role`; index fields (id/name/occupation/sex/level) are also separate columns; **`revision`** optimistic-lock version; `online_role_id` points from the account side to the current online character |
| `admins` | admin accounts | independent of the player-account system; `role` (super_admin / admin / viewer); **`token_version`** |
| `audit_logs` | operation log | action = interface `operationId`; `detail` holds the request body (masked); `success` / `status_code` / `actor_name` / `target_id` / `path` |
| `announcements` | announcements | title / body / `level` (`important` shown first) / `enabled`; `starts_at` / `ends_at` form the effective window, **"active" is judged by exactly these three columns** (built `idx_announcements_window`) |
| `mail_queue` | mail delivery queue | **rendered** title and body (frozen at enqueue time) / `status` / `attempts` / `next_retry_at` / `last_error`; the send interface only enqueues, delivery is done by the background scheduler |
| `world_monsters` | world-authority monster instances | **the server owns monster state**: instanceId (`m<mapId>_<n>` issuance, stable across restarts) / mapId / monsterKey / spawn point x,y / hp / alive / killed_at / respawn_at; tick checks respawn + dirty batch flush; client seeding is **adopted only on an empty map** |
| `level_exps` | level-up experience (#256) | fixed level sequence (1..roleMaxLevel), edit-only; one row = experience needed to reach the next level |
| `growth_segments` | growth-curve segments (#256) | four piecewise-linear curves x segments; edits must keep the curve covering 1..roleMaxLevel contiguously (cross-row validation) |
| `growth_scalars` | growth scalar parameters (#256) | level cap / attribute-range rates / experience pacing; each key has its own value domain |
| `ranks` | rank configuration (#250) | fixed rank sequence (1..100), edit-only; label / tier / promotion price / eight attributes |
| `equipments` | equipment base-piece config (#252) | primary key is the base-piece id (e.g. `cloth_1`, variants not stored); slot / level requirement / sell price / eight attributes; id & slot structure fixed, edit-only |
| `drugs` | drug config (#253) | primary key is the drug id (e.g. `drug_hp_1`, referenced by drop tables and backpack); label / description / sell price / stack cap / cooldown / four recovery amounts (effects summed per key); id list fixed, edit-only |
| `items` | item & material config (#255) | primary key is the item id (e.g. `material_hide`, referenced by drop tables and scripts); MATERIAL / OTHER types only; label / description / sell price / stack cap; id list fixed, edit-only |
| `monsters` | monster base data (#258) | primary key is the monster key (configs/monster association key, referenced by spawn points / drop tables); label / level / max HP / six attack-defense ranges; **world seeding and damage settlement read this table directly (changes take effect immediately)**; key list fixed, edit-only |
| `npcs` | NPC base data (#258) | primary key is the NPC id (Tiled object-group association key); label / dialog text (seeded empty — the client has no dialog data shape yet); id list fixed, edit-only |
| `fashions` | fashion config (#257) | primary key is the fashion id (configs/fashionClothes, e.g. `cloth_2`); label / description / sell price / acquire channel (reuses AcquireChannel, seeded `unavailable`) / eight attributes (seeded 0); `icon` / `in_res` / `out_res` resource paths are not editable; id list fixed, edit-only |
| `mall_prices` | mall special pricing (#251) | primary key is the good id (equipment variant id; the goods catalog comes from the generated snapshot); **the only config table in the database whose rows can be added/removed** (PUT upsert / DELETE back to the unified price); unpriced goods fall back to the unified price in `mall_settings` |
| `mall_settings` | mall unified price (#251) | single-row table (id always 1); the default price is seeded from the generated `MALL_DEFAULT_PRICE` (the client's configs/mall mallPrice) and is editable |
| `drop_tables` | drop tables (#254) | primary key is the table id (`[a-z][a-z0-9_]{0,49}`); `picks` (draw counts) and `entries` (goodId / weight / chance / count range) are JSON columns, structurally validated in the service (goodId must be in the generated ITEM_LABELS); **a config table whose rows can be added/removed** (same position as mall_prices); rows still referenced by `monster_drops.table_id` refuse deletion; seeded with three named tables common / elite / boss plus the default fallback |
| `monster_drops` | monster drops (#254) | primary key is the monster key (configs/monster join key); `source` is one of three: `table` (reference into drop_tables) / `entries` (inline entries + required picks) / `none` (cleared); keys map one-to-one to monsters, list + PATCH whole-replacement only, no add/remove |

**Character data is an "opaque document"**: the server **does not duplicate** game config, only validating structure / ownership / count caps / duplicate names, storing content as-is.
Reasons and costs: [FAQ.en.md](FAQ.en.md#why-doesnt-the-server-validate-the-role-datas-content).

⚠️ Read and write paths differ in attitude: **read is tolerant** (bad data → empty object), **edit must parse strictly and error on failure** —
falling back to an empty object for writing would wipe the player's backpack/equipment (a pit we hit, pinned by an e2e assertion).

## Internal boundaries: cross-module calls go through whitelisted edges

Modules split into domains by responsibility: **gateway** (`realtime/`: HTTP ticket + WS entry + damage settlement), **world** (`world/`: monster instances and the tick), **combat** (`combat/`: attribute summary and comparison **pure functions**), **archive** (`auth/` `roles/` `admin/` and the repository layer). Three rules, all machine-enforced by `tools/audit-server-boundaries.cjs`:

- **Cross-domain imports go through whitelisted edges**: any cross-module reference outside the table fails CI — adding an edge means editing `ALLOWED_EDGES` / `REPO_EDGES`, a conscious decision rather than a casual `import`;
- **Repositories are wired only by the global `DatabaseModule`** (all 21 repositories are provided + exported there): registering a same-named repository class in a business module's providers would create a **second instance** next to the global singleton (mail hit this: it registered `AccountRepository` locally too);
- **combat may only import the base layer** (common / shared / config): both the archive and settlement sides consume it, so reaching up into any implementation would form a cycle.

## Process split: archive process and realtime process (#175)

One codebase, two entries, assembled on demand (`AppModule.register({ realtime })`):

| | Archive process (`main.ts`) | Realtime process (`main.realtime.ts`) |
| --- | --- | --- |
| Port | `PORT` (default 3100) | `REALTIME_PORT` (default 3101) |
| Mounted | all HTTP modules (player / admin / announcements / mail / backup) | realtime channel + ticket endpoint + world authority + settlement |
| Default form | with `REALTIME_EMBEDDED=true` it **also** mounts the realtime modules (single process — local dev and all e2e) | only started in standalone deployment |

- **Zero client changes**: the ticket POST and the WS connection share the `/api/realtime*` path prefix; at deployment nginx reverse-proxies exactly that prefix to the realtime process — the single-source convention in `configs/network.ts` survives untouched;
- **Kick-offline across processes**: the admin kicks on the archive process (clears `online_role_id` in the database); the realtime process sweeps every `REALTIME_KICK_POLL_MS`, and once a connection's account has no online role anymore it closes the socket (`4000`). This also works in the embedded form (paying off the old debt that a kick never closed the WS right away);
- **Token revocation is cross-process by construction**: `token_version` is compared against the database on every request — both processes reading the same file see the same truth;
- **Storage**: both processes share one SQLite file (WAL + `busy_timeout`, see the root FAQ "Why SQLite") — the realtime process writes `world_monsters` and settled hp, the archive process writes accounts / roles; each writes its own tables.

## Auth and permissions

Two layers, **both in guards; business code must not write role checks**:

1. **Audience** (`AuthGuard`): whether the token's `aud` is `player` or `admin`, the guard checks per interface's requirement;
   and **re-checks the database on every request** — ban / deletion / password change take effect instantly, no waiting for token expiry
2. **Permission point** (`PermissionGuard`, registered after `AuthGuard`): uses `request.user.role` directly, no further DB lookup

The only source of permission points is `src/common/constants/permission.ts` (20 permission points / 3 roles):

| Role | Permissions |
| --- | --- |
| Super admin `super_admin` | All (including "manage admins" and "reset admin password") |
| Admin `admin` | All except "manage admins" — admins cannot elevate each other |
| Read-only viewer `viewer` | Read only: overview / account list & detail / role list & detail / **announcement list** / **title & war soul config lists** (**cannot see the operation log, system info, or mail delivery records**) |

> Why the viewer gets announcements **read-only**: they are public content broadcast to the whole server, reading ≠ editing; "publish / edit" is the separate
> `announcement:write` (speaking outward, pushed straight to players), which the viewer does not get.
>
> Mail is the **opposite** for the viewer (`mail:read` is not among its four read permissions): the delivery records contain players' **email addresses**,
> which are personal information — the viewer's job is to see business data, not to pick up an exportable list of player contacts.
> This line looks like "just another read permission" and is easy to add by mistake.

**Adding an admin interface must use `@ApiAdminDoc({ permissions: [Permission.X] })`** — it lands in three places at once:
(1) doc description (2) the `x-olua-permissions` extension (for machines) (3) `RequirePermissions` runtime metadata.
**Omitting it is a real pass-through** (we once wrote only docs without enforcement, all permissions open, caught by e2e).

On refusal: no permission `403` + business code **30006**; protective refusal `403` + **30007** (**the last enabled super admin** cannot be demoted / disabled / deleted).

## Interfaces and contract

Currently **92 interfaces / 78 paths / 143 models**, grouped into three by "who can call" (`common/constants/swagger-tags.ts` declares, order = display order):

| Group | Count | Token requirement |
| --- | --- | --- |
| Public | 6 | No token (health check, player register/login, admin login/register, **pull active announcements**) |
| Client | 10 | `player` token, may only operate its own account's data |
| Admin | 76 | `admin` token + each interface's own permission point |

**Grouping is tagged by method, not by controller**: one controller often has both public and login-required interfaces (e.g. `auth`'s `register/login` are public, `me` is client).
So **controllers do not write class-level `@ApiTags`**; use the combined decorators in `common/decorators/api-doc.decorator` uniformly;
and `createDocument(..., { autoTagControllers: false })` must be off (default `true` would take the controller class name as the group, adding a bunch of
`Health` / `Auth` class-name groups to the docs). e2e pins "every interface belongs to exactly one group".

### Changing an interface = changing the server + regenerating both ends

```bash
cd server && npm run gen:api     # = swagger:emit + node ../tools/gen-api.cjs
```

**The only code-generation direction**:

```
server/src (controllers + DTOs + decorators)   ← the only hand-written place
      │ npm run swagger:emit
      ▼
server/openapi.json (committed contract)
      │ node ../tools/gen-api.cjs
      ▼
client/assets/ui/utils/net/{ApiRoutes,ApiModels,Api}.ts
admin/src/api/{routes,models,endpoints}.ts
```

The generator reads these fields from the docs (written by decorators, not guessed); the full field table is in
[../README.en.md's "changing an API = changing the server + regenerating"](../README.en.md#4-changing-an-api--changing-the-server--regenerating).
Generated files must not be hand-edited; `../tools/audit-api-generated.cjs` watches them byte-for-byte.

## Operations and security base

Four capabilities described together because they were the same batch of operations gaps filled:

### Password management

- Players have **no recovery flow**; only a support agent can reset from the admin console; admin registration is controlled by `ADMIN_REGISTER_CODE`
- An admin **changing their own password** goes through "My Account" (verifies the old password), and on success the server **issues a new token** —
  otherwise the version in the DB is already +1, the old token invalidates on the spot, and they are kicked back to login right after changing
- Changing the password and incrementing the version are in **one SQL statement**, avoiding a half-state of "password changed but version not incremented"

### Active token invalidation

A stateless JWT can't kick old tokens by just changing the password, so `accounts` / `admins` each add a `token_version` column:
the token carries it in the payload (`ver`), `AuthGuard` re-checks the DB every request, a mismatch → `401` + business code **40103**.
Tokens without a `ver` field are treated as `0` (backward compatible, no need to purge).

### Login rate limiting

- **Pure functions + in-memory counter**: the decision is all in `common/utils/rate-limit.util.ts` (`afterFailure` / `lockedForMs` /
  `remainingAttempts` / `describeWait`…), the count is in `LoginThrottleService`'s Map (`u:<lowercase username>` and `i:<ip>`)
- **Either of two dimensions** over the cap locks; **on hitting the threshold the counter resets to zero** (recount from 0 after lock expires) — swapping a
  "locked, then keeps failing" UX problem for "max brute-force rate = threshold ÷ lock duration"
- **Username trimmed of spaces + lowercased** before counting, so changing case can't bypass the limit
- `maxFailures <= 0` = disable that dimension (e2e uses exactly this to relax the IP dimension to 1000 so it can test the username dimension alone)
- Not persisted: this is short-lived rate state, persisting only adds write amplification and garbage; the cost is reset on restart, acceptable for single-instance SQLite,
  and the interface shape stays the same if we later switch to Redis

### Kick offline

Clearing `online_role_id` alone can't stop the person — the player is still running locally and will push their save back up 1.5 seconds later.
So `RolesService.save` adds a check: **the pushed-up character must still be the account's current online character**, otherwise `409` + business code **20007**.
The check is placed **before the optimistic lock** — the kicked player should see "back to character select", not repeatedly retry "version conflict".

### Operation audit

- Only `POST/PUT/PATCH/DELETE` are watched, skipping `@Public()` and player tokens. **Read interfaces are not recorded** — otherwise flipping one list page floods the log
- **The action is the interface identifier**: `@ApiAdminDoc({ operationId })` also does `SetMetadata(AUDIT_ACTION_KEY, operationId)`,
  so "the interface identifier in the docs" and "the action in the log" are always the same string, **zero extra work for new interfaces**
- **Both successful and failed logins are recorded** (no authenticated operator yet then, so the operator is left blank and the attempted account name goes into `detail`)
- **Sensitive fields are recursively masked**: a field name matching `/pass(word)?|secret|token|registercode|credential/i` is replaced with `***`, over-masking preferred
- **Never affects the main flow**: `record()` swallows all exceptions internally (a ban op shouldn't fail just because the log table can't be written); beyond the cap it tidies the oldest every 200 rows
- The target name uses a correlated subquery for the current value (one table serves three target kinds, the JOIN would need three UNIONs); a deleted target shows "(deleted)" + id

## Testing and regression

All nine e2e suites are **real server process + real HTTP requests** (not mocks):

| Script | Assertions | Coverage |
| --- | --- | --- |
| `test/e2e.cjs` | **248** | register/login / character CRUD and count cap / duplicate-name rejection / save and online-switch / escalation and token-audience isolation / full admin flow / **three-group classification and every interface's permission annotation** / read-only viewer escalation / super-admin protection / **public pull of announcements and the effective-time window** |
| `test/e2e-roles.cjs` | **110** | character-management suite: optimistic-lock revision / six-dimension filtering / structured-field validation / batch and whole-account deletion / read-only viewer escalation / docs |
| `test/e2e-guard.cjs` | **283** | operations & security base: password reset and token invalidation / self-service password change / operation-log persistence·masking·filtering·export / username & IP dual-dimension limiting / kick offline / ban closed-loop / dashboard / list sorting / system info and startup self-check |
| `test/e2e-mail.cjs` | **120** | mail channel: enqueue returns immediately / background delivery to sent / **exponential-backoff retry and failure after cap (reason queryable)** / manual re-delivery resets the count / fully disabled when SMTP unconfigured / key only reports shape / template missing required variable rejects send. Uses an **injectable fake mailer** (`MAIL_TRANSPORT=fake|fail`), no real SMTP needed |
| `test/e2e-account-email.cjs` | **28** | player email field: read-only viewers can neither see nor change it / backfill·view·clear / format validation and same-email dedup (case-insensitive) / mail falls back to the linked account's email / contract permission annotation |
| `test/e2e-realtime.cjs` | **50** | realtime channel: the ticket is one-shot (burned on use / expired / forged / cross-account all refused) / **a refused handshake answers with an HTTP 401 envelope instead of "connect first, then close"** / application-level ping→pong / one connection per account (a new one evicts the old, close code `4000`) / protocol-level liveness probe / on SIGTERM connections receive `1001` and the process exits immediately |
| `test/e2e-combat.cjs` | **32** | server-side damage settlement (world-authority adaptation): every invalid cast is refused (bad_request / unknown_skill / unknown_target / skill_not_learned) / **damage is computed by the server from snapshot values** (lands inside the formula band, hp arithmetic is self-consistent) / the same castId replays idempotently (duplicate, no re-roll, no extra hp loss) / death is decided by the server (killed exactly once, then target_dead) / **targets resolve to world instances** (unknown instanceIds refused) / resetting the ledger does not revive dead monsters / snapshots carry respawn countdown / map round-trips keep state / rejoin after reconnect does not duplicate |
| `test/e2e-world.cjs` | **22** | world authority: **seeding only on an empty map** (repeated join does not duplicate, accounts share the same instances) / settlement lands directly in the world (snapshot hp = settled hp, visible to account B) / killing a monster queues a respawn / **tick respawns on time and broadcasts** / graceful shutdown flushes everything / **instance identity and hp restored as-is after restart** (due respawns backfilled at once) |
| `test/e2e-dual.cjs` | **14** | dual-process form (#175): the archive process (`REALTIME_EMBEDDED=false`) has no realtime endpoints (ticket POST → 404) / the realtime process validates tokens against **the same database** (ticket → WS → welcome) / worldJoin seeding and cast settlement run inside the realtime process / after the persist throttle, the **test process opens a read-only connection and sees** `world_monsters` (WAL carrying cross-process writes) / kicking from the archive process → the realtime process disconnects within one sweep interval (close `4000`) / password reset on the archive process → the old token is refused at the realtime process (`token_version` compared against the database) |
| `test/backup.cjs` | **87** | backup / restore: `VACUUM INTO` while running for a consistent snapshot / old db archived after restore / bad file and "service may be running" protective refusal / automatic scheduled backup (real process, visible failure, pure due-check function) |

```bash
cd server && npm run verify          # compile + nine e2e suites + generated-file consistency, one command for everything
env -u NODE_OPTIONS npm run verify   # in a restricted terminal clear NODE_OPTIONS
```

Prioritize the matching suite for what you changed (character interface → `test:e2e:roles`; password / audit / limiting / kick-offline → `test:e2e:guard`; mail → `test:e2e:mail`; realtime channel → `test:e2e:realtime`),
but **`npm run verify` should pass before committing**.

## Related docs

- [FAQ.en.md](FAQ.en.md) — startup, data model, permissions, limiting, and audit specifics
- [../FAQ.en.md](../FAQ.en.md) — cross-cutting mechanisms (single source of addresses, contract pipeline, three-end linkage, environment pitfalls)
- [../README.en.md](../README.en.md) — project overview, three-end index, directory structure
- [../admin/README.en.md](../admin/README.en.md) — the console that consumes these interfaces
- [../client/README.en.md](../client/README.en.md) — the client that consumes these interfaces
