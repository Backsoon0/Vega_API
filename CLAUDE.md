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

This project uses **npm workspaces**. The root `package.json` manages the Worker (`wrangler`, `vitest`, `hono`) and `admin-ui/` workspace (SvelteKit). A single `npm install` at root installs everything.

## Architecture

Vega API is a Cloudflare Worker (Hono + TypeScript) that aggregates Google Vertex AI, Google AI Studio, and OpenAI into a single OpenAI-compatible API. Model routing is automatic: `google/*`/`gemini/*` → Vertex/AI Studio, `gpt-*`/`o1-*`/`o3-*` → OpenAI.

All providers use OpenAI-compatible endpoints — the Worker is a pass-through proxy with auth header management. No format conversion is needed.

```
Request flow:
  Client → Worker (vega-api) at /v1/chat/completions (OpenAI format)
    ├── AI Studio → generativelanguage.googleapis.com/v1beta/openai (pass-through)
    ├── Vertex AI → aiplatform.googleapis.com/v1/.../endpoints/openapi (pass-through)
    └── OpenAI    → api.openai.com/v1 (pass-through)

  Non-chat routes (/v1/models, /v1/embeddings, etc.):
    └── Provider-specific proxy (pass-through)
```

**Entry point:** [src/index.ts](src/index.ts) — Hono app with all routes, exported as `export default { async fetch(request, env, ctx) {} }`.

**Worker source files:**

| File | Role |
|------|------|
| [src/index.ts](src/index.ts) | Hono app entry: route dispatch, model routing/aggregation, client auth, all /admin/* and /v1/* routes |
| [src/types.ts](src/types.ts) | Shared TypeScript interfaces (Provider, Model, Env, ProviderHandler) |
| [src/db.ts](src/db.ts) | D1 schema initialization (run once per cold start) |
| [src/config.ts](src/config.ts) | D1-backed config CRUD for providers, admin password, client API key (AES-GCM encrypted sensitive fields) |
| [src/crypto.ts](src/crypto.ts) | AES-256-GCM + SHA-256 (Web Crypto API, zero deps) |
| [src/rate-limit.ts](src/rate-limit.ts) | D1-backed login rate limiter (5 failures → 15 min ban, 5-min sliding window) |
| [src/usage.ts](src/usage.ts) | D1 usage tracking: daily aggregates + call_logs detail with 10000-row retention |
| [src/providers/vertex.ts](src/providers/vertex.ts) | Vertex AI: JWT RS256 (service account) + API Key auth modes, OpenAI-compatible pass-through |
| [src/providers/ai-studio.ts](src/providers/ai-studio.ts) | AI Studio: API Key auth via Bearer token, OpenAI-compatible pass-through |
| [src/providers/openai.ts](src/providers/openai.ts) | OpenAI: Bearer token, configurable base URL, pass-through proxy |
| [test/index.spec.js](test/index.spec.js) | Integration tests (`cloudflare:test` Vitest pool) |

**Admin frontend (SvelteKit SPA) — Code Dark theme with sidebar navigation:**

| File | Role |
|------|------|
| [admin-ui/src/app.css](admin-ui/src/app.css) | Design tokens (`@theme`), Google Fonts, keyframe animations, base styles |
| [admin-ui/src/app.html](admin-ui/src/app.html) | HTML shell: SVG favicon, font preconnect, `theme-color` meta |
| [admin-ui/src/lib/api.ts](admin-ui/src/lib/api.ts) | API client for `/admin/*` endpoints |
| [admin-ui/src/lib/sidebar-state.ts](admin-ui/src/lib/sidebar-state.ts) | Svelte writable store for sidebar collapsed state (persisted to localStorage) |
| [admin-ui/src/lib/Sidebar.svelte](admin-ui/src/lib/Sidebar.svelte) | Collapsible sidebar navigation (4 pages, mobile overlay drawer) |
| [admin-ui/src/lib/CallLogTable.svelte](admin-ui/src/lib/CallLogTable.svelte) | Call log table with search/filter, desktop table + mobile card layout |
| [admin-ui/src/lib/Modal.svelte](admin-ui/src/lib/Modal.svelte) | Generic modal with Svelte transition animations (fly + fade) |
| [admin-ui/src/lib/Toast.svelte](admin-ui/src/lib/Toast.svelte) | Toast notifications (event-driven) |
| [admin-ui/src/lib/ProviderCard.svelte](admin-ui/src/lib/ProviderCard.svelte) | Provider card: always-visible actions on mobile, hover-reveal on desktop |
| [admin-ui/src/lib/ProviderForm.svelte](admin-ui/src/lib/ProviderForm.svelte) | Add/edit provider form. Vertex AI: auth mode toggle (service account + JSON import / API key) |
| [admin-ui/src/lib/ClientKeySection.svelte](admin-ui/src/lib/ClientKeySection.svelte) | Client API key management (generate, custom, reveal, copy, delete) |
| [admin-ui/src/routes/+layout.svelte](admin-ui/src/routes/+layout.svelte) | Auth guard + sidebar shell (desktop: fixed sidebar, mobile: overlay drawer) |
| [admin-ui/src/routes/+page.svelte](admin-ui/src/routes/+page.svelte) | Login page (password show/hide toggle) |
| [admin-ui/src/routes/dashboard/+page.svelte](admin-ui/src/routes/dashboard/+page.svelte) | Overview: stat cards + provider status |
| [admin-ui/src/routes/dashboard/logs/+page.svelte](admin-ui/src/routes/dashboard/logs/+page.svelte) | Call records: D1-backed log table with search + provider filter |
| [admin-ui/src/routes/dashboard/api-settings/+page.svelte](admin-ui/src/routes/dashboard/api-settings/+page.svelte) | API settings: provider CRUD + client API key |
| [admin-ui/src/routes/dashboard/panel-settings/+page.svelte](admin-ui/src/routes/dashboard/panel-settings/+page.svelte) | Panel settings: change admin password |

## Provider Interface Contract

Every provider module must export (TypeScript):

```ts
export async function proxyRequest(request: Request, env: Env, provider: Provider, suffix: string): Promise<Response>
// suffix: URL path after /v1 (e.g. "/chat/completions")

export async function fetchModelList(env: Env, config: Record<string, string>): Promise<Model[]>
// Returns: Array<{ id, object: "model", created, owned_by }>
```

## D1 Data Model

Database: `vega-api-db` (binding: `DB`)

| Table | Key fields | Purpose |
|-------|-----------|---------|
| `config` | `key TEXT PK, value TEXT` | admin_password hash, client_api_key (encrypted), config_version, rate limit entries |
| `providers` | `id TEXT PK, type, name, enabled, config, models, weight` | AI provider configuration |
| `usage_daily` | `date, provider_id, model (unique)` | Per-model daily aggregate usage (calls, prompt_tokens, completion_tokens) |
| `call_logs` | `id AUTOINCREMENT, timestamp, ip, provider_id, model, ...` | Detailed request log (max 10000 rows, auto-cleanup) |

Sensitive fields (`apiKey`, `privateKey`) in `providers.config` stored `enc:` prefixed (AES-256-GCM). Edit without changing preserves existing encrypted value.

**Provider config shapes (config field inside provider record):**

| Type | Config fields |
|------|--------------|
| `vertex_ai` (JWT) | `projectId`, `location`, `serviceAccountEmail`, `privateKey` |
| `vertex_ai` (API Key) | `projectId`, `location`, `apiKey` |
| `google_ai_studio` | `apiKey` |
| `openai` | `apiKey`, `baseUrl` (optional) |

Vertex AI auto-detects auth mode: if `config.apiKey` is present → API Key mode; if `config.serviceAccountEmail` + `config.privateKey` → JWT mode.

## Deployment Config

[wrangler.jsonc](wrangler.jsonc) configures:
- `main` → `src/index.ts` (TypeScript entry)
- `d1_databases` → `vega-api-db` (binding: `DB`)
- `assets.directory` → `./admin-ui/build/` (SvelteKit build output)
- `assets.not_found_handling` → `"single-page-application"` (SPA fallback)
- `assets.run_worker_first` → `["/admin/*", "/v1/*", "/health"]` (API routes bypass assets)
- `compatibility_flags` → `["nodejs_compat"]`

## Migrations

D1 migrations live in `migrations/`:
- `0001_init.sql` — Core tables (config, providers, usage_daily)
- `0002_call_logs.sql` — Persistent call log storage

Apply: `npm run db:migrate` (remote) or `npm run db:migrate:local`

## Key Constraints

- **No DOM API in tests.** Test environment is `workerd`. Use `cloudflare:test` imports.
- **ENCRYPTION_KEY required.** `.dev.vars` with `ENCRYPTION_KEY=<64 hex chars>`. Generate: `openssl rand -hex 32`.
- **SvelteKit build must exist.** Run `npm run build:ui` before `npm run deploy` or `npm test`.
- **`nodejs_compat` flag** enabled in wrangler.jsonc.
- **Tab indentation**, LF line endings (`.editorconfig` / `.prettierrc`).
- **No Svelte runes in `.ts` files.** `$state`, `$effect`, etc. only work in `.svelte` files. Regular `.ts` files use Svelte stores (`writable`) or plain variables.
- **`$derived` with Svelte stores.** Use `$state` + `$effect` instead of `$derived` when tracking `$page` store changes — `$derived` doesn't reliably auto-subscribe to Svelte 4 stores.
- **Single-line SQL.** D1 `exec()` requires single-line SQL statements; multi-line template literals with `split(';')` cause parse errors.
- **`class:` directive on components.** Svelte 5 doesn't support `class:` directive on components (e.g., Lucide icons). Use string interpolation: `class={...}`.

## Security

- API keys: AES-256-GCM encrypted; key in Worker Secret (`ENCRYPTION_KEY`)
- Admin auth: SHA-256 password hash → Bearer token = hash itself
- Rate limiting: 5 failures per 5-min window → 15-min IP ban (D1-backed)
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
