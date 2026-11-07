# Commonroom

A multi-room live chat app built from `notes/AGENTS.md`. Nicknames, messages, rooms, and mention notifications persist. Presence, typing, and SSE connections live only in memory.

## Run locally

Requires **Node.js 24+** (uses the built-in SQLite driver) and pnpm for installing dependencies. You can use npm to run the scripts.

```sh
pnpm install --frozen-lockfile
npm run db:setup
npm run dev
```

Open **http://127.0.0.1:4321**. No environment variables or external services are required. SQLite is created at `data/commonroom.sqlite`. The setup command is idempotent; startup also creates the schema and seeds the System user and Lobby if needed. Keep `data/` to preserve the chat.

You can also run the scripts with `pnpm run …`. A pnpm lockfile is included.

### Windows and WSL

This checkout can be used from Windows and WSL. `pnpm-workspace.yaml` includes Windows and Linux x64/glibc in `supportedArchitectures`, so an install prepares native optional packages for both runtimes (including Rollup, esbuild, Tailwind and sharp).

If WSL reports `Cannot find module @rollup/rollup-linux-x64-gnu`, rerun the install from the same environment that originally installed dependencies. For this Windows-installed checkout, run this in **PowerShell** from the project folder:

```sh
pnpm install --frozen-lockfile
```

Then run `npm run dev` in WSL. Use pnpm consistently for dependency installation; running `npm run dev` is fine, but avoid alternating `npm install` and `pnpm install` in the same `node_modules`. Keep the lockfile. Running an install from a different environment may also use an incompatible pnpm store path. If a future dependency compiles a native addon during installation, use separate Windows and WSL checkouts instead of sharing its compiled output.

The `.env not found. Continuing without it.` message is informational. `.env` is optional for local SQLite development.

## How it works

- Astro SSR with the standalone Node adapter, Drizzle ORM, Tailwind CSS, HTMX for joining, Alpine for the nickname preview, and a JSON SSE protocol for live chat.
- POST sends; EventSource receives and reconnects automatically. Reconnects reload missed history from the database, even across a restart. Frames use proper `data:` prefixes and a heartbeat every 30 seconds.
- Presence counts unique users per room across multiple tabs. A disconnected user's presence expires after 60 seconds. Reconnecting before then cancels departure. Explicit exit removes the user immediately. Typing expires after 2 seconds.
- A 32-character random `chat_user_id` is the browser's bearer identity, stored only in an httpOnly, SameSite cookie for 30 days. Server routes derive the actor from it. No password recovery or nickname reclamation is provided; exiting clears the cookie, and that nickname stays reserved.
- Nicknames use 2–24 ASCII letters, numbers, underscores or hyphens and are unique without regard to case. `System` and `everyone` are reserved.
- `@nickname` notifies that user even if offline. `@everyone` notifies all registered users except System and the sender. Repeated mentions create only one notification per recipient per message. Notifications are visible only to their recipient and remain until marked read.
- Chat content renders as text with highlighted mentions. Sounds default off; enable them with the speaker button. Sound and light/dark preferences persist in localStorage. Browsers may require a user gesture before audio plays.
- History loads in batches of 50 with a timestamp + ID cursor to avoid losing messages sharing a timestamp. Messages group by author within five minutes. Scrolling stays put when reading older messages; a new-message button returns to the bottom.
- The room directory has a separate live stream that receives room counts and new rooms without joining a room. On mobile, `/rooms` is the main navigation page.
- Origin checks, input limits, and basic in-memory rate limits apply to mutations. Nickname-only identity is intended for casual shared spaces: anyone who joins can read all rooms. There are no private rooms or moderation tools.

## Production

```sh
npm run check
npm run build
npm start
```

Run **one long-lived Node process** on Railway, Fly.io, Render, or a VPS. This implementation was built locally; it has not been deployed. Cloudflare Sites/serverless deployment does not fit its in-process presence and event bus.

Set variables in the host environment or copy `.env.example` to `.env` (Astro dev loads `.env`; the setup and production commands load it with Node):

| Variable | Purpose |
| --- | --- |
| `DATABASE_FILE` | SQLite path, defaults to `./data/commonroom.sqlite`. Mount a persistent volume when using SQLite. |
| `DATABASE_URL` | Optional PostgreSQL connection URL; takes precedence over SQLite. Schema and queries use the PostgreSQL Drizzle adapter automatically. |
| `APP_ORIGIN` | Exact public origin, e.g. `https://chat.example.com`, used to validate mutating requests. |
| `HOST` | Bind address for production, usually `0.0.0.0`. |
| `PORT` | Production port, defaults to `4321`. |

Use HTTPS in production so the cookie is secure. Ensure your proxy forwards the original scheme, disables buffering and caching for SSE, and allows connections longer than 30 seconds. Astro origin protection stays enabled. If relying on forwarded host headers, add only your known host to `security.allowedDomains` in `astro.config.mjs`.

PostgreSQL support is implemented but requires testing against your own instance. SQLite → PostgreSQL data transfer is not automatic. For multiple app processes, replace the in-memory event/presence layer with shared pub/sub or a hosted real-time service. Restarting the process clears live state while retaining saved records.

## Verification

```sh
npm run check
npm run build
npm test
```

The tests start the production build on port **4328** with a fresh database under ignored `test-results/`. They cover two independent cookie sessions, live message delivery, room isolation, typing expiry, mention persistence and access, nickname validation, cookie identity, CSRF rejection, pagination with timestamp ties, refresh, the actual 60-second departure grace, 30-second heartbeat, and a real process restart. The suite takes about 70 seconds. Keep port 4328 free.

For a visual two-window check, use separate browser profiles (or `127.0.0.1` and `localhost` as separate cookie hosts): join as Alice and Bob, send each other messages, type `@` and use arrow keys + Tab/Enter, switch rooms, refresh, then restart the server. Confirm reconnection and history, and test a narrow phone viewport. The server tests verify the transport; browser rendering, keyboard behavior, sound and responsive layout also need browser checks.
