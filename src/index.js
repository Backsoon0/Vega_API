// src/index.js
// Cloudflare Worker - Multi-Provider AI API Proxy
//
// Supports:
//   - Google Vertex AI (JWT service account auth)
//   - Google AI Studio (API key auth, OpenAI-compatible endpoint)
//   - OpenAI official API (API key auth)
//
// All API routes use /v1 prefix (OpenAI-compatible).
// Admin UI at / for configuration management.
// Configuration stored in Cloudflare KV.

import { handleAdminRoutes } from "./admin.js";
import { listProviders, getConfigVersion, getClientApiKey } from "./config.js";
import * as VertexProvider from "./providers/vertex.js";
import * as AiStudioProvider from "./providers/ai-studio.js";
import * as OpenAIProvider from "./providers/openai.js";

// ---- Cache ----
let cachedProviders = null;
let cachedProvidersAt = 0;
let cachedProvidersVersion = -1;
const PROVIDERS_CACHE_TTL_MS = 60 * 1000; // 1 minute

let cachedModels = null;
let cachedModelsAt = 0;
let cachedModelsVersion = -1;
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---- Provider registry ----
const PROVIDER_HANDLERS = {
  vertex_ai: VertexProvider,
  google_ai_studio: AiStudioProvider,
  openai: OpenAIProvider,
};

// ---- Helpers ----

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, x-proxy-key",
    "Access-Control-Expose-Headers": "content-type",
    "Vary": "Origin",
  };
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(request);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---- HTML for admin UI (auto-generated from admin-ui.html) ----
const ADMIN_HTML = "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>AI API 统一代理 - 配置管理</title>\n<style>\n  :root {\n    --bg: #0d1117;\n    --bg-card: #161b22;\n    --bg-input: #21262d;\n    --border: #30363d;\n    --text: #c9d1d9;\n    --text-muted: #8b949e;\n    --accent: #58a6ff;\n    --danger: #f85149;\n    --success: #3fb950;\n    --warning: #d29922;\n    --radius: 8px;\n  }\n  * { box-sizing: border-box; margin: 0; padding: 0; }\n  body {\n    font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Helvetica, Arial, sans-serif;\n    background: var(--bg);\n    color: var(--text);\n    line-height: 1.6;\n    min-height: 100vh;\n  }\n  .container { max-width: 900px; margin: 0 auto; padding: 20px; }\n\n  /* Header */\n  .header {\n    text-align: center; padding: 40px 0 30px;\n    border-bottom: 1px solid var(--border); margin-bottom: 30px;\n  }\n  .header h1 { font-size: 24px; color: var(--accent); margin-bottom: 8px; }\n  .header p { color: var(--text-muted); font-size: 14px; }\n  .header .badge { display: inline-block; padding: 2px 10px; border-radius: 12px;\n    background: rgba(88,166,255,.15); color: var(--accent); font-size: 12px;\n    margin-left: 8px; }\n\n  /* Login */\n  #login-screen {\n    max-width: 400px; margin: 80px auto; text-align: center;\n  }\n  #login-screen h2 { margin-bottom: 20px; font-size: 20px; }\n  #login-screen .card { padding: 30px; }\n  .card {\n    background: var(--bg-card); border: 1px solid var(--border);\n    border-radius: var(--radius); padding: 20px; margin-bottom: 16px;\n  }\n  .form-group { margin-bottom: 14px; text-align: left; }\n  .form-group label { display: block; font-size: 13px; color: var(--text-muted); margin-bottom: 4px; }\n  .form-group input, .form-group select, .form-group textarea {\n    width: 100%; padding: 8px 12px; font-size: 14px; border-radius: 6px;\n    border: 1px solid var(--border); background: var(--bg-input); color: var(--text);\n    font-family: inherit;\n  }\n  .form-group textarea { min-height: 80px; resize: vertical; font-family: monospace; font-size: 12px; }\n  .form-group input:focus, .form-group select:focus, .form-group textarea:focus {\n    outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(88,166,255,.15);\n  }\n  .form-row { display: flex; gap: 12px; }\n  .form-row .form-group { flex: 1; }\n\n  .btn {\n    display: inline-block; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--border);\n    font-size: 14px; font-family: inherit; cursor: pointer; transition: all .15s;\n    background: var(--bg-input); color: var(--text); text-decoration: none;\n  }\n  .btn:hover { background: #30363d; }\n  .btn-primary { background: #238636; color: #fff; border-color: #238636; }\n  .btn-primary:hover { background: #2ea043; }\n  .btn-danger { background: #da3633; color: #fff; border-color: #da3633; }\n  .btn-danger:hover { background: #f85149; }\n  .btn-sm { padding: 4px 10px; font-size: 12px; }\n  .btn:disabled { opacity: .5; cursor: not-allowed; }\n\n  .error { color: var(--danger); font-size: 13px; margin-top: 8px; display: none; }\n  .error.show { display: block; }\n  .success-msg { color: var(--success); font-size: 13px; margin-top: 8px; display: none; }\n  .success-msg.show { display: block; }\n\n  /* Provider cards */\n  .provider-list { display: flex; flex-direction: column; gap: 12px; }\n  .provider-card {\n    display: flex; align-items: center; gap: 14px;\n    background: var(--bg-card); border: 1px solid var(--border);\n    border-radius: var(--radius); padding: 16px 20px;\n    transition: border-color .2s;\n  }\n  .provider-card:hover { border-color: var(--accent); }\n  .provider-card.disabled { opacity: .5; }\n  .provider-type {\n    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px;\n    padding: 3px 8px; border-radius: 4px; white-space: nowrap;\n  }\n  .type-vertex_ai { background: rgba(88,166,255,.15); color: var(--accent); }\n  .type-google_ai_studio { background: rgba(63,185,80,.15); color: var(--success); }\n  .type-openai { background: rgba(210,153,34,.15); color: var(--warning); }\n  .provider-info { flex: 1; min-width: 0; }\n  .provider-info .name { font-weight: 600; font-size: 15px; }\n  .provider-info .models { font-size: 12px; color: var(--text-muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n  .provider-actions { display: flex; gap: 6px; flex-shrink: 0; }\n\n  /* Modal */\n  .modal-overlay {\n    display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;\n    background: rgba(0,0,0,.7); z-index: 100; align-items: center; justify-content: center;\n  }\n  .modal-overlay.show { display: flex; }\n  .modal {\n    background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;\n    padding: 24px; max-width: 550px; width: 100%; max-height: 90vh; overflow-y: auto;\n    margin: 20px;\n  }\n  .modal h3 { margin-bottom: 16px; font-size: 18px; }\n  .modal .form-group label { font-size: 12px; font-weight: 500; }\n\n  /* Tabs */\n  .tabs { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 1px solid var(--border); }\n  .tab {\n    padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent;\n    font-size: 14px; color: var(--text-muted); transition: all .15s;\n  }\n  .tab:hover { color: var(--text); }\n  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }\n\n  /* Toast */\n  .toast {\n    position: fixed; top: 20px; right: 20px; z-index: 200;\n    padding: 12px 20px; border-radius: 8px; font-size: 14px; color: #fff;\n    transform: translateX(120%); transition: transform .3s ease;\n  }\n  .toast.show { transform: translateX(0); }\n  .toast-success { background: #238636; }\n  .toast-error { background: #da3633; }\n\n  /* Responsive */\n  @media (max-width: 600px) {\n    .provider-card { flex-wrap: wrap; }\n    .provider-actions { width: 100%; justify-content: flex-end; }\n    .form-row { flex-direction: column; }\n  }\n</style>\n</head>\n<body>\n<div class=\"container\">\n  <!-- ========== Login Screen ========== -->\n  <div id=\"login-screen\">\n    <div class=\"header\">\n      <h1>🔑 AI API 统一代理</h1>\n      <p>配置管理面板 <span class=\"badge\">Admin</span></p>\n    </div>\n    <div class=\"card\">\n      <h2>管理员登录</h2>\n      <form id=\"login-form\">\n        <div class=\"form-group\">\n          <label for=\"login-password\">管理密码</label>\n          <input type=\"password\" id=\"login-password\" placeholder=\"请输入密码\" autofocus>\n        </div>\n        <div id=\"login-error\" class=\"error\"></div>\n        <button type=\"submit\" class=\"btn btn-primary\" style=\"width:100%;margin-top:8px;\">登 录</button>\n      </form>\n      <p style=\"margin-top:12px;font-size:12px;color:var(--text-muted);\">\n        首次使用？输入新密码即可设置管理密码。\n      </p>\n    </div>\n  </div>\n\n  <!-- ========== Main Screen ========== -->\n  <div id=\"main-screen\" style=\"display:none;\">\n    <div class=\"header\">\n      <h1>🔑 AI API 统一代理</h1>\n      <p>配置管理面板 <span class=\"badge\">Admin</span></p>\n    </div>\n\n    <div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;\">\n      <h2 style=\"font-size:18px;\">API 提供商</h2>\n      <div style=\"display:flex;gap:8px;\">\n        <button class=\"btn btn-primary\" onclick=\"showAddModal()\">+ 添加提供商</button>\n        <button class=\"btn\" onclick=\"showChangePassword()\" title=\"修改密码\">🔒</button>\n        <button class=\"btn btn-danger btn-sm\" onclick=\"logout()\">退出</button>\n      </div>\n    </div>\n\n    <!-- Client API Key Card -->\n    <div class=\"card\" style=\"margin-bottom:20px;\">\n      <div style=\"display:flex;justify-content:space-between;align-items:center;\">\n        <div>\n          <strong style=\"font-size:15px;\">🔑 客户端 API Key</strong>\n          <span style=\"font-size:12px;color:var(--text-muted);margin-left:8px;\">用于调用 /v1/* 接口</span>\n        </div>\n        <div style=\"display:flex;gap:8px;\" id=\"apikey-actions\">\n          <button class=\"btn btn-sm\" onclick=\"generateApiKey()\" id=\"btn-generate-key\">🎲 随机生成</button>\n          <button class=\"btn btn-sm\" onclick=\"showSetApiKey()\">✏️ 自行设置</button>\n        </div>\n      </div>\n      <div id=\"apikey-display\" style=\"margin-top:10px;font-size:13px;color:var(--text-muted);\">\n        加载中...\n      </div>\n      <div id=\"apikey-input-row\" style=\"display:none;margin-top:10px;gap:8px;align-items:center;\">\n        <input type=\"text\" id=\"apikey-input\" placeholder=\"输入 API Key（至少8位）\" style=\"flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);font-size:13px;\">\n        <button class=\"btn btn-primary btn-sm\" onclick=\"saveApiKey()\">💾 保存</button>\n        <button class=\"btn btn-sm\" onclick=\"cancelSetApiKey()\">取消</button>\n      </div>\n      <div id=\"apikey-full-display\" style=\"display:none;margin-top:10px;padding:10px;background:var(--bg-input);border-radius:6px;font-family:monospace;font-size:13px;word-break:break-all;\">\n        <div style=\"display:flex;justify-content:space-between;align-items:center;\">\n          <span id=\"apikey-full-text\" style=\"color:var(--success);\"></span>\n          <button class=\"btn btn-sm\" onclick=\"copyApiKey()\">📋 复制</button>\n        </div>\n        <span style=\"font-size:11px;color:var(--warning);\">⚠️ 此密钥仅显示一次，请立即复制保存</span>\n      </div>\n      <div style=\"display:flex;gap:8px;margin-top:8px;\" id=\"apikey-secondary-actions\">\n        <button class=\"btn btn-sm\" style=\"color:var(--danger);font-size:11px;\" onclick=\"deleteApiKey()\" id=\"btn-delete-key\" style=\"display:none;\">🗑 删除密钥（公开访问）</button>\n      </div>\n    </div>\n\n    <div id=\"provider-list\" class=\"provider-list\">\n      <div class=\"card\" style=\"text-align:center;color:var(--text-muted);\">加载中...</div>\n    </div>\n  </div>\n</div>\n\n<!-- ========== Add/Edit Modal ========== -->\n<div id=\"provider-modal\" class=\"modal-overlay\">\n  <div class=\"modal\">\n    <h3 id=\"modal-title\">添加提供商</h3>\n    <form id=\"provider-form\">\n      <input type=\"hidden\" id=\"prov-id\">\n      <div class=\"form-group\">\n        <label>提供商类型 *</label>\n        <select id=\"prov-type\" required onchange=\"onTypeChange()\">\n          <option value=\"\">请选择...</option>\n          <option value=\"vertex_ai\">Google Vertex AI</option>\n          <option value=\"google_ai_studio\">Google AI Studio</option>\n          <option value=\"openai\">OpenAI 官方</option>\n        </select>\n      </div>\n      <div class=\"form-group\">\n        <label>名称 *</label>\n        <input type=\"text\" id=\"prov-name\" placeholder=\"如：Vertex AI Primary\" required>\n      </div>\n      <div class=\"form-group\">\n        <label>提供商 ID *</label>\n        <input type=\"text\" id=\"prov-id-display\" placeholder=\"如：vertex-1\" required>\n      </div>\n\n      <!-- Vertex AI fields -->\n      <div id=\"fields-vertex\" class=\"type-fields\" style=\"display:none;\">\n        <div class=\"form-row\">\n          <div class=\"form-group\">\n            <label>项目 ID *</label>\n            <input type=\"text\" id=\"v-project-id\" placeholder=\"Google Cloud Project ID\">\n          </div>\n          <div class=\"form-group\">\n            <label>区域</label>\n            <input type=\"text\" id=\"v-location\" placeholder=\"us-central1\" value=\"us-central1\">\n          </div>\n        </div>\n        <div class=\"form-group\">\n          <label>服务账号邮箱 *</label>\n          <input type=\"text\" id=\"v-sa-email\" placeholder=\"xxx@yyy.iam.gserviceaccount.com\">\n        </div>\n        <div class=\"form-group\">\n          <label>私钥 (PEM) *</label>\n          <textarea id=\"v-private-key\" placeholder=\"-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----\"></textarea>\n        </div>\n      </div>\n\n      <!-- AI Studio / OpenAI fields -->\n      <div id=\"fields-apikey\" class=\"type-fields\" style=\"display:none;\">\n        <div class=\"form-group\">\n          <label>API Key *</label>\n          <input type=\"password\" id=\"f-api-key\" placeholder=\"输入 API Key\">\n        </div>\n      </div>\n\n      <!-- OpenAI extra fields -->\n      <div id=\"fields-openai-extra\" class=\"type-fields\" style=\"display:none;\">\n        <div class=\"form-group\">\n          <label>自定义 Base URL（可选）</label>\n          <input type=\"text\" id=\"o-base-url\" placeholder=\"https://api.openai.com/v1\">\n        </div>\n      </div>\n\n      <!-- Common fields -->\n      <div class=\"form-group\" style=\"font-size:12px;color:var(--text-muted);padding:8px 0;\">\n        💡 模型列表将自动从提供商 API 获取，无需手动配置。\n      </div>\n      <div class=\"form-row\">\n        <div class=\"form-group\">\n          <label>权重</label>\n          <input type=\"number\" id=\"prov-weight\" value=\"1\" min=\"0\" max=\"100\">\n        </div>\n        <div class=\"form-group\" style=\"display:flex;align-items:flex-end;gap:12px;\">\n          <label style=\"margin-bottom:0;\">\n            <input type=\"checkbox\" id=\"prov-enabled\" checked> 启用\n          </label>\n        </div>\n      </div>\n\n      <div id=\"modal-error\" class=\"error\"></div>\n      <div style=\"display:flex;gap:8px;margin-top:16px;justify-content:flex-end;\">\n        <button type=\"button\" class=\"btn\" onclick=\"closeModal()\">取消</button>\n        <button type=\"submit\" class=\"btn btn-primary\">保 存</button>\n      </div>\n    </form>\n  </div>\n</div>\n\n<!-- ========== Change Password Modal ========== -->\n<div id=\"password-modal\" class=\"modal-overlay\">\n  <div class=\"modal\">\n    <h3>修改管理密码</h3>\n    <form id=\"password-form\">\n      <div class=\"form-group\">\n        <label>当前密码</label>\n        <input type=\"password\" id=\"cp-current\" required>\n      </div>\n      <div class=\"form-group\">\n        <label>新密码（至少6位）</label>\n        <input type=\"password\" id=\"cp-new\" required minlength=\"6\">\n      </div>\n      <div id=\"cp-error\" class=\"error\"></div>\n      <div style=\"display:flex;gap:8px;margin-top:16px;justify-content:flex-end;\">\n        <button type=\"button\" class=\"btn\" onclick=\"closePwdModal()\">取消</button>\n        <button type=\"submit\" class=\"btn btn-primary\">修改密码</button>\n      </div>\n    </form>\n  </div>\n</div>\n\n<!-- Toast -->\n<div id=\"toast\" class=\"toast\"></div>\n\n<script>\n// ==================== State ====================\nlet authToken = \"\";\nlet providers = [];\nlet editingId = null;\n\n// ==================== Init ====================\ndocument.addEventListener(\"DOMContentLoaded\", () => {\n  const saved = localStorage.getItem(\"admin_token\");\n  if (saved) {\n    authToken = saved;\n    checkAuthAndLoad();\n  }\n});\n\n// ==================== Auth ====================\ndocument.getElementById(\"login-form\").addEventListener(\"submit\", async (e) => {\n  e.preventDefault();\n  const password = document.getElementById(\"login-password\").value;\n  const errEl = document.getElementById(\"login-error\");\n  errEl.classList.remove(\"show\");\n\n  try {\n    const resp = await fetch(\"/admin/auth\", {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({ password }),\n    });\n    const data = await resp.json();\n\n    if (resp.ok && data.token) {\n      authToken = data.token;\n      localStorage.setItem(\"admin_token\", authToken);\n      document.getElementById(\"login-screen\").style.display = \"none\";\n      document.getElementById(\"main-screen\").style.display = \"block\";\n      loadProviders();\n      loadApiKey();\n      if (data.message) showToast(data.message, \"success\");\n    } else {\n      errEl.textContent = data.error || \"登录失败\";\n      errEl.classList.add(\"show\");\n      if (data.banned) {\n        errEl.textContent += `（封禁剩余 ${Math.ceil(data.remainingSeconds/60)} 分钟）`;\n      } else if (data.remaining) {\n        errEl.textContent += `（剩余 ${data.remaining} 次尝试）`;\n      }\n    }\n  } catch (err) {\n    errEl.textContent = \"网络错误: \" + err.message;\n    errEl.classList.add(\"show\");\n  }\n});\n\nasync function checkAuthAndLoad() {\n  try {\n    const resp = await fetch(\"/admin/check\", {\n      headers: { Authorization: `Bearer ${authToken}` },\n    });\n    if (resp.ok) {\n      document.getElementById(\"login-screen\").style.display = \"none\";\n      document.getElementById(\"main-screen\").style.display = \"block\";\n      loadProviders();\n      loadApiKey();\n    } else {\n      localStorage.removeItem(\"admin_token\");\n      authToken = \"\";\n    }\n  } catch {\n    // stay on login screen\n  }\n}\n\nfunction logout() {\n  localStorage.removeItem(\"admin_token\");\n  authToken = \"\";\n  document.getElementById(\"login-screen\").style.display = \"\";\n  document.getElementById(\"main-screen\").style.display = \"none\";\n  showToast(\"已退出登录\", \"success\");\n}\n\n// ==================== Provider List ====================\nasync function loadProviders() {\n  try {\n    const resp = await fetch(\"/admin/providers\", {\n      headers: { Authorization: `Bearer ${authToken}` },\n    });\n    if (resp.status === 401) { logout(); return; }\n    providers = await resp.json();\n    renderProviderList();\n  } catch (err) {\n    console.error(\"Failed to load providers:\", err);\n  }\n}\n\nfunction renderProviderList() {\n  const container = document.getElementById(\"provider-list\");\n  if (!providers.length) {\n    container.innerHTML = `<div class=\"card\" style=\"text-align:center;color:var(--text-muted);\">\n      暂无提供商。点击\"添加提供商\"开始配置。\n    </div>`;\n    return;\n  }\n\n  const typeLabels = {\n    vertex_ai: \"Vertex AI\",\n    google_ai_studio: \"AI Studio\",\n    openai: \"OpenAI\",\n  };\n\n  container.innerHTML = providers.map((p) => {\n    const typeClass = \"type-\" + p.type;\n    const typeLabel = typeLabels[p.type] || p.type;\n    const disabledClass = p.enabled ? \"\" : \"disabled\";\n    const statusBadge = p.enabled\n      ? `<span style=\"color:var(--success);font-size:12px;\">● 启用</span>`\n      : `<span style=\"color:var(--text-muted);font-size:12px;\">○ 禁用</span>`;\n    const modelsPreview = \"自动从 API 获取\";\n\n    return `<div class=\"provider-card ${disabledClass}\">\n      <span class=\"provider-type ${typeClass}\">${typeLabel}</span>\n      <div class=\"provider-info\">\n        <div class=\"name\">${esc(p.name)} ${statusBadge}</div>\n        <div class=\"models\">${esc(modelsPreview)}</div>\n      </div>\n      <div class=\"provider-actions\">\n        <button class=\"btn btn-sm\" onclick=\"editProvider('${escAttr(p.id)}')\">✏️ 编辑</button>\n        <button class=\"btn btn-sm\" style=\"color:var(--warning);\" onclick=\"toggleProvider('${escAttr(p.id)}')\">\n          ${p.enabled ? \"⏸ 禁用\" : \"▶ 启用\"}\n        </button>\n        <button class=\"btn btn-sm btn-danger\" onclick=\"deleteProvider('${escAttr(p.id)}')\">🗑</button>\n      </div>\n    </div>`;\n  }).join(\"\");\n}\n\nfunction esc(s) {\n  return String(s).replace(/&/g,\"&amp;\").replace(/</g,\"&lt;\").replace(/>/g,\"&gt;\");\n}\n\nfunction escAttr(s) {\n  return String(s).replace(/'/g,\"&#39;\").replace(/\"/g,\"&quot;\");\n}\n\n// ==================== CRUD Operations ====================\nfunction showAddModal() {\n  editingId = null;\n  document.getElementById(\"modal-title\").textContent = \"添加提供商\";\n  document.getElementById(\"provider-form\").reset();\n  document.getElementById(\"prov-id\").value = \"\";\n  document.getElementById(\"prov-id-display\").value = \"\";\n  document.getElementById(\"prov-id-display\").disabled = false;\n  document.getElementById(\"prov-type\").disabled = false;\n  document.getElementById(\"prov-enabled\").checked = true;\n  document.getElementById(\"prov-weight\").value = 1;\n  hideAllTypeFields();\n  document.getElementById(\"modal-error\").classList.remove(\"show\");\n  document.getElementById(\"provider-modal\").classList.add(\"show\");\n}\n\nfunction editProvider(id) {\n  const p = providers.find(x => x.id === id);\n  if (!p) return;\n\n  editingId = id;\n  document.getElementById(\"modal-title\").textContent = \"编辑提供商: \" + p.name;\n  document.getElementById(\"prov-id\").value = p.id;\n  document.getElementById(\"prov-id-display\").value = p.id;\n  document.getElementById(\"prov-id-display\").disabled = true;\n  document.getElementById(\"prov-type\").value = p.type;\n  document.getElementById(\"prov-type\").disabled = true;\n  document.getElementById(\"prov-name\").value = p.name;\n  document.getElementById(\"prov-weight\").value = p.weight || 1;\n  document.getElementById(\"prov-enabled\").checked = p.enabled;\n\n  hideAllTypeFields();\n  onTypeChange();\n\n  // Fill type-specific fields (leave sensitive fields empty - user re-enters if changing)\n  const cfg = p.config || {};\n  if (p.type === \"vertex_ai\") {\n    document.getElementById(\"v-project-id\").value = cfg.projectId || \"\";\n    document.getElementById(\"v-location\").value = cfg.location || \"us-central1\";\n    document.getElementById(\"v-sa-email\").value = cfg.serviceAccountEmail || \"\";\n    document.getElementById(\"v-private-key\").value = \"\";  // Never show - user re-enters to change\n    document.getElementById(\"v-private-key\").placeholder = \"（已设置，留空则不修改）\";\n  } else if (p.type === \"google_ai_studio\") {\n    document.getElementById(\"f-api-key\").value = \"\";  // Never show\n    document.getElementById(\"f-api-key\").placeholder = \"（已设置，留空则不修改）\";\n  } else if (p.type === \"openai\") {\n    document.getElementById(\"f-api-key\").value = \"\";  // Never show\n    document.getElementById(\"f-api-key\").placeholder = \"（已设置，留空则不修改）\";\n    document.getElementById(\"o-base-url\").value = cfg.baseUrl || \"\";\n  }\n\n  document.getElementById(\"modal-error\").classList.remove(\"show\");\n  document.getElementById(\"provider-modal\").classList.add(\"show\");\n}\n\nfunction closeModal() {\n  document.getElementById(\"provider-modal\").classList.remove(\"show\");\n}\n\nfunction hideAllTypeFields() {\n  document.querySelectorAll(\".type-fields\").forEach(el => el.style.display = \"none\");\n}\n\nfunction onTypeChange() {\n  hideAllTypeFields();\n  const type = document.getElementById(\"prov-type\").value;\n  if (type === \"vertex_ai\") {\n    document.getElementById(\"fields-vertex\").style.display = \"\";\n  } else if (type === \"google_ai_studio\") {\n    document.getElementById(\"fields-apikey\").style.display = \"\";\n  } else if (type === \"openai\") {\n    document.getElementById(\"fields-apikey\").style.display = \"\";\n    document.getElementById(\"fields-openai-extra\").style.display = \"\";\n  }\n}\n\ndocument.getElementById(\"provider-form\").addEventListener(\"submit\", async (e) => {\n  e.preventDefault();\n  const errEl = document.getElementById(\"modal-error\");\n  errEl.classList.remove(\"show\");\n\n  const type = document.getElementById(\"prov-type\").value;\n  const name = document.getElementById(\"prov-name\").value.trim();\n  let id = document.getElementById(\"prov-id-display\").value.trim() || document.getElementById(\"prov-id\").value.trim();\n\n  if (!type || !name || !id) {\n    errEl.textContent = \"请填写所有必填字段\";\n    errEl.classList.add(\"show\");\n    return;\n  }\n\n  // Generate ID if adding new\n  if (!editingId) {\n    id = id || (type + \"-\" + Date.now());\n  }\n\n  // Build config\n  const config = {};\n  if (type === \"vertex_ai\") {\n    config.projectId = document.getElementById(\"v-project-id\").value.trim();\n    config.location = document.getElementById(\"v-location\").value.trim() || \"us-central1\";\n    config.serviceAccountEmail = document.getElementById(\"v-sa-email\").value.trim();\n    config.privateKey = document.getElementById(\"v-private-key\").value.trim();\n  } else if (type === \"google_ai_studio\") {\n    config.apiKey = document.getElementById(\"f-api-key\").value.trim();\n  } else if (type === \"openai\") {\n    config.apiKey = document.getElementById(\"f-api-key\").value.trim();\n    config.baseUrl = document.getElementById(\"o-base-url\").value.trim() || \"\";\n  }\n\n  const body = {\n    id,\n    type,\n    name,\n    enabled: document.getElementById(\"prov-enabled\").checked,\n    weight: parseInt(document.getElementById(\"prov-weight\").value) || 1,\n    config,\n    models: [],  // Models are auto-fetched from provider API\n  };\n\n  try {\n    const method = editingId ? \"PUT\" : \"POST\";\n    const url = editingId ? `/admin/providers/${encodeURIComponent(editingId)}` : \"/admin/providers\";\n    const resp = await fetch(url, {\n      method,\n      headers: {\n        \"Content-Type\": \"application/json\",\n        Authorization: `Bearer ${authToken}`,\n      },\n      body: JSON.stringify(body),\n    });\n\n    if (resp.ok) {\n      closeModal();\n      loadProviders();\n      showToast(editingId ? \"提供商已更新\" : \"提供商已添加\", \"success\");\n    } else {\n      const data = await resp.json();\n      errEl.textContent = data.error || \"保存失败\";\n      errEl.classList.add(\"show\");\n    }\n  } catch (err) {\n    errEl.textContent = \"网络错误: \" + err.message;\n    errEl.classList.add(\"show\");\n  }\n});\n\nasync function toggleProvider(id) {\n  const p = providers.find(x => x.id === id);\n  if (!p) return;\n  try {\n    const resp = await fetch(`/admin/providers/${encodeURIComponent(id)}`, {\n      method: \"PUT\",\n      headers: {\n        \"Content-Type\": \"application/json\",\n        Authorization: `Bearer ${authToken}`,\n      },\n      body: JSON.stringify({ ...p, enabled: !p.enabled, config: p.config }),\n    });\n    if (resp.ok) { loadProviders(); showToast(p.enabled ? \"已禁用\" : \"已启用\", \"success\"); }\n  } catch (err) {\n    showToast(\"操作失败: \" + err.message, \"error\");\n  }\n}\n\nasync function deleteProvider(id) {\n  const p = providers.find(x => x.id === id);\n  if (!p) return;\n  if (!confirm(`确定要删除提供商 \"${p.name}\" 吗？\\\\n此操作不可撤销。`)) return;\n\n  try {\n    const resp = await fetch(`/admin/providers/${encodeURIComponent(id)}`, {\n      method: \"DELETE\",\n      headers: { Authorization: `Bearer ${authToken}` },\n    });\n    if (resp.ok) { loadProviders(); showToast(\"已删除\", \"success\"); }\n  } catch (err) {\n    showToast(\"删除失败: \" + err.message, \"error\");\n  }\n}\n\n// ==================== Change Password ====================\nfunction showChangePassword() {\n  document.getElementById(\"password-modal\").classList.add(\"show\");\n}\nfunction closePwdModal() {\n  document.getElementById(\"password-modal\").classList.remove(\"show\");\n}\ndocument.getElementById(\"password-form\").addEventListener(\"submit\", async (e) => {\n  e.preventDefault();\n  const errEl = document.getElementById(\"cp-error\");\n  errEl.classList.remove(\"show\");\n\n  try {\n    const resp = await fetch(\"/admin/change-password\", {\n      method: \"POST\",\n      headers: {\n        \"Content-Type\": \"application/json\",\n        Authorization: `Bearer ${authToken}`,\n      },\n      body: JSON.stringify({\n        currentPassword: document.getElementById(\"cp-current\").value,\n        newPassword: document.getElementById(\"cp-new\").value,\n      }),\n    });\n    const data = await resp.json();\n    if (resp.ok) {\n      authToken = data.token;\n      localStorage.setItem(\"admin_token\", authToken);\n      closePwdModal();\n      showToast(\"密码已修改\", \"success\");\n    } else {\n      errEl.textContent = data.error || \"修改失败\";\n      errEl.classList.add(\"show\");\n    }\n  } catch (err) {\n    errEl.textContent = \"网络错误: \" + err.message;\n    errEl.classList.add(\"show\");\n  }\n});\n\n// ==================== Toast ====================\nlet toastTimer;\nfunction showToast(msg, type) {\n  const toast = document.getElementById(\"toast\");\n  toast.textContent = msg;\n  toast.className = \"toast toast-\" + type + \" show\";\n  clearTimeout(toastTimer);\n  toastTimer = setTimeout(() => { toast.classList.remove(\"show\"); }, 3000);\n}\n\n// ==================== Client API Key ====================\nasync function loadApiKey() {\n  try {\n    const resp = await fetch(\"/admin/client-key\", {\n      headers: { Authorization: `Bearer ${authToken}` },\n    });\n    const data = await resp.json();\n    const display = document.getElementById(\"apikey-display\");\n    const deleteBtn = document.getElementById(\"btn-delete-key\");\n    if (data.configured) {\n      display.innerHTML = `\n        <div style=\"display:flex;align-items:center;gap:8px;flex-wrap:wrap;\">\n          <span>当前密钥：</span>\n          <code style=\"color:var(--accent);\">${esc(data.masked)}</code>\n          <span style=\"color:var(--text-muted);\">(${data.length} 字符)</span>\n          <button class=\"btn btn-sm\" onclick=\"revealApiKey()\" style=\"font-size:11px;\">👁️ 查看</button>\n        </div>`;\n      deleteBtn.style.display = \"\";\n    } else {\n      display.innerHTML = '<span style=\"color:var(--warning);\">⚠️ 未设置密钥 — /v1/* 接口可公开访问</span>';\n      deleteBtn.style.display = \"none\";\n    }\n    document.getElementById(\"apikey-full-display\").style.display = \"none\";\n  } catch (err) {\n    console.error(\"Failed to load API key:\", err);\n  }\n}\n\nasync function revealApiKey() {\n  try {\n    const resp = await fetch(\"/admin/client-key?reveal=true\", {\n      headers: { Authorization: `Bearer ${authToken}` },\n    });\n    const data = await resp.json();\n    if (resp.ok && data.fullKey) {\n      document.getElementById(\"apikey-full-text\").textContent = data.fullKey;\n      document.getElementById(\"apikey-full-display\").style.display = \"\";\n      showToast(\"密钥已显示\", \"success\");\n    }\n  } catch (err) {\n    showToast(\"获取失败: \" + err.message, \"error\");\n  }\n}\n\nasync function generateApiKey() {\n  try {\n    const resp = await fetch(\"/admin/client-key\", {\n      method: \"POST\",\n      headers: {\n        \"Content-Type\": \"application/json\",\n        Authorization: `Bearer ${authToken}`,\n      },\n      body: JSON.stringify({ generate: true }),\n    });\n    const data = await resp.json();\n    if (resp.ok && data.fullKey) {\n      document.getElementById(\"apikey-full-text\").textContent = data.fullKey;\n      document.getElementById(\"apikey-full-display\").style.display = \"\";\n      loadApiKey();\n      showToast(\"密钥已生成\", \"success\");\n    } else {\n      showToast(data.error || \"操作失败\", \"error\");\n    }\n  } catch (err) {\n    showToast(\"操作失败: \" + err.message, \"error\");\n  }\n}\n\nfunction showSetApiKey() {\n  document.getElementById(\"apikey-input-row\").style.display = \"flex\";\n  document.getElementById(\"apikey-input\").value = \"\";\n  document.getElementById(\"apikey-input\").focus();\n}\n\nfunction cancelSetApiKey() {\n  document.getElementById(\"apikey-input-row\").style.display = \"none\";\n  document.getElementById(\"apikey-input\").value = \"\";\n}\n\nasync function saveApiKey() {\n  const key = document.getElementById(\"apikey-input\").value.trim();\n  if (!key || key.length < 8) {\n    showToast(\"API Key 至少需要 8 个字符\", \"error\");\n    return;\n  }\n  try {\n    const resp = await fetch(\"/admin/client-key\", {\n      method: \"POST\",\n      headers: {\n        \"Content-Type\": \"application/json\",\n        Authorization: `Bearer ${authToken}`,\n      },\n      body: JSON.stringify({ key }),\n    });\n    const data = await resp.json();\n    if (resp.ok) {\n      cancelSetApiKey();\n      loadApiKey();\n      showToast(\"密钥已设置\", \"success\");\n    } else {\n      showToast(data.error || \"操作失败\", \"error\");\n    }\n  } catch (err) {\n    showToast(\"操作失败: \" + err.message, \"error\");\n  }\n}\n\nasync function deleteApiKey() {\n  if (!confirm(\"确定要删除客户端 API Key 吗？\\n删除后 /v1/* 接口将无需认证即可访问。\")) return;\n  try {\n    const resp = await fetch(\"/admin/client-key\", {\n      method: \"DELETE\",\n      headers: { Authorization: `Bearer ${authToken}` },\n    });\n    if (resp.ok) {\n      loadApiKey();\n      showToast(\"密钥已删除，接口可公开访问\", \"success\");\n    }\n  } catch (err) {\n    showToast(\"操作失败: \" + err.message, \"error\");\n  }\n}\n\nfunction copyApiKey() {\n  const text = document.getElementById(\"apikey-full-text\").textContent;\n  navigator.clipboard.writeText(text).then(() => {\n    showToast(\"已复制到剪贴板\", \"success\");\n  }).catch(() => {\n    showToast(\"复制失败，请手动选择复制\", \"error\");\n  });\n}\n\n// ==================== Modal click-outside ====================\ndocument.getElementById(\"provider-modal\").addEventListener(\"click\", function(e) {\n  if (e.target === this) closeModal();\n});\ndocument.getElementById(\"password-modal\").addEventListener(\"click\", function(e) {\n  if (e.target === this) closePwdModal();\n});\n</script>\n</body>\n</html>";

// ---- Provider loading ----

async function loadProviders(env) {
  const now = Date.now();
  const version = await getConfigVersion(env);
  if (cachedProviders && cachedProvidersVersion === version &&
      now - cachedProvidersAt < PROVIDERS_CACHE_TTL_MS) {
    return cachedProviders;
  }
  cachedProviders = await listProviders(env);
  cachedProvidersAt = now;
  cachedProvidersVersion = version;
  return cachedProviders;
}

// ---- Model routing ----

/**
 * Find which provider handles a given model.
 * Builds a model→provider map from the aggregated model cache (auto-fetched + configured).
 * Falls back to name-based heuristics for unknown models.
 */
async function findProviderForModel(env, modelId) {
  const providers = await loadProviders(env);
  const enabled = providers.filter((p) => p.enabled);
  if (!enabled.length) return null;

  // 1. Look up from auto-fetched + configured model cache
  const models = await getAggregatedModels(env);
  const found = models.find((m) => m.id === modelId);
  if (found && found._providerId) {
    const provider = enabled.find((p) => p.id === found._providerId);
    if (provider) {
      return { provider, matchedModel: modelId };
    }
  }

  // 2. Configured models (exact match, for providers where auto-fetch fails)
  for (const p of enabled) {
    if ((p.models || []).some((m) => m === modelId)) {
      return { provider: p, matchedModel: modelId };
    }
  }

  // 3. Configured models (prefix match)
  for (const p of enabled) {
    if ((p.models || []).some((m) => modelId.startsWith(m + "/") || modelId.startsWith(m))) {
      return { provider: p, matchedModel: modelId };
    }
  }

  // 4. Heuristic: match by model name prefix
  const prefix = modelId.split("/")[0].toLowerCase();
  let candidateProviders;

  if (["google", "gemini", "publishers"].includes(prefix)) {
    candidateProviders = enabled.filter(
      (p) => p.type === "vertex_ai" || p.type === "google_ai_studio"
    );
  } else if (["gpt", "o1", "o3", "text-embedding", "dall-e", "tts", "whisper"].some(
    (p) => modelId.toLowerCase().startsWith(p)
  )) {
    candidateProviders = enabled.filter((p) => p.type === "openai");
  } else {
    candidateProviders = enabled;
  }

  if (candidateProviders.length > 0) {
    return { provider: candidateProviders[0], matchedModel: modelId };
  }

  if (enabled.length > 0) {
    return { provider: enabled[0], matchedModel: modelId };
  }

  return null;
}

// ---- Model list aggregation ----

async function getAggregatedModels(env) {
  const now = Date.now();
  const version = await getConfigVersion(env);
  if (cachedModels && cachedModelsVersion === version &&
      now - cachedModelsAt < MODELS_CACHE_TTL_MS) {
    return cachedModels;
  }

  const providers = await loadProviders(env);
  const seen = new Set();
  const models = [];

  for (const p of providers) {
    if (!p.enabled) continue;

    // Configured models (explicit list from provider config)
    for (const m of p.models || []) {
      if (!seen.has(m)) {
        seen.add(m);
        models.push({
          id: m, object: "model", created: 0,
          owned_by: mapTypeToOwner(p.type),
          _providerId: p.id,
        });
      }
    }

    // Auto-fetch live models from provider API
    const handler = PROVIDER_HANDLERS[p.type];
    if (handler && handler.fetchModelList) {
      try {
        const liveModels = await handler.fetchModelList(env, p.config);
        for (const m of liveModels) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            models.push({ ...m, _providerId: p.id });
          }
        }
      } catch {
        // Silently skip unreachable providers
      }
    }
  }

  cachedModels = models;
  cachedModelsAt = now;
  cachedModelsVersion = version;
  return models;
}

function mapTypeToOwner(type) {
  const map = {
    vertex_ai: "google",
    google_ai_studio: "google",
    openai: "openai",
  };
  return map[type] || type;
}

// ---- Chat completions proxy ----

async function handleChatCompletions(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: { message: "Invalid JSON body" } }, 400);
  }

  const modelId = String(body.model || "").trim();
  if (!modelId) {
    return json(
      { error: { message: "model is required", type: "invalid_request_error" } },
      400
    );
  }

  const result = await findProviderForModel(env, modelId);
  if (!result) {
    return json(
      {
        error: {
          message: `No enabled provider found for model: ${modelId}. Configure providers in the admin panel.`,
          type: "invalid_request_error",
        },
      },
      400
    );
  }

  const { provider } = result;
  const handler = PROVIDER_HANDLERS[provider.type];
  if (!handler) {
    return json({ error: { message: `Unknown provider type: ${provider.type}` } }, 500);
  }

  body.model = result.matchedModel;

  // Build new request with modified body; remove stale Content-Length
  const newHeaders = new Headers(request.headers);
  newHeaders.delete("content-length");
  const newRequest = new Request(request.url, {
    method: "POST",
    headers: newHeaders,
    body: JSON.stringify(body),
  });

  try {
    const suffix = "/chat/completions";
    const upstreamResp = await handler.proxyRequest(newRequest, env, provider, suffix);
    return upstreamResp;
  } catch (err) {
    console.error(`Provider ${provider.id} error:`, err.message);
    return json(
      {
        error: {
          message: `Upstream request failed: ${err.message}`,
          type: "server_error",
        },
      },
      502
    );
  }
}

// ---- Generic /v1/* proxy ----

async function handleGenericV1Route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const suffix = path.slice("/v1".length);

  let provider = null;
  if (request.method === "POST" || request.method === "PUT") {
    try {
      const cloned = request.clone();
      const body = await cloned.json().catch(() => null);
      if (body && body.model) {
        const result = await findProviderForModel(env, String(body.model).trim());
        if (result) {
          provider = result.provider;
          body.model = result.matchedModel;
          const v1Headers = new Headers(request.headers);
          v1Headers.delete("content-length");
          request = new Request(request.url, {
            method: request.method,
            headers: v1Headers,
            body: JSON.stringify(body),
          });
        }
      }
    } catch {
      // Use original request
    }
  }

  if (!provider) {
    const providers = await loadProviders(env);
    const enabled = providers.filter((p) => p.enabled);
    if (!enabled.length) {
      return json(
        { error: { message: "No enabled providers configured" } },
        503
      );
    }
    provider = enabled[0];
  }

  const handler = PROVIDER_HANDLERS[provider.type];
  if (!handler) {
    return json({ error: { message: `Unknown provider type: ${provider.type}` } }, 500);
  }

  try {
    const upstreamResp = await handler.proxyRequest(request, env, provider, suffix);
    return upstreamResp;
  } catch (err) {
    console.error(`Provider ${provider.id} error:`, err.message);
    return json(
      { error: { message: `Upstream request failed: ${err.message}`, type: "server_error" } },
      502
    );
  }
}

// ---- Client auth (optional, configurable via admin UI) ----

async function checkClientAuth(request, env) {
  // 1. Check KV-stored client API key (set via admin UI)
  const kvKey = await getClientApiKey(env);
  if (kvKey) {
    const auth = request.headers.get("Authorization") || "";
    return auth === `Bearer ${kvKey}`;
  }

  // 2. Fallback to env.OPENAI_API_KEY (set via wrangler secret)
  if (env.OPENAI_API_KEY) {
    const auth = request.headers.get("Authorization") || "";
    return auth === `Bearer ${env.OPENAI_API_KEY}`;
  }

  // 3. No key configured → allow all requests (public)
  return true;
}

// ---- Main fetch handler ----

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight is exempt from auth
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    // ---- Admin routes ----
    if (path.startsWith("/admin/")) {
      try {
        const resp = await handleAdminRoutes(request, env);
        return withCors(resp, request);
      } catch (err) {
        console.error("Admin error:", err.message);
        return withCors(json({ error: err.message }, 500), request);
      }
    }

    // ---- Root: Admin UI ----
    if (path === "/" || path === "/index.html") {
      return withCors(
        new Response(ADMIN_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
        request
      );
    }

    // ---- Health check ----
    if (path === "/health") {
      const providers = await loadProviders(env).catch(() => []);
      const enabled = providers.filter((p) => p.enabled).length;
      return withCors(
        json({
          ok: true,
          message: "AI API Multi-Provider Proxy is running",
          providers: enabled,
          routes: [
            "/",
            "/health",
            "/v1/chat/completions",
            "/v1/models",
            "/v1/models/{model}",
          ],
        }),
        request
      );
    }

    // ---- Client auth for /v1/* routes (optional) ----
    if (path.startsWith("/v1/")) {
      if (!(await checkClientAuth(request, env))) {
        return withCors(
          json({ error: { message: "Unauthorized" } }, 401),
          request
        );
      }
    }

    // ---- /v1/models ----
    if (path === "/v1/models" || path.startsWith("/v1/models/")) {
      try {
        const modelId = path.startsWith("/v1/models/")
          ? decodeURIComponent(path.slice("/v1/models/".length))
          : "";

        const models = await getAggregatedModels(env);

        if (modelId) {
          const found = models.find((m) => m.id === modelId);
          if (!found) {
            return withCors(
              json(
                { error: { message: `Model not found: ${modelId}`, type: "invalid_request_error" } },
                404
              ),
              request
            );
          }
          return withCors(json(found), request);
        }

        return withCors(json({ object: "list", data: models }), request);
      } catch (err) {
        console.error("Models error:", err.message);
        return withCors(
          json({ error: { message: err.message || "Failed to list models", type: "server_error" } }, 500),
          request
        );
      }
    }

    // ---- /v1/chat/completions ----
    if (path === "/v1/chat/completions" && request.method === "POST") {
      try {
        const resp = await handleChatCompletions(request, env);
        return withCors(resp, request);
      } catch (err) {
        console.error("Chat completions error:", err.message);
        return withCors(
          json(
            { error: { message: err.message || "Chat completion failed", type: "server_error" } },
            502
          ),
          request
        );
      }
    }

    // ---- Generic /v1/* routes ----
    if (path.startsWith("/v1/")) {
      try {
        const resp = await handleGenericV1Route(request, env);
        return withCors(resp, request);
      } catch (err) {
        console.error("V1 route error:", err.message);
        return withCors(
          json(
            { error: { message: err.message || "Request failed", type: "server_error" } },
            502
          ),
          request
        );
      }
    }

    // ---- 404 ----
    return withCors(
      json({ error: { message: "Not Found" } }, 404),
      request
    );
  },
};
