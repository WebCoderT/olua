# FAQ · Admin

> [简体中文](FAQ.md) | English

> Starting the admin console (React), permission-driven visibility, how the pages are meant to be used, and the API layer.
>
> Cross-side mechanics (single source of truth for addresses / contract pipeline / how the three sides interact) live in [../FAQ.en.md](../FAQ.en.md);
> project overview, page list, environment variables and directory structure live in [README.en.md](README.en.md);
> the English editions of the client and server FAQs land in follow-up issues and will be linked here once available.

## Contents

- [How do I start the admin console? Where is the API address configured?](#how-do-i-start-the-admin-console-where-is-the-api-address-configured)
- [Why are buttons greyed out / why are admin menu items missing?](#why-are-buttons-greyed-out--why-are-admin-menu-items-missing)
- [Where do the list thumbnails come from? Why do some rows show "no image"?](#where-do-the-list-thumbnails-come-from-why-do-some-rows-show-no-image)
- [What happens if I type a URL for a page I have no permission for?](#what-happens-if-i-type-a-url-for-a-page-i-have-no-permission-for)
- [What is the difference between resetting a password and changing my own?](#what-is-the-difference-between-resetting-a-password-and-changing-my-own)
- [Why is "My Account" in the top-right corner instead of the left nav?](#why-is-my-account-in-the-top-right-corner-instead-of-the-left-nav)
- [What does kicking a player offline actually do? Why must the character be selected again?](#what-does-kicking-a-player-offline-actually-do-why-must-the-character-be-selected-again)
- [Why are there two sets of combat attributes on the detail page? Does a mismatch mean cheating?](#why-are-there-two-sets-of-combat-attributes-on-the-detail-page-does-a-mismatch-mean-cheating)
- [Can the admin keep its own table of equipment / class names?](#can-the-admin-keep-its-own-table-of-equipment--class-names)
- [Where do I change an equipment or title name?](#where-do-i-change-an-equipment-or-title-name)
- [Can the API files be edited by hand? What has to change to add an admin endpoint?](#can-the-api-files-be-edited-by-hand-what-has-to-change-to-add-an-admin-endpoint)
- [Where do the permission count and timestamps in the top bar come from?](#where-do-the-permission-count-and-timestamps-in-the-top-bar-come-from)
- [What usually causes a build failure or a type error?](#what-usually-causes-a-build-failure-or-a-type-error)

## Startup and build

### How do I start the admin console? Where is the API address configured?

- **Start**: `cd admin && npm install && cp .env.example .env.development && npm run dev` (port `5173` by default)
- **Build**: `npm run build` = `tsc --noEmit && vite build`, output in `dist/`. **Failing types fail the build** — deliberate: the API layer is generated, so an incompatible signature has to be caught at this gate and nowhere later
- **API address**: determined solely by `VITE_API_BASE_URL` in `admin/.env.development` (or `.env.production`); the code reads it in `src/api/config.ts`. Production may also use a relative `/api` behind a same-origin reverse proxy
- **Registration**: `ADMIN_REGISTER_CODE` must be set in `server/.env` (left empty = registration open), and the same code has to be entered when registering; the **first** admin to register automatically becomes the super administrator
- Self-check: `node ../tools/audit-api-hardcode.cjs` — it checks whether an address got hardcoded into the admin source, and whether every env key used is actually declared in `.env.example`

## Permissions

### Why are buttons greyed out / why are admin menu items missing?

- **Every piece of visibility comes from the permission points carried in the token** (`hasPermission` in `store/session`). Nav items carry a `permission` field (`Layout` filters before rendering), write buttons are `disabled`, and pages are wrapped by the `RequirePermission` shell in `App.tsx`. The sidebar nav is split into four collapsible groups by function, and **a group is hidden entirely when every child in it lacks the permission**
- **Interface visibility is only experience; the server is the authority**: guards re-evaluate on every request, so typing an address by hand gets nothing more than `403` + business code **30006**
- The single source of truth for permission points is on the **server** at `src/common/constants/permission.ts` (25 permission points / 3 roles). `PERMISSION` in the admin `src/api/types.ts` mirrors it, and the two must correspond one to one
- **The two mail blocks are gated differently**: `mail:read` is **not granted to the read-only observer** (delivery records expose player email addresses, which are personal data), while the announcements `announcement:read` is granted (announcements are public content aimed at the whole service). So an observer account legitimately lands with **one fewer admin nav item** — this is not a bug
- **Fallback for a dirty session**: when `permissions` is missing from the session (an old token, hand-edited localStorage), `hasPermission` treats it as an **empty array** — the result is **least privilege** (almost the whole admin menu disappears), never a silent grant
- After an admin is demoted, **reloading the page takes effect**: on entry `Layout` quietly calls `authApi.me()` once and writes the latest role and permission points back into the session

### Where do the list thumbnails come from? Why do some rows show "no image"?

- The thumbnail component lives in `components/GameImage.tsx`: single-image resources (the `icon` field) render via a plain `<img>`, while atlas animations (titles / souls / NPCs) parse the plist and draw the **first frame in document order** onto a canvas (both TexturePacker format 2 / 3 dialects are supported, with a module-level cache so each atlas is parsed once per screen).
- Image paths are always looked up from `game-data.generated.ts` (the `equipmentIcon`-style helpers in `api/gameData.ts`); the API rows for skills / statuses / fashions / titles / souls already carry `icon` / `animation`, and those row values are used directly — both paths read the **same configuration**, so no second dictionary exists.
- "No image" means the path is empty or the PNG could not be fetched: either the client asset has not been added yet (new config ahead of the art) or the id was added in the database later and is not in the generated snapshot yet. Adding the asset or re-running `node tools/gen-shared-data.cjs` fixes it; nothing else in the list is affected.
- The URL root is `/game-resources/`: the vite middleware reads `client/assets/resources` directly in dev, and in prod the admin nginx reverse-proxies to the game container — the same pipeline as the equipment alignment workbench, and because it is same-origin the canvas never gets tainted.
- **Thumbnails are clickable to zoom in**: clicking any cell opens a lightbox (larger view, closes with Esc or by clicking the backdrop). The atlas zoom is a large canvas **redrawn** from the same cached first frame — not the 40px thumbnail stretched — so pixel art stays sharp.

### What happens if I type a URL for a page I have no permission for?

No white screen. The `RequirePermission` shell renders an inline "no access" notice (`EmptyState`). But **whether it blocks matters little** — the real decision lives on the server, so even if the frontend let it through, the data request would still be rejected with `403`.

### Why is "My Account" in the top-right corner instead of the left nav?

Because it is **everyone's private page** (your own identity / login status / permission points, plus self-service password change) and **requires no permission point at all** — putting it in the left nav would mix it with "features you need permission to see", which is the wrong semantics. So `Layout` renders it as a button in the top identity bar, and the `/me` route hangs directly under `RequireAuth` without a `RequirePermission` wrapper. For the same reason every item in `NAV_TOP` / `NAV_GROUPS` (the top-level entries and the two-level groups) carries a `permission` except that one.

## Password management

### What is the difference between resetting a password and changing my own?

The two entries are deliberately separate because **the verification and the consequences are opposite**:

| | Resetting someone else | Changing your own |
| --- | --- | --- |
| Where | Account detail page / inline in the admin list | "My Account" in the top-right corner |
| Verification | No current password needed (permission point instead) | **Requires the current password** |
| Where the password comes from | Generated on the frontend, **shown once** | Typed by the admin |
| Old tokens | **All revoked**, the other side must log in again | The server **issues a new token**, the frontend overwrites the session |

- In the admin list, "reset password" is **disabled for your own row** (the `title` hint points you to "My Account") — taking the reset path would invalidate your own current token on the spot and bounce you straight back to the login page
- Mechanism details (how `token_version` invalidates old tokens, why the change and the version bump have to happen in one SQL statement): [../server/FAQ.md](../server/FAQ.en.md) (see "what happens if a player forgets the password, and why are they logged out after a reset")
- What the kicked player sees (`40103` forcing a re-login): [../client/FAQ.md](../client/FAQ.en.md)

### Where do the permission count and timestamps in the top bar come from?

- The top bar "N permissions" is the length of `admin.permissions` in the session, refreshed on entry by `authApi.me()`; after changing your own password and receiving a new token it refreshes immediately through the **session subscription** (`subscribeSession`) — no manual page reload
- Timestamps in tables go through `formatTime` / `formatTimeFull` in `src/api/types.ts` (local time); the audit-log time filter uses `<input type="datetime-local">`, converted to milliseconds by `localInputToMs` before being sent — **the server receives a millisecond timestamp** while the UI displays local time; do not mix the two up

## Operations

### Why are there two sets of combat attributes on the detail page? Does a mismatch mean cheating?

- **Left column, "server recompute"**: the server recomputes from the **saved** snapshot (level / equipment / war soul / title / rank). It is a derived field, not a stored column, so it is **recomputed on every detail read** — after you change that batch of fields in the console and save, this updates immediately and does not wait for the client's next sync
- **Right column, "client reported"**: the attribute values carried in the save. Since #541 the client no longer computes attributes itself — this column shows the gap between the reported values and the **server's authoritative recompute** (the server only compares **combat power and max health**: combat power is a weighted total that best represents how stale the reported values are). The six attack/defense ranges are in the snapshot too, but judging "do these agree" on them is far too noisy (saving between a level-up and a recompute would trip it), so the server does not compare them and this column does not show them — showing numbers nothing validates would suggest they had been checked
- **The "mismatch" banner**: it only means the two sides **disagree on the formula's output**, and it is **not proof of cheating** — saving between a level-up and a recompute, client config drift, or a stale equipment id left in the snapshot all trip it. The console **does not decide which side is right** (the server side is not automatically correct either: if the player saved between a level-up and a recompute, the client side is the stale one); it only makes the gap visible
- **"Equipment ids the server cannot resolve"**: tripped when the client deleted that piece of equipment, or the snapshot still holds an old id. The server skips that piece when it cannot find its attributes (matching the client's "unknown means not worn"), but says so — otherwise the attributes quietly come out short while everything looks fine
- The list page has **no** combat-power column, and that is deliberate: the list endpoint does not carry `derived` (recomputing per row would only bloat the response, and the list does not display it anyway)

### What does kicking a player offline actually do? Why must the character be selected again?

- **When the button is clickable**: "kick offline" on the account detail page needs the `account:status` permission, and only works while that account **has an online character** (`onlineRoleId` is non-empty); it is disabled otherwise
- **What the server does when clicked**: (1) clears the account's `online_role_id`; (2) adds a check on the save path — the character being pushed up must still be the account's current online character, otherwise `409` + business code **20007**. Doing only (1) stops nobody: the game is still running locally and will push the save up 1.5 seconds later anyway
- **What the player sees**: a floating tip "your character has been taken offline by an administrator" → **only the local online flag is cleared, the character is not deleted** → back to the character selection scene. Selecting the character once more (`POST /roles/:id/select` rewrites the online flag) resumes play
- ⚠️ 20007 (kicked offline) and 20002 (character deleted) have completely opposite consequences and the client handles them separately: only 20002 deletes the local cache. A dedicated guard covers this (`client/tools/test-client-net.cjs` asserts that `deleteRole` must not appear in this handler)
- Full mechanism write-up (why the check sits before the optimistic lock, what the side effects are): [../server/FAQ.md](../server/FAQ.en.md) (see "what does kicking a player offline actually do, why must the character be selected again"); the interaction timeline is in [../FAQ.en.md](../FAQ.en.md#an-admin-edits-a-character--when-does-the-player-see-it)

## Game data

### Can the admin keep its own table of equipment / class names?

**No, and the guard will stop you.** The names for equipment / War Soul / Title / Rank / skills / items / maps have one authoritative definition: the client's `client/assets/configs` (plus the enum comments in `client/assets/types/role.ts` — the "all classes" occupation code and the three gender names live only there). `src/api/gameData.ts` imports the artifact generated from them, `server/src/shared/game-data.generated.ts` — **the same file the server reads**.

Writing another dictionary in `admin/src` that shares a name with the artifact (say `SEX_LABELS = { … }`) makes `make audit-shared-data` fail with the file and line. `types.ts` used to hold a hand-copied class and gender table — the client could change and the admin would never know; that copy is gone.

### Where do I change an equipment or title name?

Edit the client config → run `node tools/gen-shared-data.cjs` from the repository root (= `make gen-shared-data`) → rebuild the admin.

Forgetting to regenerate will not slip through: `make audit-shared-data` reports "artifact is stale". The guard does not ask a human whether an update is needed — the source of truth is the client, and there is no other correct answer here.

## API layer

### Can the API files be edited by hand? What has to change to add an admin endpoint?

**No.** `src/api/{routes,models,endpoints}.ts` are generated — the first line says `@generated by tools/gen-api.cjs`. Hand edits get rolled back by the next `npm run gen:api`, and `node ../tools/audit-api-generated.cjs` compares them byte for byte and fails.

The standard steps to add an admin endpoint:

1. **Server side**: write the controller method plus its DTO, and give `operationId` and the permission points in `@ApiAdminDoc({ operationId, permissions: [Permission.X] })` (**omitting the permission points is a real grant**)
2. `cd server && npm run gen:api` — regenerates `openapi.json` and the API files on both consumers (the admin `endpoints.ts` gains the matching method)
3. On the admin side **add the permission constant in `src/api/types.ts`** (generated output carries no permission dictionary), then call the new method from the page as `adminApi.xxx()`
4. `npm run build` — a mismatched signature fails right here

**The handful of hand-written files** (all changes belong here): `config.ts` (address), `http.ts` (request layer), `types.ts` (business codes / permission points / Chinese dictionaries / time helpers), `index.ts` (single entry point). Pages import only from `index.ts`.

### What usually causes a build failure or a type error?

Ordered by frequency:

1. **A server API changed but `npm run gen:api` was not rerun** — the admin `models.ts` / `endpoints.ts` stay on the old contract and the call sites no longer match. This is intentional design: better a compile error than an `undefined` in production
2. **A new permission point or business code missing from `types.ts`** — the page references a constant that does not exist
3. **Unused imports** — `tsconfig` enables `noUnusedLocals`; delete them
4. **Markdown written inside JSX** — `**bold**` renders the asterisks literally in JSX text; write `<strong>…</strong>` instead

## Related documents

- [README.en.md](README.en.md) — admin overview, page list, environment variables, directory structure
- [../FAQ.en.md](../FAQ.en.md) — cross-side mechanics (single source of truth for addresses, contract pipeline, three-side interaction, environment gotchas)
- [../server/FAQ.md](../server/FAQ.en.md) — the server behind these endpoints: permissions, throttling, audit, passwords
- [../client/FAQ.md](../client/FAQ.en.md) — client questions
