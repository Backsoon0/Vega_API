# Vega API

基于 Cloudflare Workers (Hono + TypeScript) 的多后端 AI API 统一代理，将 Google Vertex AI、Google AI Studio 和 OpenAI 聚合为单一 OpenAI 兼容接口。管理面板使用 SvelteKit + Tailwind CSS 构建，侧边栏导航 + D1 数据库。

## 特性

- **多后端统一** — 一套接口聚合 Vertex AI、AI Studio、OpenAI，按模型名自动路由
- **OpenAI 兼容** — 标准 `/v1/chat/completions`、`/v1/models` 接口，无缝替换 OpenAI SDK base URL
- **SvelteKit 管理面板** — 侧边栏 4 页面（概览 / 调用记录 / API 设置 / 面板设置），Code Dark 深色主题，可折叠侧边栏，响应式设计
- **调用记录** — D1 持久化存储，记录模型、Token、耗时，支持搜索和提供商筛选
- **安全设计** — API Key AES-GCM 加密存储、登录限流（5 次失败 → 15 分钟封禁）、客户端访问密钥
- **流式支持** — 完整支持 SSE 流式响应，智能解析含内嵌换行的流数据
- **请求保护** — 5MB 请求体限制，支持图片等多模态输入
- **调用耗时** — 记录每次 API 调用耗时（ms），流式/非流式均支持
- **API 地址一键复制** — 管理面板展示完整 API 调用地址，支持一键复制
- **模型自动发现** — 通过各提供商官方 API 并行获取可用模型列表
- **边缘计算** — Cloudflare Workers 全球边缘网络，低延迟高可用

## 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Hono (TypeScript) |
| 数据库 | Cloudflare D1 |
| 前端 | SvelteKit + Tailwind CSS v4 + Lucide Icons (Code Dark 主题) |
| 加密 | Web Crypto API (AES-256-GCM、SHA-256) |
| 测试 | Vitest + @cloudflare/vitest-pool-workers |
| 部署 | Wrangler + Workers Static Assets |

## 架构

```
客户端 (OpenAI SDK / curl / 浏览器)
      │
      ▼
┌─────────────────────────────────────────┐
│         Cloudflare Worker (Hono)         │
│                                          │
│  SvelteKit SPA  → /                     │
│  POST /v1/chat/completions  → 模型路由   │
│  GET  /v1/models            → 模型聚合   │
│  POST /admin/*              → 管理 API   │
│                                          │
│  路由引擎（按模型名自动分发）:            │
│    google/* → Vertex AI / AI Studio      │
│    gpt-*    → OpenAI 官方                │
│                                          │
│  ┌─────────┐ ┌──────────┐ ┌───────────┐ │
│  │ Vertex  │ │AI Studio │ │  OpenAI   │ │
│  │(JWT/Key)│ │(API Key) │ │ (API Key) │ │
│  └────┬────┘ └────┬─────┘ └─────┬─────┘ │
│       │           │             │        │
└───────┼───────────┼─────────────┼────────┘
        ▼           ▼             ▼
   Google Cloud  Google API   api.openai.com
   Vertex AI     AI Studio
```

所有 provider 均使用 OpenAI 兼容端点透传，无需格式转换。

## 支持的后端

| 后端 | 认证方式 | 配置复杂度 |
|------|---------|-----------|
| **Google Vertex AI** | 服务账号 JWT (RS256) 或 API Key | 支持 JSON 密钥文件一键导入或直接输入 API Key |
| **Google AI Studio** | API Key (Bearer) | 仅需 API Key |
| **OpenAI 官方** | API Key (Bearer) | 仅需 API Key，支持自定义 base URL |

每种后端支持配置多个实例。

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
npm run db:migrate:local   # 本地开发
npm run db:migrate         # 生产环境
```

### 4. 生成加密密钥

```bash
openssl rand -hex 32
# 输出示例: 926090634389e3b4285e5774e59913aacca1acc1e19a41e01b8d4f30d3c5f5fe
```

### 5. 设置加密密钥

```bash
npx wrangler secret put ENCRYPTION_KEY
# 粘贴步骤 4 生成的密钥
```

### 6. 构建前端并部署

```bash
npm run deploy      # 构建前端 + 部署 Worker + 静态资源
```

### 7. 初始化配置

浏览器访问 `https://your-worker.workers.dev/`：
1. 首次访问输入管理密码（≥6 位）
2. API 设置页 → 添加提供商（Vertex AI 可一键导入 JSON 密钥文件）
3. 在「客户端 API Key」卡片中生成访问密钥

## 使用说明

### 客户端调用

**OpenAI SDK (Python)**
```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-your-client-api-key",
    base_url="https://your-worker.workers.dev/v1",
)

response = client.chat.completions.create(
    model="google/gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

**OpenAI SDK (JavaScript)**
```javascript
import OpenAI from "openai";

const client = new OpenAI({
    apiKey: "sk-your-client-api-key",
    baseURL: "https://your-worker.workers.dev/v1",
});

const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Hello!" }],
});
```

**curl**
```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-your-client-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"google/gemini-2.5-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

### 模型路由规则

| 模型前缀 | 路由目标 |
|---------|---------|
| `google/*`, `gemini/*` | Vertex AI 或 AI Studio |
| `gpt-*`, `o1-*`, `o3-*` | OpenAI 官方 |
| 其他 | 尝试所有已启用提供商 |

## API 参考

### OpenAI 兼容接口

| 路由 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 对话补全（自动路由，最大 5MB，支持流式/多模态） |
| `/v1/models` | GET | 聚合模型列表 |
| `/v1/models/{id}` | GET | 单个模型信息 |

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
| `/admin/logs` | GET | Bearer | 调用记录（返回模型、Token、耗时、成功/失败，支持搜索/筛选/分页） |

## 安全设计

| 特性 | 实现 |
|------|------|
| **API Key 存储** | AES-256-GCM 加密，密钥存储于 Worker Secret |
| **管理面板认证** | SHA-256 密码哈希 → Bearer token |
| **暴力破解防护** | D1 内置限流：5 次失败 → 15 分钟封禁（5 分钟滑动窗口） |
| **客户端访问控制** | 可选的 Bearer Token，通过管理面板管理 |
| **密钥保护** | 编辑时不回填敏感字段 |
| **传输安全** | Cloudflare 自动 TLS，CORS 可配置 |

## D1 数据结构

```
vega-api-db
├── config            — key-value 配置（密码、密钥、版本号、限流数据）
├── providers         — AI 提供商配置（敏感字段 AES-GCM 加密）
├── usage_daily       — 每日聚合用量（date, provider_id, model 三维度）
└── call_logs         — 详细调用记录（模型、Token、耗时、成功/失败，最多 10000 条自动清理）
```

## 开发

```bash
npm install              # 安装所有依赖（npm workspaces）
npm run dev              # Worker 开发服务器
npm run dev:ui           # 前端开发服务器
npm test                 # 运行测试
npm run build:ui         # 构建前端
npm run db:migrate:local # 本地数据库迁移
npm run deploy           # 部署到 Cloudflare
```

### 项目结构

```
├── package.json              # npm workspaces root
├── wrangler.jsonc            # Workers 配置（D1 + 静态资源绑定）
├── tsconfig.json
├── vitest.config.js
├── migrations/               # D1 数据库迁移
│   ├── 0001_init.sql
│   ├── 0002_call_logs.sql
│   └── 0003_duration.sql
├── src/                      # Worker 源码 (TypeScript)
│   ├── index.ts              # Hono 入口：CORS、路由挂载、健康检查、ASSETS fallback
│   ├── router.ts             # 模型路由引擎：缓存管理、Provider 查找、模型聚合
│   ├── types.ts              # 共享类型定义
│   ├── db.ts                 # D1 schema 初始化
│   ├── config.ts             # D1 配置 CRUD
│   ├── crypto.ts             # AES-GCM 加解密 + SHA-256
│   ├── rate-limit.ts         # 登录限流
│   ├── usage.ts              # 用量追踪 + 调用记录
│   ├── middleware/
│   │   └── auth.ts           # 认证中间件（客户端 + 管理员）
│   ├── routes/
│   │   ├── admin/
│   │   │   ├── auth.ts       # /admin/auth、/admin/setup、/admin/check、/admin/change-password
│   │   │   ├── providers.ts  # /admin/providers CRUD
│   │   │   ├── client-key.ts # /admin/client-key 管理
│   │   │   └── usage.ts      # /admin/usage、/admin/logs
│   │   └── v1/
│   │       ├── models.ts     # /v1/models、/v1/models/:modelId
│   │       └── chat.ts       # /v1/chat/completions（流式/非流式代理）
│   └── providers/
│       ├── vertex.ts         # Google Vertex AI（JWT + API Key）
│       ├── ai-studio.ts      # Google AI Studio（Bearer）
│       └── openai.ts         # OpenAI 官方（Bearer）
├── test/
│   └── index.spec.js         # 集成测试
└── admin-ui/                 # SvelteKit 管理面板（npm workspace）
    ├── package.json
    ├── svelte.config.js
    └── src/
        ├── app.html
        ├── app.css
        ├── lib/
        │   ├── api.ts                     # /admin/* API 客户端
        │   ├── sidebar-state.ts           # 侧边栏折叠状态 store
        │   ├── Sidebar.svelte             # 可折叠侧边栏导航
        │   ├── CallLogTable.svelte        # 调用记录表格（桌面表 + 移动卡片）
        │   ├── Modal.svelte
        │   ├── ProviderCard.svelte
        │   ├── ProviderForm.svelte
        │   ├── ClientKeySection.svelte
        │   └── Toast.svelte
        └── routes/
            ├── +layout.svelte             # Auth guard + 侧边栏外壳
            ├── +page.svelte               # 登录页
            └── dashboard/
                ├── +page.svelte           # 概览
                ├── logs/+page.svelte      # 调用记录
                ├── api-settings/+page.svelte  # API 设置
                └── panel-settings/+page.svelte # 面板设置
```

## 设计系统 — Code Dark

管理面板使用 Code Dark 主题（OLED 暗色），设计 Token 集中在 `app.css`：

| 层级 | 值 | 用途 |
|------|-----|------|
| 背景 | `#0F172A` | 页面底色 |
| 表面 | `#1B2336` / `#1E293B` | 卡片、输入框 |
| 主文字 | `#F8FAFC` | 标题、正文 |
| 次要文字 | `#CBD5E1` / `#64748B` | 描述、提示 |
| Accent 绿 | `#22C55E` | 状态指示、成功、启用 |
| CTA 蓝 | `#3B82F6` | 按钮、链接、聚焦环 |
| 危险红 | `#EF4444` | 删除、错误 |
| 警告黄 | `#F59E0B` | 禁用警告 |

| 字体 | 用途 |
|------|------|
| **JetBrains Mono** | 标题、代码、ID |
| **IBM Plex Sans** | 正文、标签、UI 控件 |

## 许可

MIT License
