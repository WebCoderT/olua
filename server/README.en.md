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
| `npm run test:e2e:roles` | Role-management suite (77 assertions) |
| `npm run test:e2e:guard` | Operations & security base (279 assertions) |
| `npm run test:e2e:mail` | Mail channel (108 assertions; **fake mailer**, no SMTP server needed) |
| `npm run test:e2e:backup` | Backup / restore (25 assertions) |
| `npm run db:backup` | Backup the data file (`VACUUM INTO`, can run while the service is up) |
| `npm run db:restore` | Restore from backup (with "service may be running" detection and old-db archiving) |
| `npm run verify:api` | `swagger:emit` + generated-file consistency audit |
| `npm run verify` | **one command for everything**: compile + five e2e suites + generated-file audit |

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
| `ROLE_MAX_PER_ACCOUNT` | `3` | Max characters per account (**must match the client's `configs/role.maxRoleCount`**) |
| `CORS_ORIGINS` | `*` | Allowed CORS origins, comma-separated |
| `NODE_ENV` | `development` | Only affects flags, does not change behavior |
| `LOG_REQUESTS` | `true` | Whether to log each request (method/path/latency only, **no request body**) |
| `TRUST_PROXY` | `false` | Whether to trust the client IP from a reverse proxy (**two-way trap, see below**) |
| `LOGIN_MAX_FAILURES` | `5` | How many consecutive failures on one username before lockout |
| `LOGIN_LOCK_MS` | `600000` | Username-dimension lock duration (10 minutes) |
| `LOGIN_IP_MAX_FAILURES` | `20` | How many failures from one IP within the lock window before lockout |
| `LOGIN_IP_LOCK_MS` | `600000` | IP-dimension lock duration |
| `AUDIT_LOG_MAX_ROWS` | `20000` | Audit-log retention cap (oldest auto-purged beyond it; `0` = never purge) |

> **The `TRUST_PROXY` two-way trap**: behind Nginx / a gateway you **must set `true`** — otherwise every request's source IP is the proxy's,
> and login rate limiting would treat all players as one person and lock them all out; conversely, **when exposed directly you must keep it `false`** — leaving it on lets the caller
> forge `X-Forwarded-For` to bypass IP limiting. This is also spelled out in `.env.example`.

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
│   │   └── repositories/           seven repositories: account / admin / role / audit / system / announcement / mail
│   ├── modules/
│   │   ├── auth/                   player register/login (JWT, token version)
│   │   ├── roles/                  character CRUD / online selection / save push (with 20006 / 20007 judgment)
│   │   ├── admin/                  admin console: auth / accounts / characters / admins / passwords / announcements
│   │   ├── announcement/           announcements: client pulls "active" (public) + admin CRUD
│   │   ├── mail/                   mail: templates + delivery queue + background scheduler (sending only enqueues)
│   │   ├── audit/                  operation-log query
│   │   ├── system/                 system info (runtime / per-table row counts / masked config snapshot)
│   │   ├── token/                  JWT issue & verify (dual audience)
│   │   └── health/
│   └── swagger/
│       ├── setup.ts                doc mounting (factored into a function so tests can also generate once to verify grouping/permissions/dangling $ref)
│       ├── models.ts               response models for docs
│       └── emit.ts                 ← offline emit of openapi.json
├── scripts/                        backup / restore (VACUUM INTO + five-step restore, see scripts/lib/db-tooling.cjs)
├── test/
│   ├── e2e.cjs                     248 assertions (real server + real HTTP requests)
│   ├── e2e-roles.cjs               77 assertions
│   ├── e2e-guard.cjs               279 assertions
│   ├── e2e-mail.cjs                108 assertions (fake mailer: enqueue / deliver / retry cap / disabled when off)
│   └── backup.cjs                  25 assertions (backup while running / restore archiving / protective refusal)
├── openapi.json                    machine-readable contract (committed to the repo)
├── data/                          SQLite data files (not versioned)
└── .env.example · package.json · tsconfig.json · tsconfig.build.json
```

## Data model

Six tables, all created by `DatabaseService` at startup via `CREATE TABLE IF NOT EXISTS`; **existing databases are patched by `ensureColumn` (PRAGMA table_info)**, no migration scripts needed.

| Table | Stores | Key points |
| --- | --- | --- |
| `accounts` | player accounts | password is a scrypt digest; `status` ban bit; **`token_version`** token version |
| `roles` | characters | `data` column stores a **JSON string** of the client's `entities/Role`; index fields (id/name/occupation/sex/level) are also separate columns; **`revision`** optimistic-lock version; `online_role_id` points from the account side to the current online character |
| `admins` | admin accounts | independent of the player-account system; `role` (super_admin / admin / viewer); **`token_version`** |
| `audit_logs` | operation log | action = interface `operationId`; `detail` holds the request body (masked); `success` / `status_code` / `actor_name` / `target_id` / `path` |
| `announcements` | announcements | title / body / `level` (`important` shown first) / `enabled`; `starts_at` / `ends_at` form the effective window, **"active" is judged by exactly these three columns** (built `idx_announcements_window`) |
| `mail_queue` | mail delivery queue | **rendered** title and body (frozen at enqueue time) / `status` / `attempts` / `next_retry_at` / `last_error`; the send interface only enqueues, delivery is done by the background scheduler |

**Character data is an "opaque document"**: the server **does not duplicate** game config, only validating structure / ownership / count caps / duplicate names, storing content as-is.
Reasons and costs: [FAQ.en.md](FAQ.en.md#why-doesnt-the-server-validate-the-role-datas-content).

⚠️ Read and write paths differ in attitude: **read is tolerant** (bad data → empty object), **edit must parse strictly and error on failure** —
falling back to an empty object for writing would wipe the player's backpack/equipment (a pit we hit, pinned by an e2e assertion).

## Auth and permissions

Two layers, **both in guards; business code must not write role checks**:

1. **Audience** (`AuthGuard`): whether the token's `aud` is `player` or `admin`, the guard checks per interface's requirement;
   and **re-checks the database on every request** — ban / deletion / password change take effect instantly, no waiting for token expiry
2. **Permission point** (`PermissionGuard`, registered after `AuthGuard`): uses `request.user.role` directly, no further DB lookup

The only source of permission points is `src/common/constants/permission.ts` (17 permission points / 3 roles):

| Role | Permissions |
| --- | --- |
| Super admin `super_admin` | All (including "manage admins" and "reset admin password") |
| Admin `admin` | All except "manage admins" — admins cannot elevate each other |
| Read-only viewer `viewer` | Read only: overview / account list & detail / character list & detail / **announcement list** (**cannot see the operation log, system info, or mail delivery records**) |

> Why the viewer gets announcements **read-only**: they are public content broadcast to the whole server, reading ≠ editing; "publish / edit" is the separate
> `announcement:write` (speaking outward, pushed straight to players), which the viewer does not get.
>
> Mail is the **opposite** for the viewer (`mail:read` is not among its four read permissions): the delivery records contain players' **email addresses**,
> which are personal information — the viewer's job is to see business data, not to pick up an exportable list of player contacts.
> This line looks like "just another read permission" and is easy to add by mistake.

**Adding an admin interface must use `@ApiAdminDoc({ permissions: [Permission.X] })`** — it lands in three places at once:
① doc description ② the `x-olua-permissions` extension (for machines) ③ `RequirePermissions` runtime metadata.
**Omitting it is a real pass-through** (we once wrote only docs without enforcement, all permissions open, caught by e2e).

On refusal: no permission `403` + business code **30006**; protective refusal `403` + **30007** (**the last enabled super admin** cannot be demoted / disabled / deleted).

## Interfaces and contract

Currently **50 interfaces / 40 paths / 66 models**, grouped into three by "who can call" (`common/constants/swagger-tags.ts` declares, order = display order):

| Group | Count | Token requirement |
| --- | --- | --- |
| Public | 6 | No token (health check, player register/login, admin login/register, **pull active announcements**) |
| Client | 8 | `player` token, may only operate its own account's data |
| Admin | 36 | `admin` token + each interface's own permission point |

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

All five e2e suites are **real server process + real HTTP requests** (not mocks):

| Script | Assertions | Coverage |
| --- | --- | --- |
| `test/e2e.cjs` | **248** | register/login / character CRUD and count cap / duplicate-name rejection / save and online-switch / escalation and token-audience isolation / full admin flow / **three-group classification and every interface's permission annotation** / read-only viewer escalation / super-admin protection / **public pull of announcements and the effective-time window** |
| `test/e2e-roles.cjs` | **77** | character-management suite: optimistic-lock revision / six-dimension filtering / structured-field validation / batch and whole-account deletion / read-only viewer escalation / docs |
| `test/e2e-guard.cjs` | **279** | operations & security base: password reset and token invalidation / self-service password change / operation-log persistence·masking·filtering·export / username & IP dual-dimension limiting / kick offline / ban closed-loop / dashboard / list sorting / system info and startup self-check |
| `test/e2e-mail.cjs` | **108** | mail channel: enqueue returns immediately / background delivery to sent / **exponential-backoff retry and failure after cap (reason queryable)** / manual re-delivery resets the count / fully disabled when SMTP unconfigured / key only reports shape / template missing required variable rejects send. Uses an **injectable fake mailer** (`MAIL_TRANSPORT=fake|fail`), no real SMTP needed |
| `test/backup.cjs` | **25** | backup / restore: `VACUUM INTO` while running for a consistent snapshot / old db archived after restore / bad file and "service may be running" protective refusal |

```bash
cd server && npm run verify          # compile + five e2e suites + generated-file consistency, one command for everything
env -u NODE_OPTIONS npm run verify   # in a restricted terminal clear NODE_OPTIONS
```

Prioritize the matching suite for what you changed (character interface → `test:e2e:roles`; password / audit / limiting / kick-offline → `test:e2e:guard`; mail → `test:e2e:mail`),
but **`npm run verify` should pass before committing**.

## Related docs

- [FAQ.en.md](FAQ.en.md) — startup, data model, permissions, limiting, and audit specifics
- [../FAQ.en.md](../FAQ.en.md) — cross-cutting mechanisms (single source of addresses, contract pipeline, three-end linkage, environment pitfalls)
- [../README.en.md](../README.en.md) — project overview, three-end index, directory structure
- [../admin/README.en.md](../admin/README.en.md) — the console that consumes these interfaces
- [../client/README.en.md](../client/README.en.md) — the client that consumes these interfaces
