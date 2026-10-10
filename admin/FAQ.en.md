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
- [What happens if I type a URL for a page I have no permission for?](#what-happens-if-i-type-a-url-for-a-page-i-have-no-permission-for)
- [What is the difference between resetting a password and changing my own?](#what-is-the-difference-between-resetting-a-password-and-changing-my-own)
- [Why is "My Account" in the top-right corner instead of the left nav?](#why-is-my-account-in-the-top-right-corner-instead-of-the-left-nav)
- [What does kicking a player offline actually do? Why must the character be selected again?](#what-does-kicking-a-player-offline-actually-do-why-must-the-character-be-selected-again)
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

- **Every piece of visibility comes from the permission points carried in the token** (`hasPermission` in `store/session`). Nav items carry a `permission` field (`Layout` filters before rendering), write buttons are `disabled`, and pages are wrapped by the `RequirePermission` shell in `App.tsx`
- **Interface visibility is only experience; the server is the authority**: guards re-evaluate on every request, so typing an address by hand gets nothing more than `403` + business code **30006**
- The single source of truth for permission points is on the **server** at `src/common/constants/permission.ts` (17 permission points / 3 roles). `PERMISSION` in the admin `src/api/types.ts` mirrors it, and the two must correspond one to one
- **The two mail blocks are gated differently**: `mail:read` is **not granted to the read-only observer** (delivery records expose player email addresses, which are personal data), while the announcements `announcement:read` is granted (announcements are public content aimed at the whole service). So an observer account legitimately lands with **one fewer admin nav item** — this is not a bug
- **Fallback for a dirty session**: when `permissions` is missing from the session (an old token, hand-edited localStorage), `hasPermission` treats it as an **empty array** — the result is **least privilege** (almost the whole admin menu disappears), never a silent grant
- After an admin is demoted, **reloading the page takes effect**: on entry `Layout` quietly calls `authApi.me()` once and writes the latest role and permission points back into the session

### What happens if I type a URL for a page I have no permission for?

No white screen. The `RequirePermission` shell renders an inline "no access" notice (`EmptyState`). But **whether it blocks matters little** — the real decision lives on the server, so even if the frontend let it through, the data request would still be rejected with `403`.

### Why is "My Account" in the top-right corner instead of the left nav?

Because it is **everyone's private page** (your own identity / login status / permission points, plus self-service password change) and **requires no permission point at all** — putting it in the left nav would mix it with "features you need permission to see", which is the wrong semantics. So `Layout` renders it as a button in the top identity bar, and the `/me` route hangs directly under `RequireAuth` without a `RequirePermission` wrapper. For the same reason every item in `NAV_ITEMS` carries a `permission` except that one.

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
- Mechanism details (how `token_version` invalidates old tokens, why the change and the version bump have to happen in one SQL statement): [../server/FAQ.md](../server/FAQ.md) (see "what happens if a player forgets the password, and why are they logged out after a reset")
- What the kicked player sees (`40103` forcing a re-login): [../client/FAQ.md](../client/FAQ.md)

### Where do the permission count and timestamps in the top bar come from?

- The top bar "N permissions" is the length of `admin.permissions` in the session, refreshed on entry by `authApi.me()`; after changing your own password and receiving a new token it refreshes immediately through the **session subscription** (`subscribeSession`) — no manual page reload
- Timestamps in tables go through `formatTime` / `formatTimeFull` in `src/api/types.ts` (local time); the audit-log time filter uses `<input type="datetime-local">`, converted to milliseconds by `localInputToMs` before being sent — **the server receives a millisecond timestamp** while the UI displays local time; do not mix the two up

## Operations

### What does kicking a player offline actually do? Why must the character be selected again?

- **When the button is clickable**: "kick offline" on the account detail page needs the `account:status` permission, and only works while that account **has an online character** (`onlineRoleId` is non-empty); it is disabled otherwise
- **What the server does when clicked**: (1) clears the account's `online_role_id`; (2) adds a check on the save path — the character being pushed up must still be the account's current online character, otherwise `409` + business code **20007**. Doing only (1) stops nobody: the game is still running locally and will push the save up 1.5 seconds later anyway
- **What the player sees**: a floating tip "your character has been taken offline by an administrator" → **only the local online flag is cleared, the character is not deleted** → back to the character selection scene. Selecting the character once more (`POST /roles/:id/select` rewrites the online flag) resumes play
- ⚠️ 20007 (kicked offline) and 20002 (character deleted) have completely opposite consequences and the client handles them separately: only 20002 deletes the local cache. A dedicated guard covers this (`client/tools/test-client-net.cjs` asserts that `deleteRole` must not appear in this handler)
- Full mechanism write-up (why the check sits before the optimistic lock, what the side effects are): [../server/FAQ.md](../server/FAQ.md) (see "what does kicking a player offline actually do, why must the character be selected again"); the interaction timeline is in [../FAQ.en.md](../FAQ.en.md#an-admin-edits-a-character--when-does-the-player-see-it)

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
- [../server/FAQ.md](../server/FAQ.md) — the server behind these endpoints: permissions, throttling, audit, passwords
- [../client/FAQ.md](../client/FAQ.md) — client questions
