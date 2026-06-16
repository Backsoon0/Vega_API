# Vega API

基于 Cloudflare Workers (Hono + TypeScript) 的**多接口 AI API 网关**，使用 Vercel AI SDK 统一后端，同时提供 OpenAI (`/v1/*`)、Google Gemini (`/v1beta/*`)、Anthropic Messages (`/anthropic/*`) 三种原生 API 接口。管理面板使用 SvelteKit + Tailwind CSS v4 构建。

## 特性

- **三接口并行** — 同一 Worker 同时提供 OpenAI、Gemini、Anthropic 三种标准 API，一套 key 全部通用
- **AI SDK 驱动** — 基于 Vercel AI SDK v5 (`streamText`/`generateText`) 统一后端调用，自动在各 provider 原生格式间转换
- **全 Provider 互通** — 任一 provider 均可通过任一接口访问（如 OpenAI-format 请求路由到 Anthropic，Gemini-format 请求路由到 OpenAI）
- **4 种 Provider** — 支持 OpenAI、Google AI Studio、Vertex AI (JWT/API Key)、Anthropic
- **SvelteKit 管理面板** — 侧边栏 4 页面（概览 / 调用记录 / API 设置 / 面板设置），Code Dark 深色主题，可折叠侧边栏，响应式设计
- **调用记录** — D1 持久化存储，记录模型、Token、耗时，支持搜索和提供商筛选
- **安全设计** — API Key AES-GCM 加密存储、登录限流（5 次失败 → 15 分钟封禁）、多种认证方式
- **流式支持** — 完整支持 SSE 流式响应（OpenAI/Gemini/Anthropic 三种 SSE 格式）
- **思考模式控制** — 支持 `thinking: { type: "disabled" }` 禁用推理（Anthropic/Google 通过 AI SDK 原生支持，DeepSeek 通过参数透传支持）
- **内容过滤兼容** — `content_filter` finish_reason 不会产生虚假 error chunk，客户端正常收到过滤结束信号
- **请求保护** — 5MB 请求体限制，支持图片等多模态输入
- **模型自动发现** — 通过各提供商官方 API 并行获取可用模型列表

## 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Hono (TypeScript) |
| AI 后端 | Vercel AI SDK v5 (`ai` + `@ai-sdk/openai` + `@ai-sdk/google` + `@ai-sdk/anthropic`) |
| 数据库 | Cloudflare D1 |
| 前端 | SvelteKit + Tailwind CSS v4 + Lucide Icons (Code Dark 主题) |
| 加密 | Web Crypto API (AES-256-GCM、SHA-256) |
| 测试 | Vitest + @cloudflare/vitest-pool-workers |
| 部署 | Wrangler + Workers Static Assets |

## 架构

```
客户端 (OpenAI SDK / Google GenAI SDK / Anthropic SDK / Cherry Studio / curl)
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│              Cloudflare Worker (Hono + AI SDK)                │
│                                                               │
│  SvelteKit SPA → /                                           │
│  OpenAI 兼容    → /v1/chat/completions, /v1/models           │
│  Gemini 原生    → /v1beta/models, :generateContent, :stream  │
│  Anthropic 原生 → /anthropic/v1/messages, /v1/models         │
│  管理 API       → /admin/*                                    │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │            AI SDK Provider 工厂 (ai-providers.ts)     │    │
│  │                                                       │    │
│  │  OpenAI ──── @ai-sdk/openai  ─── OpenAI API           │    │
│  │  AI Studio   @ai-sdk/google   ─── Gemini API          │    │
│  │  Vertex AI   @ai-sdk/google   ─── Vertex AI (JWT)     │    │
│  │  Anthropic   @ai-sdk/anthropic── Anthropic Messages    │    │
│  │                                                       │    │
│  │  streamText() / generateText() → 自动格式转换          │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐     │
│  │  OpenAI  │ │  Google  │ │  Vertex  │ │ Anthropic  │     │
│  │ (API Key)│ │(API Key) │ │ (JWT/Key)│ │ (API Key)  │     │
│  └──────────┘ └──────────┘ └──────────┘ └────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

所有 provider 通过 AI SDK 统一调用，格式转换由 AI SDK 自动处理。

## 支持的 Provider

| Provider | 类型标识 | 认证方式 | 配置复杂度 |
|----------|---------|---------|-----------|
| **OpenAI / 兼容** | `openai` | API Key (Bearer) | 仅需 API Key + 可选 base URL |
| **Google AI Studio** | `google_ai_studio` | API Key | 仅需 API Key |
| **Google Vertex AI** | `vertex_ai` | 服务账号 JWT (RS256) 或 API Key | 支持 JSON 密钥文件导入 |
| **Anthropic** | `anthropic` | API Key | 仅需 API Key |

每种 provider 支持配置多个实例。

## 三套 API 接口

### 1. OpenAI 兼容 (`/v1/*`)

标准 OpenAI Chat Completions API，可直接替换 `api.openai.com`。

```bash
# 模型列表
curl https://your-worker.workers.dev/v1/models \
  -H "Authorization: Bearer sk-your-key"

# 对话 (非流式)
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Hello!"}]}'

# 对话 (流式 SSE)
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

**认证**: `Authorization: Bearer <key>`

### 2. Google Gemini 原生 (`/v1beta/*`)

完全兼容 Google Generative Language API，可直接在 Google GenAI SDK 或 Cherry Studio 中使用。

```bash
# 模型列表
curl https://your-worker.workers.dev/v1beta/models \
  -H "x-goog-api-key: sk-your-key"

# 生成内容 (非流式)
curl https://your-worker.workers.dev/v1beta/models/gemini-2.5-flash:generateContent \
  -H "x-goog-api-key: sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Hello!"}]}]}'

# 生成内容 (流式 SSE, ?alt=sse)
curl "https://your-worker.workers.dev/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse" \
  -H "x-goog-api-key: sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Hello!"}]}]}'
```

**认证**: `x-goog-api-key: <key>` 或 `?key=<key>` 或 `Authorization: Bearer <key>`

### 3. Anthropic Messages 原生 (`/anthropic/*`)

完全兼容 Anthropic Messages API，可直接使用 Anthropic SDK 或 Cherry Studio。

```bash
# 模型列表
curl https://your-worker.workers.dev/anthropic/v1/models \
  -H "x-api-key: sk-your-key"

# 对话 (非流式)
curl https://your-worker.workers.dev/anthropic/v1/messages \
  -H "x-api-key: sk-your-key" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"gemini-2.5-flash","max_tokens":50,"messages":[{"role":"user","content":"Hello!"}]}'

# 对话 (流式 SSE)
curl https://your-worker.workers.dev/anthropic/v1/messages \
  -H "x-api-key: sk-your-key" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":50,"stream":true,"system":"You are helpful.","messages":[{"role":"user","content":"Hello!"}]}'
```

**认证**: `x-api-key: <key>` 或 `Authorization: Bearer <key>`

### 认证方式汇总

| 接口 | 认证方式 |
|------|---------|
| `/v1/*` | `Authorization: Bearer <key>` / `x-api-key: <key>` |
| `/v1beta/*` | `x-goog-api-key: <key>` / `?key=<key>` / `Authorization: Bearer <key>` |
| `/anthropic/*` | `x-api-key: <key>` / `Authorization: Bearer <key>` |

> 三种接口共用同一个 Client API Key，在管理面板中设置。

### 参数透传 (Extra Body)

部分下游 API 参数 AI SDK 未原生支持（如 DeepSeek 的 `thinking`），Vega 提供两种透传机制：

#### `/v1/chat/completions` — 自动转发

所有请求体字段（除 `model`、`stream`、`stream_options`）自动转发到下游 API，无需额外包装：

```bash
# DeepSeek 禁用思考 — thinking 直接放在请求体顶层
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-pro",
    "messages": [{"role": "user", "content": "Hello!"}],
    "thinking": {"type": "disabled"},
    "some_future_field": "value"
  }'
```

#### `/v1beta/*` 和 `/anthropic/*` — 显式 `extra_body`

非 OpenAI 格式路由仅透传 `extra_body` 字段，避免格式冲突：

```bash
curl https://your-worker.workers.dev/anthropic/v1/messages \
  -H "x-api-key: sk-your-key" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 50,
    "messages": [{"role": "user", "content": "Hello!"}],
    "extra_body": {"thinking": {"type": "disabled"}}
  }'
```

> 仅 OpenAI 类型 Provider（含 DeepSeek、Groq 等兼容 API）支持透传。Anthropic/Google Provider 使用 AI SDK 原生 providerOptions 处理已知参数。

## 客户端 SDK 示例

### OpenAI SDK (Python / JavaScript)

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-your-client-api-key",
    base_url="https://your-worker.workers.dev/v1",
)
response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

### Google GenAI SDK (Python)

```python
from google import genai

client = genai.Client(
    api_key="sk-your-key",
    http_options={"base_url": "https://your-worker.workers.dev/v1beta"},
)
response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents="Hello!",
)
```

### Anthropic SDK (Python)

```python
import anthropic

client = anthropic.Anthropic(
    api_key="sk-your-key",
    base_url="https://your-worker.workers.dev/anthropic",
)
response = client.messages.create(
    model="gemini-2.5-flash",
    max_tokens=50,
    messages=[{"role": "user", "content": "Hello!"}],
)
```

## API 路由参考

### 完整路由表

| 路由 | 方法 | 格式 | 说明 |
|------|------|------|------|
| `/health` | GET | JSON | 健康检查 |
| `/v1/models` | GET | OpenAI | 模型列表 |
| `/v1/models/:id` | GET | OpenAI | 单模型 |
| `/v1/chat/completions` | POST | OpenAI | 对话补全 (流式/非流式) |
| `/v1beta/models` | GET | Gemini | 模型列表 |
| `/v1beta/models/:id` | GET | Gemini | 单模型 |
| `/v1beta/models/:id:generateContent` | POST | Gemini | 内容生成 (非流式) |
| `/v1beta/models/:id:streamGenerateContent` | POST | Gemini | 内容生成 (流式, SSE/NDJSON) |
| `/anthropic/v1/models` | GET | OpenAI | 模型列表 (Anthropic 无标准端点) |
| `/anthropic/v1/messages` | POST | Anthropic | Messages API (流式/非流式) |

### 管理 API

| 路由 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/admin/auth` | POST | 限流 | 登录获取 token |
| `/admin/setup` | POST | 无 | 首次设置密码 |
| `/admin/check` | GET | Bearer | 验证 token |
| `/admin/providers` | GET/POST | Bearer | 列出/添加提供商 |
| `/admin/providers/{id}` | GET/PUT/DELETE | Bearer | 单个提供商操作 |
| `/admin/client-key` | GET/POST/DELETE | Bearer | 客户端密钥管理 |
| `/admin/change-password` | POST | Bearer | 修改管理密码 |
| `/admin/usage` | GET | Bearer | 用量统计 |
| `/admin/logs` | GET | Bearer | 调用记录 |

## 管理面板页面

| 页面 | 路由 | 功能 |
|------|------|------|
| **概览** | `/dashboard` | 统计卡片（总调用、Token、活跃提供商）+ 提供商状态列表 |
| **调用记录** | `/dashboard/logs` | 每次 API 调用的时间、IP、提供商、模型、Token，支持搜索和筛选 |
| **API 设置** | `/dashboard/api-settings` | API 调用地址一键复制 + 客户端 API Key 管理 + 提供商 CRUD |
| **面板设置** | `/dashboard/panel-settings` | 修改管理密码 |

## 快速部署

### 前提条件

- [Cloudflare 账号](https://dash.cloudflare.com/)
- [Node.js](https://nodejs.org/) 18+

### 1. 克隆并安装

```bash
git clone <repo-url> && cd vega-api
npm install
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create vega-api-db
```

将输出的 `database_id` 填入 `wrangler.jsonc` 中的 `d1_databases.database_id`。

### 3. 运行数据库迁移

```bash
npm run db:migrate         # 生产环境
npm run db:migrate:local   # 本地开发
```

### 4. 生成加密密钥

```bash
openssl rand -hex 32
```

### 5. 设置加密密钥

```bash
npx wrangler secret put ENCRYPTION_KEY
```

### 6. 构建前端并部署

```bash
npm run deploy
```

### 7. 初始化配置

浏览器访问 `https://your-worker.workers.dev/`：
1. 首次访问输入管理密码（≥6 位）
2. API 设置页 → 添加提供商
3. 在「客户端 API Key」卡片中生成访问密钥

## 安全设计

| 特性 | 实现 |
|------|------|
| **API Key 存储** | AES-256-GCM 加密，密钥存储于 Worker Secret |
| **管理面板认证** | SHA-256 密码哈希 → Bearer token |
| **暴力破解防护** | D1 内置限流：5 次失败 → 15 分钟封禁（5 分钟滑动窗口） |
| **客户端访问控制** | 支持 Bearer / x-api-key / x-goog-api-key / ?key= 多认证方式 |
| **密钥保护** | 编辑时不回填敏感字段 |
| **传输安全** | Cloudflare 自动 TLS |

## D1 数据结构

```
vega-api-db
├── config            — key-value 配置（密码、密钥、版本号、限流数据）
├── providers         — AI 提供商配置（敏感字段 AES-GCM 加密，支持 4 种类型）
├── usage_daily       — 每日聚合用量（date, provider_id, model 三维度）
└── call_logs         — 详细调用记录（模型、Token、耗时，最多 10000 条自动清理）
```

## 开发

```bash
npm install              # 安装所有依赖（npm workspaces）
npm run dev              # Worker 开发服务器
npm run dev:ui           # 前端开发服务器
npm test                 # 运行测试
npm run build:ui         # 构建前端
npm run db:migrate:local # 本地数据库迁移
npm run deploy           # 构建 + 部署到 Cloudflare
```

### 项目结构

```
├── package.json              # npm workspaces root
├── wrangler.jsonc            # Workers 配置 (D1 + Assets + run_worker_first)
├── migrations/               # D1 数据库迁移
│   ├── 0001_init.sql         # 核心表
│   ├── 0002_call_logs.sql    # 调用记录表
│   └── 0006_provider_types.sql # 新增 'anthropic' provider 类型
├── src/                      # Worker 源码 (TypeScript)
│   ├── index.ts              # Hono 入口: CORS, 路由挂载, 健康检查
│   ├── ai-providers.ts       # AI SDK Provider 工厂 + Vertex JWT 管理
│   ├── router.ts             # 模型路由: 缓存, Provider 查找, 模型聚合
│   ├── types.ts              # 共享类型定义
│   ├── db.ts                 # D1 schema 初始化
│   ├── config.ts             # D1 配置 CRUD
│   ├── crypto.ts             # AES-GCM + SHA-256
│   ├── rate-limit.ts         # 登录限流
│   ├── usage.ts              # 用量追踪 + 调用记录
│   ├── middleware/
│   │   └── auth.ts           # 认证中间件 (4 种认证方式)
│   ├── routes/
│   │   ├── admin/
│   │   │   ├── auth.ts
│   │   │   ├── providers.ts
│   │   │   ├── client-key.ts
│   │   │   └── usage.ts
│   │   ├── v1/
│   │   │   ├── models.ts     # /v1/models (OpenAI 格式)
│   │   │   └── chat.ts       # /v1/chat/completions (AI SDK)
│   │   ├── v1beta/
│   │   │   ├── models.ts     # /v1beta/models (Gemini 格式)
│   │   │   └── chat.ts       # /v1beta/models/:model:generateContent
│   │   └── anthropic/
│   │       └── messages.ts   # /anthropic/v1/messages (Anthropic SSE)
│   └── providers/
│       ├── vertex.ts         # Vertex AI (JWT + API Key, model list)
│       ├── ai-studio.ts      # Google AI Studio (model list)
│       └── openai.ts         # OpenAI 官方 (model list)
├── test/
│   └── index.spec.js         # 集成测试
└── admin-ui/                 # SvelteKit 管理面板
    ├── package.json
    └── src/
        ├── app.css           # Code Dark 设计 Token
        ├── lib/
        │   ├── api.ts        # /admin/* API 客户端
        │   ├── Sidebar.svelte
        │   ├── CallLogTable.svelte
        │   ├── ProviderForm.svelte
        │   └── ...
        └── routes/
            ├── +layout.svelte
            ├── +page.svelte          # 登录
            └── dashboard/
                ├── +page.svelte      # 概览
                ├── logs/+page.svelte
                ├── api-settings/+page.svelte
                └── panel-settings/+page.svelte
```

## 设计系统 — Code Dark

管理面板使用 Code Dark 主题（OLED 暗色）：

| 层级 | 值 | 用途 |
|------|-----|------|
| 背景 | `#0F172A` | 页面底色 |
| 表面 | `#1B2336` / `#1E293B` | 卡片、输入框 |
| 主文字 | `#F8FAFC` | 标题、正文 |
| 次要文字 | `#CBD5E1` / `#64748B` | 描述、提示 |
| Accent 绿 | `#22C55E` | 状态指示、成功 |
| CTA 蓝 | `#3B82F6` | 按钮、链接 |
| 危险红 | `#EF4444` | 删除、错误 |
| 警告黄 | `#F59E0B` | 禁用警告 |

| 字体 | 用途 |
|------|------|
| **JetBrains Mono** | 标题、代码、ID |
| **IBM Plex Sans** | 正文、标签、UI |

## 许可

MIT License
