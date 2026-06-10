<script lang="ts">
  import { createProvider, updateProvider } from "$lib/api";
  import type { Provider } from "$lib/api";
  import { Upload, Database, Globe, Key, AlertCircle, Lock } from "lucide-svelte";

  interface Props {
    editing?: Provider | null;
    onsave: () => void;
    onerror: (msg: string) => void;
  }

  let { editing = null, onsave, onerror }: Props = $props();

  let type = $state("vertex_ai");
  let name = $state("");
  let provId = $state("");
  let enabled = $state(true);
  let weight = $state(1);
  let loading = $state(false);
  let error = $state("");

  // Vertex AI fields
  let vProjectId = $state("");
  let vLocation = $state("us-central1");
  let vSaEmail = $state("");
  let vPrivateKey = $state("");

  // API Key fields
  let fApiKey = $state("");
  let oBaseUrl = $state("");

  // Import status
  let importStatus = $state("");
  let importOk = $state(false);

  const typeOptions = [
    { value: "vertex_ai", label: "Google Vertex AI", icon: Database },
    { value: "google_ai_studio", label: "Google AI Studio", icon: Globe },
    { value: "openai", label: "OpenAI 官方", icon: Key },
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
      } else if (editing.type === "google_ai_studio" || editing.type === "openai") {
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
    vProjectId = "";
    vLocation = "us-central1";
    vSaEmail = "";
    vPrivateKey = "";
    fApiKey = "";
    oBaseUrl = "";
    error = "";
    importStatus = "";
    importOk = false;
  }

  function getConfig(): Record<string, string> {
    if (type === "vertex_ai") {
      return {
        projectId: vProjectId.trim(),
        location: vLocation.trim() || "us-central1",
        serviceAccountEmail: vSaEmail.trim(),
        privateKey: vPrivateKey.trim(),
      };
    } else if (type === "google_ai_studio") {
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
      onerror(error);
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
    <legend class="flex items-center gap-2 text-xs font-semibold text-secondary uppercase tracking-wider mb-3">
      提供商类型 <span class="text-danger">*</span>
      {#if editing}
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-warning-subtle border border-warning/20 text-warning text-[10px] font-bold uppercase tracking-wider">
          <Lock class="w-3 h-3" />
          不可更改
        </span>
      {/if}
    </legend>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
      {#each typeOptions as opt}
        {@const isSelected = type === opt.value}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <label
          class="relative flex items-center gap-2.5 px-4 py-3 rounded-xl
                 border transition-all duration-200 select-none
                 {editing
                   ? (isSelected
                       ? 'bg-surface cursor-default border-white/[0.12] text-primary'
                       : 'opacity-30 cursor-not-allowed bg-input border-white/[0.05] text-muted')
                   : (isSelected
                       ? 'bg-cta-subtle border-cta/40 text-primary ring-1 ring-cta/20 cursor-pointer'
                       : 'bg-input border-white/[0.08] text-muted hover:border-white/[0.14] hover:text-secondary cursor-pointer')}"
        >
          <input
            type="radio"
            bind:group={type}
            value={opt.value}
            disabled={!!editing}
            class="sr-only"
          />
          <opt.icon class="w-4 h-4 shrink-0" />
          <span class="text-xs font-medium">{opt.label}</span>

          {#if editing && isSelected}
            <!-- Selected + locked indicator -->
            <span class="absolute -top-1.5 -right-1.5 flex items-center justify-center w-5 h-5 rounded-full bg-warning text-background shadow-sm" title="提供商类型在创建后不可更改">
              <Lock class="w-3 h-3" />
            </span>
          {/if}
        </label>
      {/each}
    </div>
    {#if editing}
      <p class="text-[11px] text-warning flex items-center gap-1.5 mt-2">
        <Lock class="w-3 h-3 shrink-0" />
        提供商类型创建后无法修改，如需切换类型请删除后重新添加
      </p>
    {/if}
  </fieldset>

  <!-- Name + ID -->
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
    <div class="space-y-1.5">
      <label for="pf-name" class="block text-xs font-semibold text-secondary uppercase tracking-wider">
        名称 <span class="text-danger">*</span>
      </label>
      <input
        id="pf-name"
        type="text"
        bind:value={name}
        placeholder="如: Vertex AI Primary"
        required
        class="w-full px-3.5 py-2.5 rounded-xl bg-input border border-white/[0.10] text-primary text-sm
               placeholder:text-placeholder font-sans
               focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
               transition-all duration-200"
      />
    </div>
    <div class="space-y-1.5">
      <label for="pf-id" class="block text-xs font-semibold text-secondary uppercase tracking-wider">
        提供商 ID <span class="text-danger">*</span>
      </label>
      <input
        id="pf-id"
        type="text"
        bind:value={provId}
        placeholder="如: vertex-1"
        required
        disabled={!!editing}
        class="w-full px-3.5 py-2.5 rounded-xl bg-input border border-white/[0.10] text-primary text-sm
               placeholder:text-placeholder font-mono
               focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
               transition-all duration-200
               disabled:opacity-40 disabled:cursor-not-allowed"
      />
    </div>
  </div>

  <!-- ═══════════ Vertex AI Fields ═══════════ -->
  {#if type === "vertex_ai"}
    <div class="space-y-4 p-4 sm:p-5 rounded-xl bg-input border border-white/[0.06]">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <span class="text-xs font-semibold text-secondary uppercase tracking-wider">Vertex AI 配置</span>
        <button
          type="button"
          class="px-3 py-1.5 text-xs font-medium rounded-lg
                 bg-surface-elevated hover:bg-surface-hover text-secondary hover:text-primary
                 border border-white/[0.08]
                 transition-all duration-200
                 inline-flex items-center gap-1.5"
          onclick={importFromJson}
        >
          <Upload class="w-3 h-3" />
          从 JSON 密钥文件导入
        </button>
      </div>

      {#if importStatus}
        <div
          class="text-xs px-3 py-2 rounded-lg flex items-start gap-2
                 {importOk
                   ? 'bg-success-subtle text-accent border border-accent/20'
                   : 'bg-danger-subtle text-danger border border-danger/20'}"
        >
          <AlertCircle class="w-3.5 h-3.5 shrink-0 mt-px" />
          {importStatus}
        </div>
      {/if}

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div class="space-y-1.5">
          <label for="pf-proj" class="block text-xs font-semibold text-secondary uppercase tracking-wider">
            项目 ID <span class="text-danger">*</span>
          </label>
          <input id="pf-proj" type="text" bind:value={vProjectId} placeholder="Google Cloud Project ID" required
            class="w-full px-3.5 py-2.5 rounded-xl bg-surface border border-white/[0.10] text-primary text-sm font-mono
                   placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
                   transition-all duration-200" />
        </div>
        <div class="space-y-1.5">
          <label for="pf-loc" class="block text-xs font-semibold text-secondary uppercase tracking-wider">区域</label>
          <input id="pf-loc" type="text" bind:value={vLocation} placeholder="us-central1"
            class="w-full px-3.5 py-2.5 rounded-xl bg-surface border border-white/[0.10] text-primary text-sm font-mono
                   placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
                   transition-all duration-200" />
        </div>
      </div>
      <div class="space-y-1.5">
        <label for="pf-email" class="block text-xs font-semibold text-secondary uppercase tracking-wider">
          服务账号邮箱 <span class="text-danger">*</span>
        </label>
        <input id="pf-email" type="text" bind:value={vSaEmail} placeholder="xxx@yyy.iam.gserviceaccount.com" required
          class="w-full px-3.5 py-2.5 rounded-xl bg-surface border border-white/[0.10] text-primary text-sm font-mono
                 placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
                 transition-all duration-200" />
      </div>
      <div class="space-y-1.5">
        <label for="pf-key" class="block text-xs font-semibold text-secondary uppercase tracking-wider">
          私钥 (PEM)
          {#if editing}<span class="text-muted font-normal normal-case tracking-normal"> — 留空则不修改</span>{/if}
        </label>
        <textarea id="pf-key" bind:value={vPrivateKey} placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----" rows={5}
          class="w-full px-3.5 py-2.5 rounded-xl bg-surface border border-white/[0.10] text-primary text-sm font-mono
                 placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
                 transition-all duration-200 resize-y"></textarea>
      </div>
    </div>
  {/if}

  <!-- ═══════════ API Key Fields ═══════════ -->
  {#if type === "google_ai_studio" || type === "openai"}
    <div class="space-y-4 p-4 sm:p-5 rounded-xl bg-input border border-white/[0.06]">
      <span class="text-xs font-semibold text-secondary uppercase tracking-wider">API 密钥配置</span>

      <div class="space-y-1.5">
        <label for="pf-apikey" class="block text-xs font-semibold text-secondary uppercase tracking-wider">
          API Key <span class="text-danger">*</span>
          {#if editing}<span class="text-muted font-normal normal-case tracking-normal"> — 留空则不修改</span>{/if}
        </label>
        <input id="pf-apikey" type="password" bind:value={fApiKey} placeholder="输入 API Key"
          class="w-full px-3.5 py-2.5 rounded-xl bg-surface border border-white/[0.10] text-primary text-sm font-mono
                 placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
                 transition-all duration-200" />
      </div>

      {#if type === "openai"}
        <div class="space-y-1.5">
          <label for="pf-url" class="block text-xs font-semibold text-secondary uppercase tracking-wider">
            自定义 Base URL <span class="text-muted font-normal normal-case">（可选）</span>
          </label>
          <input id="pf-url" type="text" bind:value={oBaseUrl} placeholder="https://api.openai.com/v1"
            class="w-full px-3.5 py-2.5 rounded-xl bg-surface border border-white/[0.10] text-primary text-sm font-mono
                   placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
                   transition-all duration-200" />
        </div>
      {/if}
    </div>
  {/if}

  <!-- ═══════════ Common: Weight + Enabled ═══════════ -->
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
    <div class="space-y-1.5">
      <label for="pf-weight" class="block text-xs font-semibold text-secondary uppercase tracking-wider">权重</label>
      <input id="pf-weight" type="number" bind:value={weight} min="0" max="100"
        class="w-full px-3.5 py-2.5 rounded-xl bg-input border border-white/[0.10] text-primary text-sm font-mono
               placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
               transition-all duration-200" />
    </div>

    <!-- Toggle Switch -->
    <div class="flex items-end pb-1">
      <label class="flex items-center gap-3 cursor-pointer select-none">
        <div class="relative">
          <input type="checkbox" bind:checked={enabled} class="sr-only peer" />
          <div class="w-10 h-6 rounded-full bg-white/[0.08] peer-checked:bg-accent transition-all duration-200"></div>
          <div class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow
                      transition-transform duration-200 ease-out
                      peer-checked:translate-x-4"></div>
        </div>
        <span class="text-sm font-medium text-secondary">
          {enabled ? "已启用" : "已禁用"}
        </span>
      </label>
    </div>
  </div>

  <!-- Hint -->
  <div class="flex items-start gap-2 px-4 py-3 rounded-xl bg-cta-subtle border border-cta/10">
    <svg class="w-4 h-4 shrink-0 text-cta mt-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
    <p class="text-xs text-secondary leading-relaxed">
      模型列表将自动从提供商 API 获取，无需手动配置。
    </p>
  </div>

  <!-- Error -->
  {#if error}
    <div class="flex items-start gap-2.5 text-sm text-danger bg-danger-subtle rounded-xl px-4 py-3 border border-danger/20" role="alert">
      <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
      <span>{error}</span>
    </div>
  {/if}

  <!-- Actions -->
  <div class="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-2">
    <button type="submit" disabled={loading}
      class="w-full sm:w-auto px-6 py-3 rounded-xl
             bg-cta hover:bg-cta-hover disabled:opacity-40
             text-white text-sm font-semibold tracking-wide
             transition-all duration-200 shadow-glow-cta
             active:scale-[0.98]
             inline-flex items-center justify-center gap-2">
      {#if loading}
        <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
          <path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        保存中...
      {:else}
        保 存
      {/if}
    </button>
  </div>
</form>
