# Deployment

Vega API runs the **same Hono application** on two platforms:

| Platform | Runtime | Database | Entry point |
|----------|---------|----------|-------------|
| Cloudflare Workers | Worker (`wrangler`) | **D1** (`binding: DB`) | `src/index.ts` |
| Vercel | Node Serverless (`@vercel/node` runtime) | **Neon** (Postgres) | `api/index.ts` |

The shared Hono app lives in `src/app.ts`. Both entries call `prepareRuntime(env)`
(one-time schema init + circuit-breaker config load) then `app.fetch(request, env, ctx)`.
Cloudflare's `wrangler.jsonc` **still points `main` to `src/index.ts`**, so the Cloudflare
deployment is unchanged. Vercel only compiles `api/index.ts` (+ its imports).

The database engine is chosen automatically (names follow the [Waline database guide](https://waline.js.org/guide/database.html)):

- `PGURL` / `DATABASE_URL` / `POSTGRES_URL` / libpq `PG*` set → **Neon** (Postgres); otherwise → **D1**.
- Override with `DATABASE=postgres|neon|pg|d1|sqlite` (or the `DATABASE_PROVIDER` alias).

The control panel **设置 → 部署与数据库** card shows the detected deployment
platform and database engine (and the Neon host when applicable).

---

## Cloudflare Workers (unchanged)

```bash
npm run db:migrate         # apply D1 migrations to the remote DB
npm run deploy             # build UI + deploy Worker + static assets
```

- `.dev.vars` must contain `ENCRYPTION_KEY=<64 hex chars>` for local dev/tests.
- No `vercel.json` / `api/` involvement.

## Vercel + Neon

1. Push this repo to GitHub and **import** it into Vercel.
   The repo's `vercel.json` sets `"framework": null`, which forces the **Other**
   preset — Vercel never auto-detects SvelteKit (which would otherwise build
   `admin-ui/src` as a server app and fail with `No entrypoint found in output
   directory`). No manual dashboard setting is needed; if you still see that
   error, confirm *Project → Settings → General → Framework Preset → Other*.
   With *Other*, Vercel serves `public/` as static and `api/index.ts` as one
   function.
2. In *Vercel → Project → Settings → Environment Variables*, add the database config
   (names follow the [Waline database guide](https://waline.js.org/guide/database.html)):
   - Engine selector: `DATABASE=postgres` (Waline-style; `neon`/`pg` are also accepted).
   - Connection string — **one of**:
     - `PGURL` — the **Neon** Postgres connection string (Waline-style). Easiest: add the
       **Vercel Neon integration** (it auto-creates a Neon project and injects `DATABASE_URL`),
       or copy the connection string from the Neon dashboard and use either name.
     - `DATABASE_URL` / `POSTGRES_URL` — aliases accepted too.
     - or libpq split vars: `PGHOST` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` / `PGPORT`.
   - `ENCRYPTION_KEY` — the **same** 64-char hex key used on Cloudflare
     (so existing encrypted provider credentials keep working).
   - Optional: `OPENAI_API_KEY`, `VEGA_GOOGLE_TOOL_MODE`, `DEPLOYMENT_PLATFORM`.
3. Deploy. `vercel.json`:
   - builds the admin UI via `pnpm --filter vega-api-admin run build` (pnpm resolves `vite`
     correctly for the workspace package; the repo's npm-based `build:ui` script is left
     untouched for the Cloudflare workflow),
   - serves `admin-ui/build` as Vercel's `public/` static output (the `buildCommand` copies
     `admin-ui/build` → `public/`; Vercel serves `public/` statically alongside `api/` functions),
   - deploys `api/index.ts` as a single **Node** serverless function (Vercel auto-detects
     the `@vercel/node` runtime; no manual `functions.runtime` pin needed),
   - rewrites the API routes (`/v1/*`, `/v1beta/*`, `/anthropic/*`, `/admin/*`, `/health`)
     to the function, and falls back to `index.html` for SPA client routes.

   > Function duration is raised to **60 s** via
   > `functions."api/index.ts".maxDuration` in `vercel.json` — long SSE streams
   > must not hit the 10 s default. 60 s is the maximum the **Hobby** plan
   > accepts (an out-of-range value fails the build), and it is also valid on
   > every other plan (Pro supports more — up to 300 s+ by default, and up to
   > 30 min with Fluid compute). If you are on Pro/Enterprise and want longer
   > streams, raise this value.

### Notes

- The Neon schema is created on first cold start by `prepareRuntime` (tables use
  Postgres `SERIAL`, `IF NOT EXISTS`). No manual migration needed on Vercel.
- Runtime SQL differences (SQLite D1 → Postgres) are translated by the Neon
  adapter in `api/neon.ts` (`?` → `$n`, `INSERT OR REPLACE` → `ON CONFLICT ...`,
  `julianday()` → `EXTRACT(EPOCH ...) / 86400`).
- Usage `recordUsage` is fire-and-forget on Vercel (there is no `waitUntil`; the
  shim in `api/index.ts` still starts the promise, but Vercel may freeze the
  function once the response completes, so call logs can occasionally lag). If
  call-log reliability matters, wrap the write in Vercel's `after()` from
  `@vercel/functions` — it runs after the response is sent and survives the
  function deadline.
- **Package manager:** the repo is an npm **and** pnpm workspace
  (`package.json` `workspaces` + `pnpm-workspace.yaml`; both lockfiles
  committed). Vercel builds with pnpm (`installCommand: pnpm install
  --no-frozen-lockfile` reconciles a stale pnpm lockfile at build time); the
  Cloudflare GitHub Action uses npm. Note that `package-lock.json` currently
  lacks `@neondatabase/serverless` (added for Vercel only) — run `npm install`
  once locally to re-sync it if you prefer npm.
- **Region:** keep the function close to your Neon database — pin
  `"regions": [...]` under the `api/index.ts` entry in `vercel.json` (default
  `iad1`; check the Neon console for your DB region). Correctness is unaffected,
  latency is not.
- **Request body limit:** Vercel Node functions cap request bodies at ~4.5 MB
  (Cloudflare allows more), so the app's own 5 MB limit is effectively 4.5 MB on
  Vercel — very large multimodal payloads may need to be downsized there.
- You can keep both deployments in the same repo: Cloudflare uses `src/index.ts`
  (D1), Vercel uses `api/index.ts` (Neon). The `PGURL`/`DATABASE_URL` env var toggles the
  database engine, and the admin **设置 → 部署与数据库** card shows the detected
  platform + database.
