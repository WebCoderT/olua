# FAQ · Server

> [简体中文](FAQ.md) | English

> Questions about the server (NestJS): startup, data model, permissions, rate limiting, and audit.
>
> Cross-cutting mechanisms (single source of addresses / contract pipeline / three-end linkage) are in [../FAQ.en.md](../FAQ.en.md);
> client and admin questions are in [../client/FAQ.en.md](../client/FAQ.en.md) · [../admin/FAQ.en.md](../admin/FAQ.en.md);
> the server overview, environment-variable table, and directory structure are in [README.en.md](README.en.md).

## Table of contents

- [How do I run the server? Where are the API docs?](#how-do-i-run-the-server-where-are-the-api-docs)
- [How are the API docs grouped? Why does every admin interface list "required permission"?](#how-are-the-api-docs-grouped-why-does-every-admin-interface-list-required-permission)
- [How many admin roles are there? Where do I add permission points? What happens on insufficient permission?](#how-many-admin-roles-are-there-where-do-i-add-permission-points-what-happens-on-insufficient-permission)
- [Why doesn't the server validate the role data's content?](#why-doesnt-the-server-validate-the-role-datas-content)
- [Want to change the role-count limit? Which side do I change?](#want-to-change-the-role-count-limit-which-side-do-i-change)
- [Player forgot password? Why is he kicked out after a reset?](#player-forgot-password-why-is-he-kicked-out-after-a-reset)
- [Stuck on the login page? How does login rate limiting work?](#stuck-on-the-login-page-how-does-login-rate-limiting-work)
- [What does kicking a player offline in the admin console actually do? Why must they reselect a character?](#what-does-kicking-a-player-offline-in-the-admin-console-actually-do-why-must-they-reselect-a-character)
- [I clicked a button in the admin console — where do I see "who changed what"?](#i-clicked-a-button-in-the-admin-console--where-do-i-see-who-changed-what)
- [Tests keep "waiting for the server to start" and time out, with no logs — why?](#tests-keep-waiting-for-the-server-to-start-and-time-out-with-no-logs--why)

## Startup and runtime

### How do I run the server? Where are the API docs?

- **Startup**: `cd server && npm install && cp .env.example .env && npm run dev` (`npm run start` runs the built output). Listens on `3100` by default, route prefix `api`; the client connects to `http://localhost:3100/api` by default.
- **API docs**: <http://localhost:3100/api-docs> (Swagger UI; JSON at `/api-docs-json`). The docs have **no route prefix** because they are not a business interface. Every interface uses "unified response envelope + unified error sink", so every response in the docs is the standard envelope `{ code, message, data, timestamp }` (with an optional `path` added on errors) — five fields in total, where `data` carries the actual business payload.
- **Database**: SQLite (Node 22's built-in `node:sqlite`, **no native modules needed**), default `server/data/olua.db`. On first startup it auto-creates 18 tables: `accounts / roles / admins / audit_logs / announcements / mail_queue / world_monsters / titles / souls / level_exps / growth_segments / growth_scalars / ranks / equipments / drugs / items / monsters / npcs`. Deleting an account cascades to delete all its roles via the foreign key `ON DELETE CASCADE`.
- **Regression**: `cd server && npm run test:e2e` — a real server process + real HTTP requests, **248 assertions** (register/login / role CRUD and the count cap / duplicate-name rejection / save and online-switch / privilege escalation and token-audience isolation / full admin flow / **the three-group classification and every interface's permission annotation** / **read-only viewer escalation rejected** / **super-admin protection** / **public pull of announcements and the effective-time window**). For role changes run `npm run test:e2e:roles` (110 assertions) additionally; for password / audit / rate-limit / kick-offline changes run `npm run test:e2e:guard` (283 assertions); for **mail-channel** changes run `npm run test:e2e:mail` (120 assertions, using an injectable fake mailer, no SMTP server needed); for **player-email-field** changes run `npm run test:e2e:account-email` (28 assertions); for **realtime-channel** changes run `npm run test:e2e:realtime` (50 assertions, real WebSocket handshake, no browser needed); for backup / restore changes run `npm run test:e2e:backup` (87 assertions). One command for everything: `npm run verify`.
- **Rule for adding an interface**: only change the server (controller + DTO + `operationId`), then `npm run gen:api` to regenerate the two ends' interface files — see [../FAQ.en.md](../FAQ.en.md#why-are-the-api-files-paths--types--methods-generated-what-do-i-touch-to-add-an-endpoint). Paths, method names, and types must not be hand-written on either end.

### Tests keep "waiting for the server to start" and time out, with no logs — why?

**Some terminals / IDEs inject `NODE_OPTIONS` (usually a `--require` shim).** The server is started as a child process, and inheriting this env var makes it start silently — **no logs printed, no port listened** — so the e2e hangs on "waiting for the server to start", which looks like a port conflict or a code problem but is neither.

```bash
env -u NODE_OPTIONS npm run dev
env -u NODE_OPTIONS npm run verify
```

A related environment pitfall: on this machine `curl 127.0.0.1` may be routed through a proxy env var and return 502 (a fake failure) — add `--noproxy '*'` to work around it.

## Interfaces and docs

### How are the API docs grouped? Why does every admin interface list "required permission"?

- **Three groups = three kinds of caller**, in order of permission tier:
  1. **Public interfaces** — no token needed: `/health`, player register/login, admin login/register, **pulling active announcements** (6 in total)
  2. **Client** — needs a `player` token and may only operate on its own account data (9 in total)
  3. **Admin** — needs an `admin` token, and each interface also demands a permission point (45 in total)
- **Grouping is tagged per interface, not per controller**: in the auth controller `register/login` belong to "public", `me` belongs to "client" — one class has both groups. So no class-level `@ApiTags`; instead the combined decorators in `common/decorators/api-doc.decorator` (`ApiPublicDoc / ApiPlayerDoc / ApiAdminDoc`) handle grouping, the token-lock icon, and the permission note in one place.
- **A pitfall we hit**: Nest's Swagger has a default behavior of "no class-level tag → automatically use the controller class name as the group" (`autoTagControllers`, on by default), so every interface would get an extra class-name group like `Health` / `Auth` / `AdminRoles` in addition to its own. This is turned off in `main.ts` via `createDocument(..., { autoTagControllers: false })`; the e2e pins the assertion "every interface belongs to exactly one group".
- **"Required permission" is not hand-written**: the permission point passed to `ApiAdminDoc({ permissions })` (1) becomes runtime validation (the guard really reads this metadata) (2) is reverse-looked-up via `ROLE_PERMISSIONS` for "which roles own it" and written into the doc description (3) is attached to the operation as the `x-olua-permissions` extension (for machines to read). The three share one source, so you never get "documented but not enforced" or "enforced but not documented".
- When adding an interface, the steps in passing: add a permission point → `@ApiAdminDoc({ permissions: [Permission.XXX] })` on the controller → decide which roles own it (only change `ROLE_PERMISSIONS`) → run e2e.

### How many admin roles are there? Where do I add permission points? What happens on insufficient permission?

- **Three-tier roles** (`server/src/common/constants/permission.ts` is the only source):

| Role | Permissions |
| --- | --- |
| Super admin `super_admin` | All permissions (including "manage admins" and "reset admin password") |
| Admin `admin` | All except "manage admins" — admins cannot elevate each other |
| Read-only viewer `viewer` | Read only: overview / account list & detail / role list & detail / **announcement list** / **title & war soul config lists** (**cannot see the operation log, system info, or mail delivery records**) |

- **Permission points** (20): `stats:read`, `account:read`, `account:status`, `account:password`, `account:delete`, `account:email`, `role:read`, `role:write`, `role:select`, `role:delete`, `announcement:read`, `announcement:write`, `mail:read`, `mail:write`, `admin:read`, `admin:manage`, `audit:read`, `system:read`, `gameConfig:read`, `gameConfig:write`. **To add a permission point, only change the `ROLE_PERMISSIONS` table** — do not write `if (role === "admin")` in business code.
- `account:password` (resetting a player's password) is its own point, not folded into `account:status`: it can **take over someone else's account**, so its sensitivity is higher than a ban and deserves to be separately toggleable.
- Why split `announcement:read` / `announcement:write`: announcements are **public content broadcast to the whole server** — reading is not the same as editing, so the viewer gets `read`; but publishing / editing pushes straight to all players, which is outward communication, so `write` is its own point.
- **Why `mail:read` is withheld from the viewer** (opposite of `announcement:read`): the delivery records contain players' **email addresses**, which are personal information, not public content. The viewer's role is to see business data, not to pick up an exportable list of player contacts — this boundary looks like "just another read permission" and is easy to add by mistake, so the reasoning is written down here.
- **How the role is decided at registration**: the **first** admin registered becomes super admin automatically (otherwise no one could manage admins); thereafter everyone is a normal admin, and elevation is done by the super admin on the admin console's "Admins" page. Stale databases are backstopped by `ensureSuperAdmin()`.
- **What happens on insufficient permission**: `403` + business code **30006**, and the message states directly which permission is missing (e.g. "current role lacks the permission for this operation: ban / unban account"). The admin UI **hides menus and disables buttons by permission point**, but that is only UX — the server re-checks every request, so editing the URL by hand still yields only 403.
- **Takes effect immediately**: the guard fetches the admin's role from the database on every request (same logic as account banning), so after a demotion the old token is restricted on its next request, no need to wait for token expiry.
- **Two safeguards (business code 30007)**: you cannot demote / disable / delete the **last enabled super admin** — otherwise the console would have no one to manage it. When a second super admin exists, self-demotion is allowed (can be used for shift rotation).
- Regression: section seven of `cd server && npm run test:e2e` (viewer's four write operations rejected, demotion takes effect immediately, super-admin protection, admin list & filtering); for role changes run `npm run test:e2e:roles` (110 assertions) additionally; for password / audit / rate-limit / kick-offline changes run `npm run test:e2e:guard` (283 assertions).

## Data model

### Why doesn't the server validate the role data's content?

- **Role data is an "opaque document"**: backpack / equipment / skills / hotkeys / newbie items are all generated from the client's `configs/role` configuration; the server **does not duplicate** the game config (duplication inevitably drifts: change the config but forget the server, and you get "the client has it but the server says it's illegal"). So the server only validates structure, ownership, count caps, and duplicate names, storing the content as-is.
- **The cost and its backstop**: the server stores only the index fields (id / name / occupation / sex / level) as separate columns — so list queries don't need to parse JSON. Changing client config **does not require** syncing the server.
- **Even the "allowed values" lists and the doc text are derived**: the validation lists `ROLE_OCCUPATIONS` / `ROLE_SEXES` are the label tables' keys (`Object.keys`), and the `1 <name> / 2 <name> / 3 <name> / 4 <name>` list line in the API docs is computed by `shared/game-data.ts` — add an occupation code on the client (or rename one), regenerate the shared data, and the server **needs no change at all**. These two spots used to be hand-written with a "kept in sync with the client" comment, which only works if someone remembers (#122 made them derived and taught the guard to bite when they are written back).
- **Watch the save-format change**: `roles.data` stores a JSON **string**. The read path uses tolerant parsing (bad data → empty object), but **the edit path must parse strictly and error on failure** — never fall back to "empty object" for writing, which would wipe the player's backpack/equipment (this is a pit we hit, pinned by an e2e assertion).
- **Where the cap lives**: see the next item.

### Want to change the role-count limit? Which side do I change?

- **The business cap lives on the server**: `ROLE_MAX_PER_ACCOUNT` in `server/.env` (default 3); over-limit requests are rejected by the server at creation time. This is the **only** "limit" number.
- **The UI capacity lives on the client**: the `roleSelectorLayout.rolePositions` array in `configs/layout/scenes` *is* the character-select UI's **stands** (as many stands as are drawn, that many characters can be shown). The client's pre-creation check simply means "**all stands are taken**" (saving a round trip); it is not a second cap.
- **So it can only be lowered**: `ROLE_MAX_PER_ACCOUNT` must **not exceed** the stand count — raising it would let a player create a character the UI has nowhere to place (the extra one gets no stand and stacks at the origin, and the client logs a warning). Changing the stands is an **art / layout** job (the composition has to be redone) while changing `.env` is an **ops** job (downwards only), so the two no longer have to change together.
- **The guard**: `tools/audit-shared-data.cjs` asserts that the committed defaults (`.env.example` and the `configuration.ts` fallback) are ≤ the stand count, and forbids the client from introducing a second limit number. The **runtime** `.env` is deployment-local (not in the repo), so the guard cannot see it — which is why the relationship is spelled out above, backed by the client's runtime warning.

## Passwords and security

### Player forgot password? Why is he kicked out after a reset?

- The client has **no recovery flow** (no email / SMS); only a support agent can reset it from the admin console: "Account Management → into an account → Reset Password"; the "Admins" page can also reset other admins' passwords (`admin:manage`, super-admin only).
- The password is **generated on the frontend** (10 characters, deliberately excluding easily-confused characters like `0/O`, `1/l/I`), **shown only once**: the server stores only the scrypt hash, and once the popup is closed it can never be retrieved — if forgotten, you can only reset again.
- After a reset, **all previously issued tokens are voided**. The mechanism: both tables add a `token_version` column; when issuing a token it is written into the payload (`ver`), and `AuthGuard` re-checks the database on every request — a mismatch returns `401` + business code **40103**. A stateless JWT cannot kick old tokens by merely changing the password, which is exactly the gap this fills.
- **Changing your own password goes through the admin console's "My Account" page**, not the "Reset Password" above: that one verifies the old password, and on success the server **issues a new token** (the old token is already void), which the frontend overwrites into the local session — otherwise an admin who changes their own password would immediately be kicked back to the login page. Likewise, the "Reset Password" entry in the admin list is disabled for your own row.
- Changing the password and incrementing the version are written in **one SQL statement** (avoids a half-state of "password changed but version not incremented", and no lost increment under concurrency); stale databases are patched by `ensureColumn` at startup, defaulting to `0`; old tokens without a `ver` field are treated as `0` — backward compatible, no need to purge the database.
- How the two admin-console entries are split is in [../admin/FAQ.en.md](../admin/FAQ.en.md).

### Stuck on the login page? How does login rate limiting work?

- Two dimensions are counted separately; either one exceeding its cap locks: **username** (`LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MS`, default 5 attempts / 10 minutes) and **source IP** (`LOGIN_IP_MAX_FAILURES` / `LOGIN_IP_LOCK_MS`, default 20 attempts / 10 minutes). Shared between the player side and the admin side.
- On hitting the threshold the **counter resets to zero** (recount from 0 after the lock expires) — swapping a "locked, then keeps failing" UX problem for "max brute-force rate = threshold ÷ lock duration".
- The decision is a **pure function** (`common/utils/rate-limit.util.ts`: `afterFailure` / `lockedForMs` / `remainingAttempts` / `describeWait`…), and the counter lives only in memory (this is short-lived rate state; persisting it only adds write amplification and garbage; the cost is the counter resetting on process restart, acceptable for single-instance SQLite, and the interface shape stays the same if we later switch to Redis). `maxFailures <= 0` = disable that dimension — the e2e uses exactly this to relax the IP dimension to 1000 so it can test the username dimension in isolation.
- **Username is trimmed of spaces + lowercased before counting**, so changing the case cannot bypass the limit.
- **The reverse-proxy pitfall**: with `TRUST_PROXY=false` (default, direct connection) `request.ip` is the real source; behind Nginx / cloud load balancer you **must** set it to `true`, otherwise all players share one proxy IP and get locked together. Conversely, with it on while directly exposed, it allows forging `X-Forwarded-For` to bypass the limit. Both scenarios are documented in `server/.env.example`. Note: `app.set('trust proxy', ...)` only exists on the Express adapter, so `NestFactory.create<NestExpressApplication>` is required.
- **What the client sees when locked**: business code `10005` (player) / `30009` (admin), with the message saying how long to wait. The client's `ApiCodes` has the corresponding text key.

### What does kicking a player offline in the admin console actually do? Why must they reselect a character?

- The console does exactly one thing: clear the account's `online_role_id`. But **clearing the flag alone cannot stop the person** — the player is still running locally and will push their save back up 1.5 seconds later.
- So the server adds a check on the save-write path: **the role being pushed up must still be the account's current online role**, otherwise `409` + business code **20007** (`ROLE_KICKED`). This check is placed **before** the optimistic lock — the kicked player should see "back to character select", not repeatedly retry "version conflict".
- After the client receives 20007: a floating tip "your character has been taken offline by an administrator, please reselect a character to enter the game" → **only clears the local online flag** (`StorageManager.clearOnlineRole`) → back to character select. **Never delete the local character like 20002 (character deleted) does**: the character still exists, and deleting it would really lose it — `client/tools/test-client-net.cjs` specifically pins "no `deleteRole` may appear in this handling".
- Reselecting once is enough to continue: character select calls `POST /roles/:id/select` to rewrite `online_role_id` and conveniently fetches the server's latest data.
- Side effect (acceptable): after a player manually switches characters, the old character's save can no longer be pushed back. Only one character runs per account at a time in-game, so no multi-character concurrency was built.
- The console-side entry and limits are in [../admin/FAQ.en.md](../admin/FAQ.en.md#what-does-kicking-a-player-offline-actually-do-why-must-the-character-be-selected-again).

### I clicked a button in the admin console — where do I see "who changed what"?

- **Admin write interfaces auto-leave a trace** (`common/interceptors/audit.interceptor`): only `POST/PUT/PATCH/DELETE`, skipping `@Public()` and player tokens. **Read interfaces are not recorded** — otherwise flipping through one list page would flood the log.
- **The action is the interface identifier**: `@ApiAdminDoc({ operationId })` also does `SetMetadata(AUDIT_ACTION_KEY, operationId)`, so "the interface identifier in the docs" and "the action in the log" are always the same string, **zero extra work for new interfaces**. The Chinese name is just a display dictionary in the admin console's `api/types.ts` (unregistered ones show the identifier as-is); the action dropdown in the filter is pulled from `/admin/audit-logs/actions`, not hard-coded in the UI.
- **Both successful and failed logins are recorded** (`AuditService.recordLoginAttempt`): at that point there is no "authenticated operator" yet, so the operator is left blank and the attempted account name is put into `detail` — this is exactly the event most in need of a trace (who, when, from where, hammered which account).
- **Sensitive fields are recursively masked**: a field name matching `/pass(word)?|secret|token|registercode|credential/i` has its value replaced with `***`. Better to over-mask — the audit log is something you will definitely read after the fact, and one leaked password is plaintext lying in the database.
- **Never affects the main flow**: `record()` swallows all exceptions internally (if the log table can't be written, a ban operation still shouldn't fail); beyond `AUDIT_LOG_MAX_ROWS` (default 20,000 rows) it tidies the oldest every 200 rows written.
- The target's **current** name is fetched via a correlated subquery (one table serves three kinds of target, the JOIN would need three UNIONs); a deleted target shows "(deleted)" + id (the log row stores the id, so it doesn't distort on rename).
- The query's `keyword` fuzzy-matches **operator account name / action / target id / request path** — both `%` and `_` are treated literally (otherwise an underscore in a player name would silently become a single-character wildcard and match extra rows).
- The read-only viewer cannot see this page: `audit:read` is not among its three read permissions — its role is to see data, not to investigate people.
- The admin console's query UI (filter items / expand details) is in [../admin/README.en.md](../admin/README.en.md).

## Related docs

- [README.en.md](README.en.md) — server overview, environment-variable table, directory structure, testing and regression
- [../FAQ.en.md](../FAQ.en.md) — cross-cutting mechanisms (single source of addresses, contract pipeline, three-end linkage, environment pitfalls)
- [../client/FAQ.en.md](../client/FAQ.en.md) — client questions
- [../admin/FAQ.en.md](../admin/FAQ.en.md) — admin questions
