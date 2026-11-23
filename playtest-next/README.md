# PlayTest AI — Next.js

The whole of PlayTest AI in **one Next.js 16 app**: the dashboard and the API that controls your devices, emulators,
test runs, SDK, Flutter tools and reports. It replaces the two old apps in this repo:

| Before | Now |
|---|---|
| `backend/` — Fastify API on port 8000 | `src/server/` — same engine, served by one Next.js Route Handler at `/api/v1/*` |
| `dashboard/` — Vite + React SPA on port 5173 (hash URLs like `#devices`) | `src/app/` + `src/dashboard/` — App Router pages with real URLs (`/devices`, `/reports/<id>`) |
| two processes (`concurrently`) | one process: `npm run dev` or `npm run build && npm start` |

Everything works as before (same API paths, same data, same features). The old folders are untouched, so you can
go back at any time.

## Run it

```bash
npm install
npm run dev          # http://127.0.0.1:4300 — hot reload while you change code
# or, faster day to day:
npm run build
npm start            # http://127.0.0.1:4300
```

Needs Node.js 22.13+ (it uses the built-in `node:sqlite`) and the Android SDK, like before.

### Without VS Code (starts with Windows)

```powershell
npm run autostart:install   # log-on task + Desktop/Start Menu shortcuts "PlayTest AI" and "Stop PlayTest AI"
npm run autostart:remove    # undo
npm run start:bg            # start in the background now (builds first if the code changed) and open the browser
npm run stop                # stop the background server
```

The log-on task runs `scripts/windows/start-playtest.ps1` 30 s after you sign in: no window, your normal user rights,
production mode. It rebuilds automatically when the code changed since the last build. Logs: `logs/playtest.log`
(server), `logs/launcher.log` (starts/stops), `logs/build.log`.

A Docker container is not used on purpose: on Windows it could not start your emulators (WHPX), see USB phones, or
measure your PC's RAM — PlayTest needs to run on the PC itself.

The server only listens on **127.0.0.1**. The API can install apps, run shell commands on devices and start
emulators, so it must not be reachable from your network. It also refuses write requests from other websites.

## Settings and data

- **`.env`** — same settings as `backend/.env` (copied over). `PORT`/`HOST` are not used any more: the port is set in
  `package.json` (`-p 4300`). Settings changed in the dashboard (AVD folder, RAM saver…) are written here.
- **`playtest_ai.db`** and **`storage/`** — your device profiles, test runs, bugs, APKs, screenshots and logs. They
  were copied from `backend/`, and the file paths stored in the database were moved to this folder.

To take a fresh copy of the old backend's data later (stop both apps first):

```bash
node scripts/import-from-backend.mjs --force       # replace this app's data with backend/'s
node scripts/import-from-backend.mjs --paths-only  # only fix stored file paths
```

## How it is put together

```
src/
  app/                      Next.js App Router
    layout.tsx              root layout: fonts, theme (no flash), providers, dashboard shell
    system/ dev/ devices/ apks/ campaigns/ live/ bugs/ reports/[[...id]]/ play/ ai/   one page.tsx per screen
    api/v1/[...path]/route.ts   the whole API — hands every request to src/server/router.ts
  instrumentation.ts        starts the background services when the server starts
  dashboard/                the UI (Chakra UI v3 + TanStack Query), moved from dashboard/src
    Shell.tsx               sidebar, header, live connection — was App.tsx
    pages/                  one component per screen (Developer, Device Manager, Test runs …)
  server/                   the engine, moved from backend/src
    router.ts               registers all ~130 routes, tracks device use (RAM saver)
    http.ts                 small Fastify-compatible layer on web Request/Response (routes, JSON, uploads, SSE)
    boot.ts                 one-time start-up (migrations, recovery) + background loops — was main.ts
    api/                    route modules (unchanged apart from imports)
    automation/ services/   adb, emulators, SDK, test runner, Flutter, RAM saver, reports …
```

Notes for changing the code:

- **Pages render in the browser.** The dashboard depends on live device data and local settings, so the shell shows a
  short loading screen on the server and renders the UI in the browser (as the Vite app did). Each `page.tsx` is a
  small Server Component that sets the tab title and `instant = false` (nothing to validate for instant navigation).
- **Cache Components are on** (Next.js 16 default). Pages you leave stay mounted but hidden, so coming back keeps
  their state; their polling and live streams pause while hidden.
- **Long-lived state lives on `globalThis`** (`src/server/core/keep.ts`): running emulators, test runs, SDK jobs,
  Flutter sessions, the event bus. `next dev` reloads server modules when you edit them; this keeps emulators
  stoppable and test runs going across those reloads. Background loops restart with the new code by themselves.
- Read `node_modules/next/dist/docs/` before using Next.js APIs — this version differs from older ones (see `AGENTS.md`).

## Known follow-ups

- `npm audit` reports zod 3 (memory use on oversized arrays, GHSA-mrhx-c7xc-m3w5). Bodies are capped at 1 MB and the
  API only listens on 127.0.0.1, so the exposure is small; moving to zod 4 needs a few schema changes.
- When you are happy with this app, the old `backend/` and `dashboard/` folders and the root `npm run dev` can go.
