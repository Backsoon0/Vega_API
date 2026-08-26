<script lang="ts">
  import { createProvider, updateProvider } from "$lib/api";
  import type { Provider } from "$lib/api";
  import { toasts } from "$lib/toast-store";
  import { Upload, Database, Globe, Key, AlertCircle, Lock, ShieldCheck, KeyRound, Brain } from "lucide-svelte";
  import Spinner from "$lib/Spinner.svelte";
  import Alert from "$lib/Alert.svelte";

  interface Props {
    editing?: Provider | null;
    onsave: () => void;
  }

  let { editing = null, onsave }: Props = $props();

  let type = $state("vertex_ai");
  let name = $state("");
  let provId = $state("");
  let enabled = $state(true);
  let weight = $state(1);
  let loading = $state(false);
  let error = $state("");

  // Vertex AI fields
  let vAuthMode = $state("service_account");
  let vProjectId = $state("");
  let vLocation = $state("us-central1");
  let vSaEmail = $state("");
  let vPrivateKey = $state("");
  let vApiKey = $state("");

  // API Key fields (AI Studio / OpenAI / Anthropic)
  let fApiKey = $state("");
  let oBaseUrl = $state("");

  // Import status
  let importStatus = $state("");
  let importOk = $state(false);

  const typeOptions = [
    { value: "vertex_ai", label: "Google Vertex AI", icon: Database },
    { value: "google_ai_studio", label: "Google AI Studio", icon: Globe },
    { value: "openai", label: "OpenAI 官方", icon: Key },
    { value: "anthropic", label: "Anthropic", icon: Brain },
  ];

  const vertexAuthOptions = [
    { value: "service_account", label: "服务账号", icon: ShieldCheck, desc: "JSON 密钥文件或手动输入 PEM" },
    { value: "api_key", label: "API 密钥", icon: KeyRound, desc: "使用 Vertex AI API 密钥" },
  ];

  $effect(() => {
    if (editing) {
      type = editing.type;
      name = editing.name;
      provId = editing.id;
      enabled = editing.enabled;
      weight = editing.weight;
      const cfg = editing.config || {};
      if (editing.type === "vertex_ai") {
        vProjectId = cfg.projectId || "";
        vLocation = cfg.location || "us-central1";
        vSaEmail = cfg.serviceAccountEmail || "";
        vPrivateKey = "";
        vApiKey = "";
        if (cfg.apiKey) {
          vAuthMode = "api_key";
        } else {
          vAuthMode = "service_account";
        }
      } else if (editing.type === "google_ai_studio" || editing.type === "openai" || editing.type === "anthropic") {
        fApiKey = "";
        if (editing.type === "openai") oBaseUrl = cfg.baseUrl || "";
      }
    } else {
      reset();
    }
  });

  function reset() {
    type = "vertex_ai";
    name = "";
    provId = "";
    enabled = true;
    weight = 1;
    vAuthMode = "service_account";
    vProjectId = "";
    vLocation = "us-central1";
    vSaEmail = "";
    vPrivateKey = "";
    vApiKey = "";
    fApiKey = "";
    oBaseUrl = "";
    error = "";
    importStatus = "";
    importOk = false;
  }

  function getConfig(): Record<string, string> {
    if (type === "vertex_ai") {
      const cfg: Record<string, string> = {
        projectId: vProjectId.trim(),
        location: vLocation.trim() || "us-central1",
      };
      if (vAuthMode === "api_key") {
        cfg.apiKey = vApiKey.trim();
      } else {
        cfg.serviceAccountEmail = vSaEmail.trim();
        cfg.privateKey = vPrivateKey.trim();
      }
      return cfg;
    } else if (type === "google_ai_studio" || type === "anthropic") {
      return { apiKey: fApiKey.trim() };
    } else {
      const cfg: Record<string, string> = { apiKey: fApiKey.trim() };
      if (oBaseUrl.trim()) cfg.baseUrl = oBaseUrl.trim();
      return cfg;
    }
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    error = "";

    if (!type || !name.trim() || !provId.trim()) {
      error = "请填写所有必填字段";
      return;
    }

    const config = getConfig();
    const body = {
      id: provId.trim(),
      type,
      name: name.trim(),
      enabled,
      weight,
      config,
      models: [],
    };

    loading = true;
    try {
      if (editing) {
        await updateProvider(editing.id, body);
      } else {
        await createProvider(body);
      }
      onsave();
      reset();
    } catch (err: any) {
      error = err.message || "保存失败";
      toasts.show(error, 'error');
    } finally {
      loading = false;
    }
  }

  function importFromJson() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (data.type !== "service_account") {
          importStatus = "不是有效的服务账号密钥文件 (缺少 type: service_account)";
          importOk = false;
          return;
        }
        if (data.project_id) vProjectId = data.project_id;
        if (data.client_email) vSaEmail = data.client_email;
        if (data.private_key) vPrivateKey = data.private_key;
        importStatus = `已导入项目: ${data.project_id || "未知"}`;
        importOk = true;
      } catch (err: any) {
        importStatus = `JSON 解析失败: ${err.message}`;
        importOk = false;
      }
    };
    input.click();
  }
</script>

<form onsubmit={handleSubmit} class="space-y-5">
  <!-- Provider Type — visual radio cards -->
  <fieldset>
    <legend style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--fg-2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">
      提供商类型 <span style="color:var(--danger)">*</span>
      {#if editing}
        <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;background:var(--warning-soft);border:1px solid rgba(245,158,11,.2);color:var(--warning);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">
          <Lock class="w-3 h-3" /> 不可更改
        </span>
      {/if}
    </legend>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:6px">
      {#each typeOptions as opt}
        {@const isSelected = type === opt.value}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <label
          style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:12px;border:1px solid {isSelected ? 'rgba(59,130,246,.4)' : 'var(--b-def)'};background:{isSelected ? 'var(--cta-soft)' : 'var(--input)'};color:{isSelected ? 'var(--fg)' : 'var(--muted)'};transition:all 150ms;{editing ? (isSelected ? 'cursor:default;border-color:rgba(255,255,255,.12);background:var(--surface);color:var(--fg)' : 'opacity:.3;cursor:not-allowed') : (isSelected ? 'cursor:pointer' : 'hover:cursor:pointer')}"
        >
          <input type="radio" bind:group={type} value={opt.value} disabled={!!editing} class="sr-only" />
          <opt.icon class="w-4 h-4 shrink-0" />
          <span style="font-size:12px;font-weight:500">{opt.label}</span>
        </label>
      {/each}
    </div>
    {#if editing}
      <p style="font-size:11px;color:var(--warning);display:flex;align-items:center;gap:6px;margin-top:8px">
        <Lock class="w-3 h-3 shrink-0" /> 提供商类型创建后无法修改，如需切换类型请删除后重新添加
      </p>
    {/if}
  </fieldset>

  <!-- Name + ID -->
  <div style="display:grid;grid-template-columns:1fr;gap:16px">
    <div class="field" style="margin-bottom:0">
      <label for="pf-name">名称 <span style="color:var(--danger)">*</span></label>
      <input id="pf-name" type="text" class="input" bind:value={name} placeholder="如: Vertex AI Primary" required />
    </div>
    <div class="field" style="margin-bottom:0">
      <label for="pf-id">提供商 ID <span style="color:var(--danger)">*</span></label>
      <input id="pf-id" type="text" class="input" style="font-family:var(--font-mono)" bind:value={provId} placeholder="如: vertex-1" required disabled={!!editing} />
    </div>
  </div>

  <!-- ═══════════ Vertex AI Fields ═══════════ -->
  {#if type === "vertex_ai"}
    <div style="padding:16px 18px;border-radius:14px;background:var(--input);border:1px solid var(--b-def)">
      <span style="font-size:12px;font-weight:600;color:var(--fg-2);text-transform:uppercase;letter-spacing:.06em">Vertex AI 配置</span>

      <!-- Auth Mode Toggle -->
      <fieldset>
        <legend style="font-size:12px;font-weight:600;color:var(--fg-2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">认证方式 <span style="color:var(--danger)">*</span></legend>
        <div style="display:grid;grid-template-columns:1fr;gap:8px">
          {#each vertexAuthOptions as opt}
            {@const isSelected = vAuthMode === opt.value}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <label style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:12px;border:1px solid {isSelected ? 'rgba(59,130,246,.4)' : 'var(--b-def)'};background:{isSelected ? 'var(--cta-soft)' : 'var(--surface)'};color:{isSelected ? 'var(--fg)' : 'var(--muted)'};transition:all 150ms">
              <input type="radio" bind:group={vAuthMode} value={opt.value} class="sr-only" />
              <opt.icon class="w-4 h-4 shrink-0" />
              <div style="display:flex;flex-direction:column;gap:2px">
                <span style="font-size:12px;font-weight:500">{opt.label}</span>
                <span style="font-size:10px;color:var(--muted);line-height:1.3">{opt.desc}</span>
              </div>
            </label>
          {/each}
        </div>
      </fieldset>

      <!-- Project ID + Location -->
      <div style="display:grid;grid-template-columns:1fr;gap:16px">
        <div class="field" style="margin-bottom:0">
          <label for="pf-proj">项目 ID <span style="color:var(--danger)">*</span></label>
          <input id="pf-proj" type="text" class="input" style="font-family:var(--font-mono)" bind:value={vProjectId} placeholder="Google Cloud Project ID" required />
        </div>
        <div class="field" style="margin-bottom:0">
          <label for="pf-loc">区域</label>
          <input id="pf-loc" type="text" class="input" style="font-family:var(--font-mono)" bind:value={vLocation} placeholder="us-central1" />
        </div>
      </div>

      <!-- ═══ Service Account Mode ═══ -->
      {#if vAuthMode === "service_account"}
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--muted);font-weight:500">服务账号凭据</span>
          <button type="button" class="btn btn-soft btn-sm" onclick={importFromJson} style="display:inline-flex;align-items:center;gap:6px">
            <Upload style="width:13px;height:13px" /> 从 JSON 密钥文件导入
          </button>
        </div>

        {#if importStatus}
          <Alert type={importOk ? 'success' : 'error'} message={importStatus} />
        {/if}

        <div class="field">
          <label for="pf-email">服务账号邮箱 <span style="color:var(--danger)">*</span></label>
          <input id="pf-email" type="text" class="input" style="font-family:var(--font-mono)" bind:value={vSaEmail} placeholder="xxx@yyy.iam.gserviceaccount.com" required />
        </div>
        <div class="field">
          <label for="pf-key">私钥 (PEM){#if editing}<span style="color:var(--muted);font-weight:400;text-transform:none"> — 留空则不修改</span>{/if}</label>
          <textarea id="pf-key" class="textarea" style="font-family:var(--font-mono)" rows={5} bind:value={vPrivateKey} placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"></textarea>
        </div>
      {/if}

      <!-- ═══ API Key Mode ═══ -->
      {#if vAuthMode === "api_key"}
        <div class="field">
          <label for="pf-vapikey">Vertex AI API Key <span style="color:var(--danger)">*</span>{#if editing}<span style="color:var(--muted);font-weight:400;text-transform:none"> — 留空则不修改</span>{/if}</label>
          <input id="pf-vapikey" type="password" class="input" style="font-family:var(--font-mono)" bind:value={vApiKey} placeholder="输入 Vertex AI API Key" />
          <p style="font-size:11px;color:var(--muted);display:flex;align-items:center;gap:6px;margin-top:4px">
            <AlertCircle style="width:12px;height:12px;flex-shrink:0" /> 使用 Vertex AI API 密钥进行认证，无需服务账号 JSON 文件
          </p>
        </div>
      {/if}
    </div>
  {/if}

  <!-- ═══════════ API Key Fields ═══════════ -->
  {#if type === "google_ai_studio" || type === "openai" || type === "anthropic"}
    <div style="padding:16px 18px;border-radius:14px;background:var(--input);border:1px solid var(--b-def)">
      <span style="font-size:12px;font-weight:600;color:var(--fg-2);text-transform:uppercase;letter-spacing:.06em">
        {type === "anthropic" ? "Anthropic" : ""}{type === "google_ai_studio" ? "Google AI Studio" : ""}{type === "openai" ? "OpenAI" : ""} API 密钥配置
      </span>

      <div class="field">
        <label for="pf-apikey">API Key <span style="color:var(--danger)">*</span>{#if editing}<span style="color:var(--muted);font-weight:400;text-transform:none"> — 留空则不修改</span>{/if}</label>
        <input id="pf-apikey" type="password" class="input" style="font-family:var(--font-mono)" bind:value={fApiKey} placeholder="输入 API Key" />
      </div>

      {#if type === "openai"}
        <div class="field">
          <label for="pf-url">自定义 Base URL <span style="color:var(--muted);font-weight:400;text-transform:none">（可选）</span></label>
          <input id="pf-url" type="text" class="input" style="font-family:var(--font-mono)" bind:value={oBaseUrl} placeholder="https://api.openai.com/v1" />
        </div>
      {/if}
    </div>
  {/if}

  <!-- ═══════════ Common: Weight + Enabled ═══════════ -->
  <div style="display:grid;grid-template-columns:1fr;gap:16px">
    <div class="field" style="margin-bottom:0">
      <label for="pf-weight">权重</label>
      <input id="pf-weight" type="number" class="input" style="font-family:var(--font-mono)" bind:value={weight} min="0" max="100" />
    </div>

    <!-- Toggle Switch -->
    <button
      type="button"
      style="display:flex;align-items:center;gap:12px;cursor:pointer;background:none;border:none;color:inherit;font:inherit;align-self:end;padding-bottom:2px"
      onclick={() => (enabled = !enabled)}
      role="switch"
      aria-checked={enabled}
    >
      <span class="switch {enabled ? 'on' : ''}"></span>
      <span style="font-size:12.5px;font-weight:500;color:var(--fg-2)">{enabled ? "已启用" : "已禁用"}</span>
    </button>
  </div>

  <!-- Hint -->
  <Alert type="info">模型列表将自动从提供商 API 获取，无需手动配置。</Alert>

  <!-- Error -->
  {#if error}
    <Alert type="error" message={error} />
  {/if}

  <!-- Actions -->
  <div style="display:flex;flex-direction:column-reverse;gap:10px;padding-top:8px">
    <button type="submit" disabled={loading} class="btn btn-primary" style="width:100%;justify-content:center">
      {#if loading}
        <span class="spark"></span> 保存中...
      {:else}
        保 存
      {/if}
    </button>
  </div>
</form>
