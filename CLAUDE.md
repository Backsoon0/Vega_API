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

```
Request flow:
  Browser → Worker (vega-api)
    ├── /admin/* → Admin API (admin.js + config.js → KV)
    ├── /v1/*    → AI proxy (providers/*.js → upstream)
    ├── /health  → Health check
    └── /*       → Static assets (admin-ui/build/ SvelteKit SPA)
                    └── SPA fallback (index.html)
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
| [src/providers/vertex.js](src/providers/vertex.js) | Vertex AI: JWT RS256 auth, token cache per service account |
| [src/providers/ai-studio.js](src/providers/ai-studio.js) | AI Studio: Bearer token at `generativelanguage.googleapis.com` |
| [src/providers/openai.js](src/providers/openai.js) | OpenAI: Bearer token, configurable base URL |
| [test/index.spec.js](test/index.spec.js) | Integration tests (`cloudflare:test` Vitest pool) |

**Admin frontend (SvelteKit SPA):**

| File | Role |
|------|------|
| [admin-ui/src/lib/api.ts](admin-ui/src/lib/api.ts) | API client for `/admin/*` endpoints |
| [admin-ui/src/routes/+page.svelte](admin-ui/src/routes/+page.svelte) | Login page |
| [admin-ui/src/routes/dashboard/+page.svelte](admin-ui/src/routes/dashboard/+page.svelte) | Main dashboard (providers + client key) |
| [admin-ui/src/lib/ProviderForm.svelte](admin-ui/src/lib/ProviderForm.svelte) | Add/edit provider form (with Vertex AI JSON import) |
| [admin-ui/src/lib/ClientKeySection.svelte](admin-ui/src/lib/ClientKeySection.svelte) | Client API key management card |

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
