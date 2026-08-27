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

1. Push this repo to GitHub and **import** it into Vercel (Framework Preset: *Other*).
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
   - builds the admin UI (`npm run build:ui`), serves `admin-ui/build` as static assets,
   - deploys `api/index.ts` as a single **Node** serverless function (Vercel auto-detects
     the `@vercel/node` runtime; no manual `functions.runtime` pin needed),
   - rewrites the API routes (`/v1/*`, `/v1beta/*`, `/anthropic/*`, `/admin/*`, `/health`)
     to the function, and falls back to `index.html` for SPA client routes.

   > If you need a longer function duration for long streaming responses, set
   > `maxDuration` in *Vercel → Project → Settings → Functions* (or re-add a
   > `functions` entry with a valid runtime string).

### Notes

- The Neon schema is created on first cold start by `prepareRuntime` (tables use
  Postgres `SERIAL`, `IF NOT EXISTS`). No manual migration needed on Vercel.
- Runtime SQL differences (SQLite D1 → Postgres) are translated by the Neon
  adapter in `api/neon.ts` (`?` → `$n`, `INSERT OR REPLACE` → `ON CONFLICT ...`,
  `julianday()` → `EXTRACT(EPOCH ...) / 86400`).
- Usage `recordUsage` is fire-and-forget via a `waitUntil` shim (Vercel has no
  `waitUntil`), so call logging may be slightly less reliable than on Cloudflare.
- After cloning, run `npm install` once in a normal shell so `@neondatabase/serverless`
  is added to `package-lock.json` (this sandbox/npm cache can block a full install).
  Vercel's default `npm install` reconciles the lockfile automatically.
- You can keep both deployments in the same repo: Cloudflare uses `src/index.ts`
  (D1), Vercel uses `api/index.ts` (Neon). The `PGURL`/`DATABASE_URL` env var toggles the
  database engine, and the admin **设置 → 部署与数据库** card shows the detected
  platform + database.
