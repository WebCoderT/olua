# admin · Admin console (React)

> [简体中文](README.md) | English

> Operations backend covering six areas: accounts / characters / admins / announcements / mails / audit logs. The interface shows and hides by **permission point**, and the server validates independently.
>
> Project overview: [../README.en.md](../README.en.md); admin questions: [FAQ.en.md](FAQ.en.md);
> root cross-side FAQ: [../FAQ.en.md](../FAQ.en.md). The English editions of the client and server documents land in follow-up issues and will be linked here once available.

## Tech stack

- **React 19** + **TypeScript** + **Vite**
- **Tailwind CSS v4** (the `@tailwindcss/vite` plugin, no `tailwind.config.js`, the theme lives in `src/index.css`)
- **react-router-dom v7** (routing doubles as the permission shell, see below)
- The API layer **does not hand-write paths or types**: `src/api/{routes,models,endpoints}.ts` are generated from the server's `openapi.json`

## Requirements

- **Node.js 20+** (matching what Vite / React 19 require)
- The server must be running first (`http://localhost:3100` by default)

## Quick start

```bash
cd admin
npm install
cp .env.example .env.development   # first run: the API root address lives here (VITE_API_BASE_URL)
npm run dev                        # development (port 5173); npm run build produces dist/
```

- Registration requires `ADMIN_REGISTER_CODE` in `server/.env` (left empty = registration open); enter the same registration code when signing up
- The **first** admin to register automatically becomes the super administrator (all permissions); everyone after that is a regular admin and needs to be promoted by a super administrator on the "admins" page

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server (Vite, hot reload) |
| `npm run build` | **Typecheck + build** (`tsc --noEmit && vite build`, output in `dist/`) |
| `npm run preview` | Preview the built output |
| `npm run typecheck` | Typecheck only (no output emitted) |

> The repository-root `make` targets are shortcuts for these scripts: `make admin-dev` / `make admin-build` /
> `make admin-typecheck`; `make dev` can also bring up the server and the admin console together. `make help` lists everything.

## Environment variables

All of them live in `admin/.env.development` (development) and `.env.production` (production); see `.env.example` for the template.
No API address literal is allowed in the code — `node ../tools/audit-api-hardcode.cjs` checks that "every key in use is declared in `.env.example`".

| Variable | Default | Notes |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:3100/api` | **Single source of truth for the API address** (`src/api/config.ts` is its only reader) |
| `VITE_API_TIMEOUT` | `15000` | Request timeout (milliseconds) |
| `VITE_APP_TITLE` | — | Page title (top bar and browser tab). The default shipped in `.env.example` is written in Chinese; override it here for an English deployment |

## Directory structure

```
admin/
├── src/
│   ├── main.tsx                    entry (mounts App + global styles)
│   ├── App.tsx                     route table + two global wirings (forced re-login / error toast)
│   ├── index.css                   Tailwind entry + theme variables
│   ├── api/
│   │   ├── config.ts               ← the only reader of the API address / timeout / title
│   │   ├── http.ts                 request layer: interceptors / timeout / envelope unwrap / error normalization / 401 → login
│   │   ├── routes.ts               ⚠️ generated: endpoint path table
│   │   ├── models.ts               ⚠️ generated: endpoint types (mirror of the server DTOs)
│   │   ├── endpoints.ts            ⚠️ generated: endpoint methods (accountsApi/adminsApi/announcementsApi/mailsApi/auditApi/authApi/rolesApi/statsApi/systemApi)
│   │   ├── types.ts                hand-written: business codes / permission points / Chinese dictionaries for actions and targets / time helpers
│   │   └── index.ts                single entry point (pages import only from here)
│   ├── pages/                      pages (see the table below)
│   ├── components/                 Layout / Pagination / ConfirmDialog / ResetPasswordDialog / BanDialog / BanStatus / AnnouncementDialog / sortable / charts / ToastHost / ui
│   └── store/
│       ├── session.ts              token and admin read/write (subscription mechanism + hasPermission)
│       └── toast.ts                global toasts (success / failure)
├── index.html
└── .env.example · vite.config.ts · tsconfig.json · package.json
```

## Pages

| Page | Route | Permission point required | What it does |
| --- | --- | --- | --- |
| Login / register | `/login` · `/register` | none (public) | Admin login; registration (the first registrant becomes super administrator) |
| Overview | `/` | `stats:read` | Account / character totals at a glance |
| Accounts | `/accounts` | `account:read` | Paginated search (fuzzy account name + status), ban / unban, delete account |
| Account detail | `/accounts/:id` | `account:read` | Characters owned, **reset a player password**, **kick offline**, wipe every character on the account |
| Characters | `/roles` | `role:read` | Six filters (keyword / online status / class / gender / level range / account), multi-select batch delete |
| Character detail | `/roles/:id` | `role:read` | Edit basic info and common values; **structured editing of equipment / skills / bag** (the client config is the single source of truth for those lists) |
| Admins | `/admins` | `admin:read` | Admin list; change role / enable-disable / **reset password** / delete (writes additionally need `admin:manage`) |
| Announcements | `/announcements` | `announcement:read` | Publish / edit / delete announcements, enable-disable, filter by keyword / level / enabled / effective status; **"effective" uses the server-returned `active` column** (same criterion as the player-facing fetch endpoint, not local clock) (writes additionally need `announcement:write`) |
| Mails | `/mails` | `mail:read` | **Send** (pick template → fill variables → enqueue) + **delivery records** (status / keyword filter + pagination + sorting). Delivery is **asynchronous**, so "pending / retrying" intermediate states exist and refresh automatically; only attempt count and failure reason are visible (writes additionally need `mail:write`) |
| Audit logs | `/audit-logs` | `audit:read` | 7 filters (keyword / action / target type / result / start-end time / target id) + pagination + expand to see the request body |
| My account | `/me` | **no permission point** | Own identity / login status / permission points; **self-service password change** (requires the current password) |

Write actions disable their button per permission point (`disabled`) and show "insufficient permission" above the table; typing an address in by hand hits the `RequirePermission` shell, which renders "no access" in place instead of a white screen.

## Permission model

Interface visibility **is only experience**; **the server is the authority**.

- The single source of truth for permission points is on the **server** (`server/src/common/constants/permission.ts`, 17 permission points / 3 roles); `PERMISSION` in the admin `src/api/types.ts` mirrors it one to one
- Admin info comes down with the token in the response and lands in `store/session`; `hasPermission(point)` looks it up in that array directly
- **Fallback for a dirty session**: a missing `admin.permissions` is treated as an **empty array** (least privilege) — an incomplete session never opens up the interface
- Nav items carry a `permission` field and `Layout` filters before rendering; the `RequirePermission` shell in `App.tsx` guards direct route access
- **When adding an admin endpoint**: the server needs `@ApiAdminDoc({ permissions: [Permission.X] })` (omitting it is a real grant), then the admin side adds the permission constant in `types.ts` (generated output carries no permission dictionary)

## The two password entries (do not mix them up)

| Entry | Where | Verification | Result |
| --- | --- | --- | --- |
| **Reset someone else** | Account detail page / inline in the admin list | No current password needed (permission point instead) | Password generated on the frontend, **shown exactly once**; **all** tokens previously issued to that admin are **revoked**, so they must log in again |
| **Change your own** | "My account" page | **Requires the current password** | The server **issues a new token** and the frontend overwrites the local session — otherwise the change would kick you back to the login page immediately |

In the admin list, "reset password" is disabled for your own row (the hint points you to "My account"). `ResetPasswordDialog` is a two-stage dialog: confirm first, then the password is **shown once** and can be copied.

## Related documents

- [FAQ.en.md](FAQ.en.md) — startup, permissions, page usage and the API layer
- [../FAQ.en.md](../FAQ.en.md) — cross-side mechanics (single source of truth for addresses, contract pipeline, three-side interaction, environment gotchas)
- [../README.en.md](../README.en.md) — project overview, three-side index, directory structure
- [../server/README.md](../server/README.md) — the server behind these endpoints
