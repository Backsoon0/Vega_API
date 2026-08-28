# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Local Worker dev server (wrangler dev)
npm test             # Run Worker tests (vitest, requires .dev.vars with ENCRYPTION_KEY)
npm run deploy       # Build frontend + deploy Worker + static assets to Cloudflare
npm run build:ui     # Build SvelteKit admin frontend (admin-ui/)
npm run dev:ui       # Run SvelteKit dev server for frontend work
npm run db:migrate   # Apply D1 migrations to remote database
npm run db:migrate:local  # Apply D1 migrations to local database
```

**Dual package-manager workspace.** The repo is simultaneously an npm and a pnpm
workspace: root `package.json` (`workspaces: ["admin-ui"]`) + `package-lock.json`
for npm, and `pnpm-workspace.yaml` + `pnpm-lock.yaml` for pnpm; both lockfiles are
committed. A single `npm install` **or** `pnpm install` at root installs
everything. Vercel builds with **pnpm** (`vercel.json` → `pnpm install
--no-frozen-lockfile`); the Cloudflare GitHub Action and most local dev use
**npm**. Keep both lockfiles consistent when changing dependencies.

## Architecture

Vega API is one **shared Hono application (`src/app.ts`)** that runs on **two
platforms** with a D1-shaped database client (`env.DB`:

`prepare().bind().all()/.first()/.run()`, see `src/types.ts`):

| Platform | Runtime | Database | Entry point |
|----------|---------|----------|-------------|
| Cloudflare Workers | Worker (`wrangler`) | **D1** (`binding: DB`) | `src/index.ts` |
| Vercel | Node Serverless (`@vercel/node`) | **Neon** (Postgres) | `api/index.ts` |

`api/neon.ts` wraps `@neondatabase/serverless` in a D1-compatible client and
translates SQLite/D1 SQL to Postgres (`?` → `$n`, `INSERT OR REPLACE` →
`ON CONFLICT`, `julianday()` → `EXTRACT(EPOCH …)/86400`). Schema DDL is
per-engine in `src/db.ts` (`D1_SCHEMA_STATEMENTS` vs `NEON_SCHEMA_STATEMENTS`);
runtime queries are shared. Platform/database detection (`src/runtime.ts`) reads
Waline-style env vars (`DATABASE`/`DATABASE_PROVIDER`, `PGURL`/`DATABASE_URL`/
`POSTGRES_URL`, `DEPLOYMENT_PLATFORM`). Never branch `env.DB` code on platform.

**Three API interfaces:**
- `/v1/*` — OpenAI-compatible endpoints (chat completions, models)
- `/v1beta/*` — Native Google Gemini API (models, :generateContent, :streamGenerateContent)
- `/anthropic/*` — Native Anthropic Messages API (/v1/messages)

**Supported provider types:**
- `openai` — OpenAI / compatible (via **direct fetch passthrough**, NOT the AI SDK)
- `google_ai_studio` — Google AI Studio (direct passthrough or AI SDK, see below)
- `vertex_ai` — Google Vertex AI JWT/API Key (direct passthrough or AI SDK)
- `anthropic` — Anthropic Messages API (via `@ai-sdk/anthropic`)

### Chat routing (current — this has drifted from the old "AI SDK only" design)

| Provider / case | Path |
|-----------------|------|
| `openai` | **Direct fetch + SSE passthrough** (`handleOpenAIDirectStream`) — raw upstream proxy, no AI SDK. Chosen for low CPU on the Cloudflare free tier. |
| `google_ai_studio` / `vertex_ai`, no tool-call history | **Direct passthrough** via Google's OpenAI-compat endpoint (`generativelanguage.googleapis.com/v1beta/openai`) or Vertex OpenAI-compat endpoint. |
| `google_ai_studio` / `vertex_ai`, replaying tool calls | **AI SDK native path** (`@ai-sdk/google`) so Gemini 3 `thought_signature` replay works — unless `VEGA_GOOGLE_TOOL_MODE=direct`. |
| `anthropic` | **AI SDK** `streamText`/`generateText` (`@ai-sdk/anthropic`). |
| Admin playground | AI SDK (`src/routes/admin/playground.ts`). |

The `VEGA_GOOGLE_TOOL_MODE` env var (see `src/google-tool-mode.ts`) switches the
Google tool-replay path: `"ai-sdk"` (default; correct for Gemini 3 + tools,
higher CPU) or `"direct"` (lighter, Gemini 2.5 works, Gemini 3 rejected).

**Legacy providers** (`src/providers/*.ts`) are used **only** for
`fetchModelList()` in model aggregation — never route chat through them.

Request flow (simplified):

```
Client → /v1/chat/completions (OpenAI format)
  → router.findProviderForModel() → ProviderMatch
  → openai type / google no-tools → direct passthrough (OpenAI-compat upstream)
  → anthropic → createModelFromProvider() → LanguageModel → streamText()/generateText()
  → convert fullStream → OpenAI SSE format → Client

Client → /v1beta/models/:model:generateContent (Gemini format)
  → same dispatch → Gemini JSON format → Client

Client → /anthropic/v1/messages (Anthropic format)
  → anthropicToAISDK() → streamText()/generateText() → Anthropic SSE → Client
```

**Entry points:** Cloudflare `src/index.ts` (default export `{ fetch }`);
Vercel `api/index.ts` (web `Request`/`Response` or Node `(req, res)` handling).
Both call `prepareRuntime(env)` (idempotent one-time schema init + circuit-breaker
config load) then `app.fetch(request, env, ctx)`.

### Backend source files

| File | Role |
|------|------|
| [src/app.ts](src/app.ts) | **Shared Hono app** used by both runtimes: middleware, route mounting, SPA fallback |
| [src/index.ts](src/index.ts) | Cloudflare Worker entry: `prepareRuntime` + `app.fetch` |
| [api/index.ts](api/index.ts) | **Vercel entry**: builds `env` from `process.env` (Neon), bridges web/Node requests, `waitUntil` shim |
| [api/neon.ts](api/neon.ts) | **Neon adapter**: D1-compatible client + SQLite→Postgres SQL translation |
| [src/types.ts](src/types.ts) | Shared interfaces: Provider, Model, Env, DBClient/DBPrepared/DBResult |
| [src/runtime.ts](src/runtime.ts) | Platform/database detection for both runtimes (env-var only) |
| [src/db.ts](src/db.ts) | Schema init: **D1 SQLite and Neon Postgres branches** (IF NOT EXISTS) |
| [src/config.ts](src/config.ts) | Config CRUD: `config_version`, `admin_password`, client key, failover, circuit breaker, log retention (AES-GCM for secrets) |
| [src/crypto.ts](src/crypto.ts) | AES-256-GCM + SHA-256 + API-key hashing (Web Crypto API) |
| [src/request-util.ts](src/request-util.ts) | `getClientIp`: CF-Connecting-IP (Cloudflare) / x-forwarded-for, x-real-ip (Vercel) |
| [src/rate-limit.ts](src/rate-limit.ts) | DB-backed login rate limiter (5 failures / 5 min → 15-min ban) |
| [src/usage.ts](src/usage.ts) | Usage tracking: daily aggregates + call_logs (retention configurable, default 10000) |
| [src/circuit-breaker.ts](src/circuit-breaker.ts) | Provider circuit breaker (threshold/cooldown from config, in-memory state) |
| [src/upstream-errors.ts](src/upstream-errors.ts) | Upstream error normalization (JSON-safe bodies) |
| [src/google-tool-mode.ts](src/google-tool-mode.ts) | `VEGA_GOOGLE_TOOL_MODE` decision for Google tool replay |
| [src/ai-providers.ts](src/ai-providers.ts) | AI SDK provider factory (`google_ai_studio` / `vertex_ai` / `anthropic`). Vertex JWT token management + base-URL fallback |
| [src/router.ts](src/router.ts) | Model routing: provider cache, model aggregation, model→provider matching, failover |
| [src/providers/*.ts](src/providers/) | (Legacy) pass-through providers — kept for `fetchModelList()` |
| [src/middleware/auth.ts](src/middleware/auth.ts) | Client auth middleware (multi-key match, key-name injection) + admin auth |
| [src/routes/v1/chat.ts](src/routes/v1/chat.ts) | OpenAI-format chat: direct passthrough **and** AI SDK paths |
| [src/routes/v1/models.ts](src/routes/v1/models.ts) | OpenAI-format model listing |
| [src/routes/v1beta/chat.ts](src/routes/v1beta/chat.ts) | Gemini-native chat: :generateContent/:streamGenerateContent |
| [src/routes/v1beta/models.ts](src/routes/v1beta/models.ts) | Gemini-native model listing |
| [src/routes/anthropic/messages.ts](src/routes/anthropic/messages.ts) | Anthropic-native Messages API (SSE streaming) |
| [src/routes/admin/auth.ts](src/routes/admin/auth.ts) | Admin auth (setup, login, check, change-password) |
| [src/routes/admin/providers.ts](src/routes/admin/providers.ts) | Provider CRUD (supports all 4 types) |
| [src/routes/admin/client-key.ts](src/routes/admin/client-key.ts) | Client API key management (multi-key + legacy migration + per-key quota `calls`/`tokens`/`period`) |
| [src/routes/admin/usage.ts](src/routes/admin/usage.ts) | Usage stats, call logs, settings (failover/circuit-breaker/retention), `GET /admin/usage/report?days=` usage-report series for ECharts |
| [src/routes/admin/playground.ts](src/routes/admin/playground.ts) | Model playground (AI SDK streamText/generateText) |
| [src/routes/admin/routes.ts](src/routes/admin/routes.ts) | Route-topology statistics (per-route usage/errors, chart data) |
| [test/index.spec.js](test/index.spec.js) | Integration tests (`cloudflare:test` Vitest pool) |

### AI SDK Version Lock

> **Current**: `ai@7.x` + `@ai-sdk/google@4.x` + `@ai-sdk/anthropic@4.x`
> (factory returns v3-generation `LanguageModel` instances). `@ai-sdk/openai` is
> declared but currently unused (OpenAI goes through the direct passthrough).

**Do not upgrade** `ai` or any `@ai-sdk/*` package independently — the pinned set
is mutually compatible; mixing major generations breaks typing at build time.

### Admin frontend (SvelteKit SPA) — Code Dark theme, 6 sidebar pages

| File | Role |
|------|------|
| [admin-ui/src/app.css](admin-ui/src/app.css) | Design tokens (`@theme`), Google Fonts, keyframe animations, base styles |
| [admin-ui/src/app.html](admin-ui/src/app.html) | HTML shell: SVG favicon, font preconnect, `theme-color` meta |
| [admin-ui/src/lib/api.ts](admin-ui/src/lib/api.ts) | API client for `/admin/*` endpoints |
| [admin-ui/src/lib/sidebar-state.ts](admin-ui/src/lib/sidebar-state.ts) | Svelte writable store for sidebar collapsed state (localStorage) |
| [admin-ui/src/lib/Sidebar.svelte](admin-ui/src/lib/Sidebar.svelte) | Collapsible sidebar navigation (6 pages, mobile overlay drawer) |
| [admin-ui/src/lib/route-topology.ts](admin-ui/src/lib/route-topology.ts) / [route-stats.ts](admin-ui/src/lib/route-stats.ts) | Route-topology chart data + helpers |
| [admin-ui/src/lib/EChart.svelte](admin-ui/src/lib/EChart.svelte) / [chart-theme.ts](admin-ui/src/lib/chart-theme.ts) | Apache ECharts wrapper (tree-shaken `echarts/core`, SVGRenderer, ResizeObserver) + Code Dark chart theme reading CSS vars |
| [admin-ui/src/lib/CallLogTable.svelte](admin-ui/src/lib/CallLogTable.svelte) | Call log table with search/filter, desktop table + mobile cards |
| [admin-ui/src/lib/LogDetailModal.svelte](admin-ui/src/lib/LogDetailModal.svelte) | Call-log detail modal (tokens, cache, errors, request id) |
| [admin-ui/src/lib/ProviderCard.svelte](admin-ui/src/lib/ProviderCard.svelte) | Provider card: always-visible actions on mobile, hover-reveal on desktop |
| [admin-ui/src/lib/ProviderForm.svelte](admin-ui/src/lib/ProviderForm.svelte) | Add/edit provider form. Vertex AI: auth mode toggle (JWT/JSON import / API key) |
| [admin-ui/src/lib/ApiKeyList.svelte](admin-ui/src/lib/ApiKeyList.svelte) | Client API key management (create, name, rename, delete, reveal, per-key quota editor) |
| [admin-ui/src/lib/Markdown.svelte](admin-ui/src/lib/Markdown.svelte) | Markdown + KaTeX rendering (playground output) |
| other lib components | `Alert.svelte`, `CustomSelect.svelte`, `Modal.svelte`, `Spinner.svelte`, `Toast.svelte`, `toast-store.ts`, `utils.ts` |
| [admin-ui/src/routes/+layout.svelte](admin-ui/src/routes/+layout.svelte) | Auth guard + sidebar shell |
| [admin-ui/src/routes/+page.svelte](admin-ui/src/routes/+page.svelte) | Login page (password show/hide toggle) |
| [admin-ui/src/routes/dashboard/+page.svelte](admin-ui/src/routes/dashboard/+page.svelte) | Overview: KPI cards + 用量报表 (ECharts line by day, bars by model/key, CSV export) + provider status |
| [admin-ui/src/routes/dashboard/playground/+page.svelte](admin-ui/src/routes/dashboard/playground/+page.svelte) | 模型调试: model playground |
| [admin-ui/src/routes/dashboard/routes/+page.svelte](admin-ui/src/routes/dashboard/routes/+page.svelte) | 路由拓扑: per-route statistics + ECharts bar/latency charts |
| [admin-ui/src/routes/dashboard/logs/+page.svelte](admin-ui/src/routes/dashboard/logs/+page.svelte) | 调用记录: DB-backed log table + search + provider filter + clear |
| [admin-ui/src/routes/dashboard/api-settings/+page.svelte](admin-ui/src/routes/dashboard/api-settings/+page.svelte) | API 设置: endpoint copy + provider CRUD + client API keys (with per-key quota editor) |
| [admin-ui/src/routes/dashboard/settings/+page.svelte](admin-ui/src/routes/dashboard/settings/+page.svelte) | 设置: failover, circuit breaker, log retention, column prefs, password, 部署与数据库 |

## AI SDK Provider Layer

[src/ai-providers.ts](src/ai-providers.ts) creates AI SDK `LanguageModel`
instances from DB `Provider` records (used for Anthropic, Google tool replay,
and the playground):

```ts
export function createModelFromProvider(provider: Provider, env: Env, modelId: string): LanguageModel
//   - google_ai_studio: createGoogleGenerativeAI({ apiKey })(modelId)
//   - vertex_ai: createGoogleGenerativeAI({ baseURL, fetch: jwtInjector }) — incl. Vertex base-URL fallback
//   - anthropic:       createAnthropic({ apiKey })(modelId)
//   - openai:          NOT handled here — direct passthrough in the route layer
```

**Legacy providers** ([src/providers/*.ts](src/providers/)) are used only for
`fetchModelList()` (model aggregation).

## Data Model

Cloudflare D1 (`vega-api-db`, binding `DB`) and Vercel Neon share the same
table/column layout (Postgres uses `SERIAL` for auto-increment ids).

| Table | Key fields | Purpose |
|-------|-----------|---------|
| `config` | `key TEXT PK, value TEXT` | config_version, admin_password hash, client api key (encrypted), failover_enabled, circuit_breaker_threshold/cooldown_seconds, log_retention_limit, rate-limit entries |
| `providers` | `id TEXT PK, type, name, enabled, config, models, weight` | AI provider configuration (4 types) |
| `usage_daily` | `date, provider_id, model (unique), calls, prompt_tokens, completion_tokens` | Per-model daily aggregate usage |
| `call_logs` | `id, timestamp, ip, provider_id, model, prompt/completion_tokens, duration_ms, success, request_id, is_stream, extra, cache_read/creation_input_tokens, api_key_name` | Detailed request log (retention configurable, default 10000 rows) |
| `api_keys` | `id, name, key_hash UNIQUE, encrypted_key, created_at, last_used_at, quota_calls, quota_tokens, quota_period` | Multi-key client API keys (SHA-256 hash for fast match); `quota_calls`/`quota_tokens` `NULL` = unlimited, `quota_period` `'day'` (default) or `'month'` |
| `key_usage_daily` | `key_name, date (unique), calls, prompt_tokens, completion_tokens` | Per-key daily usage, upserted by `recordUsage`; drives quota checks + `/admin/usage/report` by-key series. **Keyed by key name** (not id): duplicate names share quota; renaming orphans old-name stats |
| `rate_limits` | `key PK, attempts, reset_at, banned_until` | Login rate limiting |

Quota enforcement: `clientAuthMiddleware` (after auth) → `checkKeyQuota` →
`429 insufficient_quota` + `Retry-After` (86400 day / 2592000 month) +
`x-should-retry: false`. Legacy/env/public keys (no api_keys record) are never
quota-limited.

Sensitive fields (`apiKey`, `privateKey`) in `providers.config` are `enc:`
prefixed (AES-256-GCM). Editing without changing a field preserves the encrypted
value — check for `enc:` before re-encrypting.

**Provider config shapes (inside provider record):**

| Type | Config fields |
|------|--------------|
| `vertex_ai` (JWT) | `projectId`, `location`, `serviceAccountEmail`, `privateKey` |
| `vertex_ai` (API Key) | `projectId`, `location`, `apiKey` |
| `google_ai_studio` | `apiKey` |
| `openai` | `apiKey`, `baseUrl` (optional) |
| `anthropic` | `apiKey` |

Vertex AI auth mode auto-detects: `config.apiKey` → API Key mode;
`serviceAccountEmail` + `privateKey` → JWT mode.

## Deployment Config

**Cloudflare** — [wrangler.jsonc](wrangler.jsonc):
- `main` → `src/index.ts`
- `d1_databases` → `vega-api-db` (binding `DB`)
- `assets.directory` → `./admin-ui/build/`; `not_found_handling` → SPA;
  `run_worker_first` → `/admin/*`, `/v1/*`, `/v1beta/*`, `/anthropic/*`, `/health`
- `compatibility_flags` → `["nodejs_compat"]`

**Vercel** — [vercel.json](vercel.json):
- `framework: null` — forces the "Other" preset (avoids SvelteKit mis-detection)
- `functions."api/index.ts".maxDuration: 60` — SSE streams outlive the 10 s default; 60 s is the max Hobby accepts (out-of-range fails the build; raise it for Pro/Fluid)
- build: `pnpm --filter vega-api-admin run build` → copies `admin-ui/build` → `public/`
- rewrites: API paths → `/api`; SPA fallback → `/index.html`

## Migrations

D1 migrations in `migrations/` (0001–0009):
`0001_init`, `0002_call_logs`, `0003_duration`, `0004_rate_limits_banned_until`,
`0005_call_logs_enhance`, `0006_provider_types` (adds `'anthropic'` CHECK),
`0007_api_keys`, `0008_call_logs_enhance` (cache tokens + key name),
`0009_api_key_quota` (api_keys quota columns + `key_usage_daily`).

**Both platforms self-heal at cold start — migrations are optional.** Every
request path calls `prepareRuntime` → `initSchema` (`src/db.ts`), which creates
missing tables/indexes (`IF NOT EXISTS`) and adds missing columns on both
engines: Neon via Postgres `ADD COLUMN IF NOT EXISTS`, D1 via a
`PRAGMA table_info()` existence check before each ALTER (SQLite lacks
`IF NOT EXISTS` for ALTER). So a fresh database or an old one with new columns
syncs automatically on first request — `npm run db:migrate` (remote) /
`db:migrate:local` exist only as the manual/ready-made fallback and for local
dev seeding.

## Key Constraints

- **No DOM API in tests.** Test environment is `workerd`. Use `cloudflare:test` imports.
- **ENCRYPTION_KEY required.** `.dev.vars` with `ENCRYPTION_KEY=<64 hex chars>`. Generate: `openssl rand -hex 32`.
- **SvelteKit build must exist.** Run `npm run build:ui` before `npm run deploy` or `npm test`.
- **`nodejs_compat` flag** enabled in wrangler.jsonc.
- **Tab indentation**, LF line endings (`.editorconfig` / `.prettierrc`).
- **No Svelte runes in `.ts` files.** `$state`, `$effect`, etc. only work in `.svelte` files. Regular `.ts` files use Svelte stores (`writable`) or plain variables.
- **`$derived` with Svelte stores.** Use `$state` + `$effect` instead of `$derived` when tracking `$page` store changes — `$derived` doesn't reliably auto-subscribe to Svelte 4 stores.
- **Single-line SQL.** D1 `exec()` requires single-line SQL statements; multi-line template literals with `split(';')` cause parse errors.
- **Neon SQL parity.** Every SQL change in `src/db.ts` must be mirrored in the Neon statement list; runtime SQL must survive the `api/neon.ts` translation (`?`, `INSERT OR REPLACE`, `julianday`).
- **`class:` directive on components.** Svelte 5 doesn't support `class:` directive on components (e.g., Lucide icons). Use string interpolation: `class={...}`.
- **Vercel env parity.** `ENCRYPTION_KEY` must be identical on both platforms. Vercel needs a Neon connection string (`PGURL`/`DATABASE_URL`/...); Cloudflare must NOT set one (D1 auto-detect).

## Security

- API keys: AES-256-GCM encrypted; key in platform secret (`ENCRYPTION_KEY`)
- Admin auth: SHA-256 password hash → Bearer token = hash itself
- Rate limiting: 5 failures per 5-min window → 15-min IP ban (DB-backed, both engines)
- Sensitive fields never echoed in edit forms

## Design System — Code Dark

Admin UI uses a dark OLED theme with semantic color tokens defined via Tailwind CSS v4 `@theme` directive in [admin-ui/src/app.css](admin-ui/src/app.css).

**Color tokens (use as Tailwind utilities):**

| Token | Hex | Utility |
|-------|-----|---------|
| `background` | `#0F172A` | `bg-background` |
| `surface` | `#1B2336` | `bg-surface` |
| `surface-elevated` | `#1E293B` | `bg-surface-elevated` |
| `surface-hover` | `#243044` | `bg-surface-hover` |
| `input` | `rgba(15,23,42,0.8)` | `bg-input` |
| `primary` (text) | `#F8FAFC` | `text-primary` |
| `secondary` | `#CBD5E1` | `text-secondary` |
| `muted` | `#64748B` | `text-muted` |
| `placeholder` | `#475569` | `text-placeholder` |
| `accent` (green) | `#22C55E` | `text-accent`, `bg-accent` |
| `accent-subtle` | `rgba(34,197,94,0.10)` | `bg-accent-subtle` |
| `cta` (blue) | `#3B82F6` | `text-cta`, `bg-cta` |
| `cta-subtle` | `rgba(59,130,246,0.10)` | `bg-cta-subtle` |
| `danger` | `#EF4444` | `text-danger`, `bg-danger` |
| `danger-subtle` | `rgba(239,68,68,0.10)` | `bg-danger-subtle` |
| `warning` | `#F59E0B` | `text-warning` |
| `warning-subtle` | `rgba(245,158,11,0.10)` | `bg-warning-subtle` |
| `success` | `#22C55E` | `text-success`, `bg-success` |
| `success-subtle` | `rgba(34,197,94,0.10)` | `bg-success-subtle` |

**Provider badge tokens:** `vertex` / `vertex-subtle` (indigo), `studio` / `studio-subtle` (teal), `openai` / `openai-subtle` (amber).

**Fonts:** JetBrains Mono (`font-mono`) for headings/code/IDs; IBM Plex Sans (`font-sans`) for body/labels.

**Shadows:** `shadow-card`, `shadow-card-hover`, `shadow-modal`, `shadow-glow-cta`, `shadow-glow-accent`.

**Animations:** `animate-toast-in`, `animate-toast-out`, `animate-fade-in` (registered in `@theme`).

**Borders:** Use Tailwind opacity modifiers: `border-white/[0.06]`, `border-white/[0.08]`, `border-white/[0.10]`, `border-white/[0.14]`.

**Focus ring:** Global `*:focus-visible` style with `outline: 2px solid var(--color-cta)`.

**Responsive breakpoints:** `sm:640px` (tablet), `lg:1024px` (desktop). Mobile-first: stacks vertically, full-width cards, always-visible action buttons. Desktop: `max-w-6xl` centered, sidebar (collapsible 64px/240px).

**Reduced motion:** `prefers-reduced-motion: reduce` disables all animations/transitions globally.

## Vercel Deployment Notes

See [DEPLOYMENT.md](DEPLOYMENT.md) for full setup. Key points:

- Framework Preset must behave as "Other" — now enforced by `"framework": null`
  in `vercel.json`, no manual dashboard setting required.
- `maxDuration: 60` is set in `vercel.json` `functions` — long streaming
  responses won't be cut off at the 10 s default (an out-of-range value fails
  the build: Hobby max is 60 s; Pro supports 300 s+ by default and up to
  30 min with Fluid compute — raise the value if you're on Pro/Enterprise).
- Neon schema auto-creates on first cold start; usage/call-log writes are
  fire-and-forget on Vercel (no `waitUntil` — the shim in `api/index.ts`
  mirrors Cloudflare semantics; consider `@vercel/functions` `after()` if log
  reliability matters).
- Vercel functions have a ~4.5 MB request-body limit (Cloudflare allows more) —
  the app's own 5 MB cap is effectively 4.5 MB on Vercel.