# FAQ · Cross-side

> [简体中文](FAQ.md) | English

> This document collects questions that **span all three sides**: the single source of truth for addresses, the API contract pipeline, how the three sides interact, environment gotchas, and how to run regression.
>
> Side-specific questions live in their own directories (English editions land in follow-up issues and will be linked here once available):
> [client/FAQ.md](client/FAQ.md) (preview errors / engine pitfalls / gameplay config) ·
> [server/FAQ.md](server/FAQ.md) (startup / data model / permissions / throttling and audit) ·
> [admin/FAQ.md](admin/FAQ.en.md) (page usage / permission-driven visibility / build)
>
> Project overview and directory layout: [README.en.md](README.en.md).

## Contents

- [What does each side own? Where should a change land?](#what-does-each-side-own-where-should-a-change-land)
- [Switching the backend address (LAN / public domain): which files change?](#switching-the-backend-address-lan--public-domain-which-files-change)
- [Why are the API files (paths / types / methods) generated? What do I touch to add an endpoint?](#why-are-the-api-files-paths--types--methods-generated-what-do-i-touch-to-add-an-endpoint)
- [An admin edits a character — when does the player see it?](#an-admin-edits-a-character--when-does-the-player-see-it)
- [Local save vs server data: which one wins?](#local-save-vs-server-data-which-one-wins)
- [What are the generated artifacts on each side? What happens if I edit them by hand?](#what-are-the-generated-artifacts-on-each-side-what-happens-if-i-edit-them-by-hand)
- [How should regression be run? What must be green?](#how-should-regression-be-run-what-must-be-green)
- [Why does the test hang on "waiting for server startup" with no logs?](#why-does-the-test-hang-on-waiting-for-server-startup-with-no-logs)
- [AI changed a feature — how do I know it didn't quietly break something else?](#ai-changed-a-feature--how-do-i-know-it-didnt-quietly-break-something-else)

## What does each side own? Where should a change land?

One-line map:

| What you want to change | Directory | Key constraint |
| --- | --- | --- |
| Gameplay numbers / texts / UI layout / assets / gameplay logic | [`client/`](client/) | Every tunable belongs in `client/assets/configs`; no literal numbers in code |
| API behaviour / validation / permissions / table schema | [`server/`](server/) | **The only hand-written place for APIs**; always run `npm run gen:api` afterwards |
| Console pages / operator flows | [`admin/`](admin/) | API files are generated, never hand-written; UI visibility is UX only, the server is authoritative |
| Cross-side scripts (contract generation, project audits) | [`tools/`](tools/) | Run locally only; not part of any side's build |

Things that are easy to mix up:

- **The content of character data (what's in the bag, equipment numbers) is not the server's business.** The server validates structure, ownership, limits and name collisions, and stores the content as-is — because the truth about that data lives in `client/assets/configs`. see [server/FAQ.md](server/FAQ.md), "Why doesn't the server validate the content of character data".
- **"How many characters per account" exists on both sides** and both must be changed together: the authority is `server/.env`, while the client's `configs/role.maxRoleCount` only rejects early and keeps the UI slot count aligned.
- **Each side has its own single place for the address** — see the next entry.

## Switching the backend address (LAN / public domain): which files change?

Each side has exactly one **source of truth**. Change it there and it takes effect; no address literal can be found anywhere in the code.

| Side | Where | Notes |
| --- | --- | --- |
| Client | `baseUrl` in `client/assets/configs/network.ts` | Use the LAN IP for on-device debugging; same for switching domains |
| Admin | `VITE_API_BASE_URL` in `admin/.env.development` / `.env.production` | Code reads nothing but this variable (see `admin/src/api/config.ts`); production may use the relative path `/api` behind a same-origin reverse proxy |
| Server | `server/.env` | Port / prefix / database path / secrets / limits / CORS origins all live here, each explained in the comments |

Self-check (run from the repository root):

```bash
node tools/audit-api-hardcode.cjs
```

It scans the source of all three sides line by line and fails on "http address / localhost / bare `fetch` / bare `XMLHttpRequest` / hand-built `Authorization` / hard-coded API path",
and also checks that every environment variable used by admin and server is registered in `.env.example` (so the template can't silently drift when someone adds a setting). Comments and log lines are exempt (an example address in a comment is documentation, not hard-coding).

## Why are the API files (paths / types / methods) generated? What do I touch to add an endpoint?

- **Why it has to be generated**: the most common accident across the three sides is "the server changed a field and the other two forgot to follow". Hand-written API files have no constraint tying them to the documentation — once written, they each tell their own story. After switching to generated files, a signature mismatch **fails to compile** (`tsc` / `vite build` reports it right away), instead of surfacing as an `undefined` in production.
- **One direction only** (it flows one way; do not attempt two-way sync):

```
server/src (controller + DTO + decorators)   ← the only hand-written place
      │ cd server && npm run swagger:emit
      ▼
server/openapi.json (the contract, committed to the repo)
      │ node tools/gen-api.cjs      ← or one command: cd server && npm run gen:api
      ▼
client/assets/ui/utils/net/{ApiRoutes,ApiModels,Api}.ts
admin/src/api/{routes,models,endpoints}.ts
```

- **Standard steps to add an endpoint**: ① write the controller method and DTO on the server, and give the decorator an `operationId` (e.g. `role.save`) plus `@ApiDataResponse`; ② `cd server && npm run gen:api`; ③ fix the call sites on the two consumers as the compiler reports them.
- **How the generator knows what to emit**: the module segment of `operationId` decides the target file (`role` → client `RoleApi` / admin `rolesApi`); whether the path is `/admin/...` decides which side it belongs to (a mismatch throws instead of silently generating into the wrong place); `x-olua-audience` decides whether a token is required; `x-olua-data-schema` decides the type of `data`; `@ApiQueryModel(XxxQueryDto)` decides which named type the query parameters become.
- **Generated artifacts must never be hand-edited**: the first line says `@generated by tools/gen-api.cjs`. Hand edits get rolled back by the next regeneration, and `node tools/audit-api-generated.cjs` fails outright (byte-for-byte comparison + header marker + all 50 endpoints landing on methods + no dangling `import` types + paths appearing only in the path table + Cocos `.meta` files complete).
- **The hand-written files**: client side `HttpClient` (request implementation and shared dispatch), `ApiCodes` (business codes and text keys — things OpenAPI cannot express), `ApiError`, `Session`, `RoleSync`, `NetworkSetup`; admin side `config.ts`, `http.ts`, `types.ts` (enum dictionaries and facade types), `index.ts` (single entry point).
- How documentation grouping and permission annotations come about on the server: [server/FAQ.md](server/FAQ.md), "How is the API documentation grouped".

## An admin edits a character — when does the player see it?

- **While offline**: it takes effect the next time they enter the game — the character selection screen calls `POST /roles/:id/select` to fetch the latest complete data from the server and writes it into the local cache (`StorageManager.cacheServerRole`); everything in-game reads from there.
- **While online (the interesting case)**: the player pushes their save back to the server every 1.5 seconds. If what they hold predates the admin's edit, pushing it would **wipe the admin's change entirely**. So each character carries a **revision** number (incremented +1 on every write):
  - Every server write increments it (+1); an admin edit also increments it (+1).
  - The client sends "which version my data is based on"; a mismatch is rejected (`409` / business code **20006**).
  - On 20006 the client **neither retries nor overwrites**: it re-fetches the character detail and takes the server data as the new baseline (the admin's change wins, the player's last 1.5 seconds yield), then shows a toast "character data was modified on the server; synced to the latest".
  - After a successful push the new `revision` must be written back locally (`RoleSync.onSaved` → `StorageManager.applyServerRevision`); otherwise the next push uses the old version and collides with itself (permanent deadlock).
- **The character was deleted from the console**: server replies **20002**, client shows "the character has been deleted, please select another" → clears its local cache → returns to character selection (without this the player gets stuck in a game that can never sync again).
- **The character was kicked offline from the console**: server replies **20007**, client shows "your character has been taken offline by an administrator" → **clears only the local online flag, does not delete the character** → picking it again from character selection is enough.
  - ⚠️ 20002 and 20007 differ by one code but have opposite consequences: the former means "the character is gone" and the local cache must be dropped; the latter means "the character still exists, you just can't play it right now" and **must never be deleted**. Dedicated guards exist for this: `client/tools/test-role-delete.cjs` asserts "only the flag is cleared, the character stays", and `client/tools/test-client-net.cjs` asserts on a source slice that `deleteRole` must not appear in this handler. Mechanism details: [admin/FAQ.md](admin/FAQ.en.md), "What does kicking a player offline actually do".
- **Old saves stay compatible**: when the local cache has no `revision`, the field is simply not sent (the server falls back to the old "last writer wins" behaviour), and the next successful push adds it automatically — no need to wipe saves.

## Local save vs server data: which one wins?

**The server is authoritative; local storage is only a cache.** The specifics:

- The only way into the game: character selection calls the server for the complete character → `StorageManager.cacheServerRole(detail)` → writes it locally → enters the scene. **If the data is incomplete, the game does not enter the scene.**
- The only write path is `StorageManager.updateOnlineRole`, which is also **the single trigger for syncing** (debounced push to the server), so no gameplay system needs its own save request.
- Deleting a character requires the server-side `RoleApi.remove` to succeed before the local cache is cleared.
- But *what goes inside* character data is decided by client configs — the server does not know the game configs, it only validates structure. The split of responsibilities: [What does each side own?](#what-does-each-side-own-where-should-a-change-land).

Sync timing, failure handling and debounce details: [client/FAQ.md](client/FAQ.md), "How is character progress synced to the server".

## What are the generated artifacts on each side? What happens if I edit them by hand?

| Side | Artifacts | Generated by | Consequence of hand-editing |
| --- | --- | --- | --- |
| Client | `client/assets/ui/utils/net/ApiRoutes.ts` · `ApiModels.ts` · `Api.ts` | `server/openapi.json` + `tools/gen-api.cjs` | Rolled back by the next regeneration; `audit-api-generated` fails |
| Admin | `src/api/routes.ts` · `models.ts` · `endpoints.ts` | same as above | same as above |
| Server | `openapi.json` | `npm run swagger:emit` (from controllers / DTOs / decorators) | Overwritten by the next `swagger:emit`; both consumers stay on the stale contract |

There are also a few **gameplay config tables produced by generators** (not API artifacts, but artifacts nonetheless):

- `configs/monster.ts` ← `client/tools/gen-monster-config.cjs` (body sizes and offsets measured from asset `.meta` auto-trim data)
- `configs/monsterDrops.ts` ← `client/tools/gen-monster-drops.cjs` (drop tables)

Their rules are written in the header of each script — re-run the script instead of editing the output.

## How should regression be run? What must be green?

Before merging, at least these three categories must run (green means done). The repository root has a Makefile so one command covers it:

```bash
make verify   # = check (client tsc + admin typecheck + 7 audits) + builds on all three sides + all tests
```

Manual equivalent (no `make` needed):

```bash
# Client: 25 test suites (run inside client/; the scripts locate Cocos' bundled tsc themselves)
cd client && for t in tools/test-*.cjs; do node "$t" || exit 1; done

# Server: compile + five e2e suites (248 / 77 / 279 / 108 / 25) + generated-artifact consistency
cd server && npm run verify

# Admin: typecheck + build
cd admin && npm run build

# Project-level audits (run from the repository root)
node tools/audit-api-generated.cjs && node tools/audit-api-hardcode.cjs \
  && node tools/audit-config-leak.cjs && node tools/audit-ui-click-through.cjs \
  && node tools/audit-deploy.cjs
```

You may run only the suites relevant to your change, but **the server e2e suites and the seven audit scripts should all pass before every commit** — they watch for "silent failure" problems that unit tests cannot catch:

- `audit-api-generated`: are generated artifacts byte-for-byte identical to the documentation (guards against "changed the server, forgot to regenerate")
- `audit-api-hardcode`: were addresses written into code, or environment variables forgotten in `.env.example`
- `audit-config-leak`: have tunables leaked into core code, or text keys been left unregistered
- `audit-ui-click-through`: do UI clicks fall through to the world, and is press ownership wired up completely
- `audit-deploy`: do Docker / compose / nginx files line up with each other (service names / ports / volumes / reverse-proxy prefixes / secret isolation)

## Why does the test hang on "waiting for server startup" with no logs?

**Some terminals and IDEs inject `NODE_OPTIONS`** (usually adding a `--require` shim). The server is started as a child process, and after inheriting that variable it **prints nothing and listens on nothing** — it silently fails to start. The e2e run stops at "waiting for server startup", which looks like a port conflict or a code problem, but is neither.

Clear it and re-run:

```bash
env -u NODE_OPTIONS npm run dev
env -u NODE_OPTIONS npm run test:e2e
```

> Going through the repository-root Makefile needs no special handling: `NODE` / `NPM` there already carry `env -u NODE_OPTIONS`.
> To use the pristine environment instead: `make RUN_ENV= <target>`.

A related environment trap: `curl 127.0.0.1` on this machine can be hijacked by proxy environment variables and return 502 (a false failure) — add `--noproxy '*'`.

## AI changed a feature — how do I know it didn't quietly break something else?

This project's answer is **turning every pitfall into a script** rather than relying on memory:

1. **Invariants pushed down into pure functions + unit tests**: bag tidy / drag / recycle / discard rules are all pure functions (data in, data out, no UI or storage), so the real code can be asserted in node. The sandbox mechanism is described in [client/FAQ.md](client/FAQ.md), "How do unit tests run real Cocos code in node".
2. **Tunables pulled into configs**: changing a number should not touch code; `audit-config-leak` enforces this
3. **Generated artifacts + guards**: neither consumer writes API files by hand, so an incompatible signature explodes at compile time
4. **Negative assertions**: not only "the intended thing happened" but also "the forbidden thing did not". E.g. "`deleteRole` must not appear in the kick-offline handler", "the UI root must not register mouse events"
5. **One commit per problem solved**: a change lands in its own commit right after the feature is done, so "which change introduced this regression" can always be bisected — instead of piling everything up and committing it all at once
