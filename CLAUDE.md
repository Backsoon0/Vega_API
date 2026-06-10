# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev         # Local Worker dev server (wrangler dev)
npm test            # Run Worker tests (vitest, requires .dev.vars with ENCRYPTION_KEY)
npm run deploy      # Deploy Worker + static assets to Cloudflare (wrangler deploy)
npm run build:ui    # Build SvelteKit admin frontend (admin-ui/)
npm run dev:ui      # Run SvelteKit dev server for frontend work
```

This project uses **npm workspaces**. The root `package.json` manages the Worker (`wrangler`, `vitest`) and `admin-ui/` workspace (SvelteKit). A single `npm install` at root installs everything.

## Architecture

Vega API is a Cloudflare Worker that aggregates Google Vertex AI, Google AI Studio, and OpenAI into a single OpenAI-compatible API. Model routing is automatic: `google/*`/`gemini/*` → Vertex/AI Studio, `gpt-*`/`o1-*`/`o3-*` → OpenAI.

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

**Entry point:** [src/index.js](src/index.js) — `export default { async fetch(request, env) {} }`. Not an agents-sdk Agent.

**Worker source files:**

| File | Role |
|------|------|
| [src/index.js](src/index.js) | Route dispatch, model routing/aggregation, client auth, ASSETS fallback for SPA |
| [src/admin.js](src/admin.js) | `/admin/*` routes: provider CRUD, password, client key management |
| [src/config.js](src/config.js) | KV-backed config CRUD with AES-GCM encrypted sensitive fields |
| [src/crypto.js](src/crypto.js) | AES-256-GCM + SHA-256 (Web Crypto API, zero deps) |
| [src/fail2ban.js](src/fail2ban.js) | Login rate limiting (5 failures → 15 min ban, 5-min sliding window) |
| [src/providers/vertex.js](src/providers/vertex.js) | Vertex AI: JWT RS256 (service account) + API Key auth modes, OpenAI-compatible pass-through |
| [src/providers/ai-studio.js](src/providers/ai-studio.js) | AI Studio: API Key auth via Bearer token, OpenAI-compatible pass-through |
| [src/providers/openai.js](src/providers/openai.js) | OpenAI: Bearer token, configurable base URL, pass-through proxy |
| [test/index.spec.js](test/index.spec.js) | Integration tests (`cloudflare:test` Vitest pool) |

**Admin frontend (SvelteKit SPA) — Code Dark theme:**

| File | Role |
|------|------|
| [admin-ui/src/app.css](admin-ui/src/app.css) | Design tokens (`@theme`), Google Fonts, keyframe animations, base styles |
| [admin-ui/src/app.html](admin-ui/src/app.html) | HTML shell: SVG favicon, font preconnect, `theme-color` meta |
| [admin-ui/src/lib/api.ts](admin-ui/src/lib/api.ts) | API client for `/admin/*` endpoints |
| [admin-ui/src/routes/+layout.svelte](admin-ui/src/routes/+layout.svelte) | Auth guard + loading skeleton |
| [admin-ui/src/routes/+page.svelte](admin-ui/src/routes/+page.svelte) | Login page (password show/hide toggle) |
| [admin-ui/src/routes/dashboard/+page.svelte](admin-ui/src/routes/dashboard/+page.svelte) | Main dashboard (skeleton loading, empty state, responsive) |
| [admin-ui/src/lib/Modal.svelte](admin-ui/src/lib/Modal.svelte) | Generic modal with Svelte transition animations (fly + fade) |
| [admin-ui/src/lib/Toast.svelte](admin-ui/src/lib/Toast.svelte) | Toast notifications (event-driven + direct `trigger()` export) |
| [admin-ui/src/lib/ProviderCard.svelte](admin-ui/src/lib/ProviderCard.svelte) | Provider card: always-visible actions on mobile, hover-reveal on desktop |
| [admin-ui/src/lib/ProviderForm.svelte](admin-ui/src/lib/ProviderForm.svelte) | Add/edit provider form. Type selector locked when editing. Vertex AI: auth mode toggle (service account + JSON import / API key). AI Studio/OpenAI: API key input |
| [admin-ui/src/lib/ClientKeySection.svelte](admin-ui/src/lib/ClientKeySection.svelte) | Client API key management (generate, custom, reveal with close button, copy, delete) |
| [admin-ui/src/lib/ChangePasswordModal.svelte](admin-ui/src/lib/ChangePasswordModal.svelte) | Change admin password modal with show/hide toggles |

## Provider Interface Contract

Every provider module must export:

```js
export async function proxyRequest(request, env, provider, suffix)
// suffix: URL path after /v1 (e.g. "/chat/completions")

export async function fetchModelList(env, config)
// Returns: Array<{ id, object: "model", created, owned_by }>
```

## KV Data Model

```
config:version              → integer (bumped on every save/delete for cache invalidation)
config:admin_password       → SHA-256 hash (also serves as session token)
config:providers            → JSON array of provider IDs
config:provider:{id}        → { id, type, name, enabled, config, models, weight }
config:client_api_key       → AES-GCM encrypted (optional; if absent /v1/* is public)
config:fail2ban:{ip}        → { attempts_window, banned_until } (auto-expires)
```

Sensitive fields (`apiKey`, `privateKey`) stored `enc:` prefixed. Edit without changing preserves existing encrypted value.

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
- `assets.directory` → `./admin-ui/build/` (SvelteKit build output)
- `assets.not_found_handling` → `"single-page-application"` (SPA fallback)
- `assets.run_worker_first` → `["/admin/*", "/v1/*", "/health"]` (API routes bypass assets)

## Key Constraints

- **No DOM API in tests.** Test environment is `workerd`. Use `cloudflare:test` imports.
- **ENCRYPTION_KEY required.** `.dev.vars` with `ENCRYPTION_KEY=<64 hex chars>`. Generate: `openssl rand -hex 32`.
- **SvelteKit build must exist.** Run `npm run build:ui` before `npm run deploy` or `npm test`.
- **`nodejs_compat` flag** enabled in wrangler.jsonc.
- **Tab indentation**, LF line endings (`.editorconfig` / `.prettierrc`).
- **No Svelte runes in `.ts` files.** `$state`, `$effect`, etc. only work in `.svelte` files. Regular `.ts` files use plain variables.

## Security

- API keys: AES-256-GCM encrypted; key in Worker Secret (`ENCRYPTION_KEY`)
- Admin auth: SHA-256 password hash → Bearer token = hash itself
- fail2ban: 5 failures per 5-min window → 15-min IP ban
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

**Responsive breakpoints:** `sm:640px` (tablet), `lg:1024px` (desktop). Mobile-first: stacks vertically, full-width cards, always-visible action buttons. Desktop: `max-w-4xl` centered, hover-reveal actions.

**Reduced motion:** `prefers-reduced-motion: reduce` disables all animations/transitions globally.
