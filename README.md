# AI API 统一代理

基于 Cloudflare Workers 的多后端 AI API 统一代理，将 Google Vertex AI、Google AI Studio 和 OpenAI 官方 API 聚合为单一 OpenAI 兼容接口。

## ✨ 特性

- 🔀 **多后端统一** — 一套接口聚合 Vertex AI、AI Studio、OpenAI，按模型名自动路由
- 🔌 **OpenAI 兼容** — 标准 `/v1/chat/completions`、`/v1/models` 接口，无缝替换 OpenAI SDK base URL
- 🎨 **可视化配置** — 内置 Web 管理面板，无需修改代码即可管理提供商和密钥
- 🔐 **安全设计** — API Key AES-GCM 加密存储、fail2ban 防暴力破解、客户端访问密钥
- 🤖 **模型自动发现** — 通过各提供商官方 API 自动获取可用模型列表
- ⚡ **边缘计算** — 基于 Cloudflare Workers 全球边缘网络，低延迟高可用
- 📦 **零依赖** — 仅使用 Web Crypto API 和 Workers 内置能力，无需第三方库

## 🏗️ 架构

```
客户端 (OpenAI SDK / curl / 任何 HTTP 客户端)
      │
      ▼
┌─────────────────────────────────────────┐
│         Cloudflare Worker               │
│                                          │
│  GET  /          → 🎨 配置管理面板       │
│  POST /v1/chat/completions  → 模型路由  │
│  GET  /v1/models            → 模型聚合  │
│  POST /admin/*              → 管理 API  │
│                                          │
│  路由引擎（按模型名自动分发）:            │
│    google/* → Vertex AI / AI Studio      │
│    gpt-*    → OpenAI 官方                │
│                                          │
│  ┌─────────┐ ┌──────────┐ ┌───────────┐ │
│  │ Vertex  │ │AI Studio │ │  OpenAI   │ │
│  │  (JWT)  │ │(API Key) │ │ (API Key) │ │
│  └────┬────┘ └────┬─────┘ └─────┬─────┘ │
│       │           │             │        │
└───────┼───────────┼─────────────┼────────┘
        ▼           ▼             ▼
   Google Cloud  Google API   api.openai.com
   Vertex AI     AI Studio
```

## 📦 支持的后端

| 后端 | 认证方式 | 配置复杂度 |
|------|---------|-----------|
| **Google Vertex AI** | 服务账号 JWT (RS256) | 需要项目 ID、服务账号邮箱、PEM 私钥 |
| **Google AI Studio** | API Key (Bearer) | 仅需 API Key |
| **OpenAI 官方** | API Key (Bearer) | 仅需 API Key |

每种后端支持配置多个实例（如多个 API Key 负载均衡）。

## 🚀 快速部署

### 前提条件

- [Cloudflare 账号](https://dash.cloudflare.com/)
- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)

### 1. 克隆并安装

```bash
git clone <repo-url> && cd ai_api
npm install
```

### 2. 创建 KV 命名空间

```bash
wrangler kv namespace create AI_API_CONFIG
```

将输出的 `id` 填入 `wrangler.jsonc` 中的 `kv_namespaces`。

### 3. 生成加密密钥

```bash
openssl rand -hex 32
# 输出示例: 926090634389e3b4285e5774e59913aacca1acc1e19a41e01b8d4f30d3c5f5fe
```

### 4. 设置加密密钥（用于加密存储 API Key）

```bash
wrangler secret put ENCRYPTION_KEY
# 粘贴步骤 3 生成的密钥
```

### 5. （可选）设置客户端访问密钥

```bash
wrangler secret put OPENAI_API_KEY
# 或部署后通过 Web 管理面板设置
```

### 6. 部署

```bash
wrangler deploy
```

### 7. 初始化配置

浏览器访问 `https://your-worker.workers.dev/`：
1. 首次访问输入管理密码（≥6 位）
2. 点击「+ 添加提供商」
3. 选择类型并填写配置
4. 在「客户端 API Key」卡片中生成访问密钥

## 📖 使用说明

### Web 管理面板

| 操作 | 说明 |
|------|------|
| 添加提供商 | 选择类型 → 填写认证信息 → 保存，模型自动从 API 获取 |
| 启用/禁用 | 切换开关立即生效 |
| 客户端密钥 | 🎲 随机生成 / ✏️ 自定义 / 👁️ 查看 / 📋 复制 / 🗑 删除 |
| 修改密码 | 需验证当前密码 |

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
print(response.choices[0].message.content)
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

### 列出可用模型

```bash
curl https://your-worker.workers.dev/v1/models \
  -H "Authorization: Bearer sk-your-client-api-key"
```

## 🔌 API 参考

### OpenAI 兼容接口

| 路由 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 对话补全（自动路由） |
| `/v1/models` | GET | 聚合模型列表 |
| `/v1/models/{id}` | GET | 单个模型信息 |
| `/v1/*` | ANY | 通用代理 |

### 管理 API

| 路由 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/admin/auth` | POST | 无 | 登录获取 token |
| `/admin/setup` | POST | 无 | 首次设置密码 |
| `/admin/check` | GET | Bearer | 验证 token |
| `/admin/providers` | GET/POST | Bearer | 列出/添加提供商 |
| `/admin/providers/{id}` | GET/PUT/DELETE | Bearer | 单个提供商操作 |
| `/admin/client-key` | GET/POST/DELETE | Bearer | 客户端密钥管理 |
| `/admin/change-password` | POST | Bearer | 修改管理密码 |
| `/admin/default-provider` | GET/PUT | Bearer | 默认提供商 |

## 🔒 安全设计

| 特性 | 实现 |
|------|------|
| **API Key 存储** | AES-256-GCM 加密，密钥存储于 Worker Secret |
| **管理面板认证** | SHA-256 密码哈希 |
| **暴力破解防护** | fail2ban：5 次失败 → 15 分钟封禁 |
| **客户端访问控制** | 可选的 Bearer Token，通过管理面板管理 |
| **密钥保护** | 编辑时不回填敏感字段，防止脱敏值覆盖真实密钥 |
| **传输安全** | Cloudflare 自动 TLS，CORS 头可配置 |

## 🗂️ KV 数据结构

```
AI_API_CONFIG (KV Namespace)
├── config:version           → 配置版本号（缓存失效用）
├── config:admin_password    → 管理密码 SHA-256 哈希
├── config:providers         → ["vertex-1", "openai-1", ...]
├── config:default_provider  → 默认提供商 ID
├── config:client_api_key    → 客户端访问密钥（AES-GCM 加密）
├── config:provider:vertex-1 → {type, name, enabled, config, models}
├── config:provider:openai-1 → {type, name, enabled, config, models}
├── config:fail2ban:{ip}     → {attempts, banned_until} (自动过期)
└── ...
```

## 🛠️ 开发

```bash
npm run dev      # 本地开发 (wrangler dev)
npm test         # 运行测试 (vitest)
npm run deploy   # 部署到 Cloudflare
```

### 项目结构

```
src/
├── index.js              # 主入口：路由分发 + 模型聚合 + 内联配置页面
├── admin.js              # 管理 API (/admin/*)
├── config.js             # KV 配置 CRUD
├── crypto.js             # AES-GCM 加解密 + SHA-256
├── fail2ban.js           # 登录限流
├── admin-ui.html         # 配置页面源文件
└── providers/
    ├── vertex.js         # Google Vertex AI 代理
    ├── ai-studio.js      # Google AI Studio 代理
    └── openai.js         # OpenAI 官方代理
```

### 更新配置页面

修改 `src/admin-ui.html` 后运行 `node rebuild.js` 重新内联到 `index.js`。

## 📄 许可

MIT License
