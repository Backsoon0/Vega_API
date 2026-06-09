<script lang="ts">
  import { createProvider, updateProvider } from "$lib/api";
  import type { Provider } from "$lib/api";

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
  let importStatusColor = $state("");

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
        if (editing.type === "openai") {
          oBaseUrl = cfg.baseUrl || "";
        }
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
          importStatus = "❌ 不是有效的服务账号密钥文件";
          importStatusColor = "text-red-400";
          return;
        }
        if (data.project_id) vProjectId = data.project_id;
        if (data.client_email) vSaEmail = data.client_email;
        if (data.private_key) vPrivateKey = data.private_key;
        importStatus = `✅ 已导入 ${data.project_id || "未知项目"}`;
        importStatusColor = "text-emerald-400";
      } catch (err: any) {
        importStatus = `❌ JSON 解析失败: ${err.message}`;
        importStatusColor = "text-red-400";
      }
    };
    input.click();
  }

  const typeOptions = [
    { value: "vertex_ai", label: "Google Vertex AI" },
    { value: "google_ai_studio", label: "Google AI Studio" },
    { value: "openai", label: "OpenAI 官方" },
  ];
</script>

<form onsubmit={handleSubmit} class="space-y-4">
  <!-- Type -->
  <div>
    <label class="block text-xs font-medium text-zinc-400 mb-1.5">提供商类型 *</label>
    <select
      bind:value={type}
      disabled={!!editing}
      class="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 disabled:opacity-50"
    >
      {#each typeOptions as opt}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  </div>

  <div class="grid grid-cols-2 gap-4">
    <div>
      <label class="block text-xs font-medium text-zinc-400 mb-1.5">名称 *</label>
      <input
        type="text"
        bind:value={name}
        placeholder="如：Vertex AI Primary"
        required
        class="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
      />
    </div>
    <div>
      <label class="block text-xs font-medium text-zinc-400 mb-1.5">提供商 ID *</label>
      <input
        type="text"
        bind:value={provId}
        placeholder="如：vertex-1"
        required
        disabled={!!editing}
        class="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 disabled:opacity-50"
      />
    </div>
  </div>

  <!-- Vertex AI fields -->
  {#if type === "vertex_ai"}
    <div class="space-y-4 p-4 rounded-xl bg-zinc-800/50 border border-zinc-700/50">
      <!-- Import button -->
      <div class="flex items-center gap-3">
        <button type="button" class="text-xs px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors" onclick={importFromJson}>
          📂 从 JSON 密钥文件导入
        </button>
        {#if importStatus}
          <span class="text-xs {importStatusColor}">{importStatus}</span>
        {/if}
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-zinc-400 mb-1.5">项目 ID *</label>
          <input type="text" bind:value={vProjectId} placeholder="Google Cloud Project ID" required
            class="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50" />
        </div>
        <div>
          <label class="block text-xs font-medium text-zinc-400 mb-1.5">区域</label>
          <input type="text" bind:value={vLocation} placeholder="us-central1"
            class="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50" />
        </div>
      </div>
      <div>
        <label class="block text-xs font-medium text-zinc-400 mb-1.5">服务账号邮箱 *</label>
        <input type="text" bind:value={vSaEmail} placeholder="xxx@yyy.iam.gserviceaccount.com" required
          class="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50" />
      </div>
      <div>
        <label class="block text-xs font-medium text-zinc-400 mb-1.5">
          私钥 (PEM) * {#if editing}<span class="text-zinc-500 font-normal">（留空则不修改）</span>{/if}
        </label>
        <textarea bind:value={vPrivateKey} placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----" rows={5}
          class="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 resize-y"></textarea>
      </div>
    </div>
  {/if}

  <!-- API Key field (AI Studio / OpenAI) -->
  {#if type === "google_ai_studio" || type === "openai"}
    <div class="space-y-4 p-4 rounded-xl bg-zinc-800/50 border border-zinc-700/50">
      <div>
        <label class="block text-xs font-medium text-zinc-400 mb-1.5">
          API Key * {#if editing}<span class="text-zinc-500 font-normal">（留空则不修改）</span>{/if}
        </label>
        <input type="password" bind:value={fApiKey} placeholder="输入 API Key"
          class="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50" />
      </div>
      {#if type === "openai"}
        <div>
          <label class="block text-xs font-medium text-zinc-400 mb-1.5">自定义 Base URL（可选）</label>
          <input type="text" bind:value={oBaseUrl} placeholder="https://api.openai.com/v1"
            class="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50" />
        </div>
      {/if}
    </div>
  {/if}

  <!-- Common: weight + enabled -->
  <div class="grid grid-cols-2 gap-4">
    <div>
      <label class="block text-xs font-medium text-zinc-400 mb-1.5">权重</label>
      <input type="number" bind:value={weight} min="0" max="100"
        class="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50" />
    </div>
    <div class="flex items-end pb-2">
      <label class="flex items-center gap-2.5 cursor-pointer select-none">
        <div class="relative">
          <input type="checkbox" bind:checked={enabled} class="sr-only peer" />
          <div class="w-9 h-5 rounded-full bg-zinc-700 peer-checked:bg-blue-500 transition-colors"></div>
          <div class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4"></div>
        </div>
        <span class="text-sm text-zinc-300">{enabled ? "已启用" : "已禁用"}</span>
      </label>
    </div>
  </div>

  <!-- Model auto-fetch hint -->
  <p class="text-xs text-zinc-500">💡 模型列表将自动从提供商 API 获取，无需手动配置。</p>

  <!-- Error -->
  {#if error}
    <p class="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
  {/if}

  <!-- Submit -->
  <div class="flex justify-end gap-3 pt-2">
    <button type="submit" disabled={loading}
      class="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors shadow-lg shadow-blue-600/20">
      {loading ? "保存中..." : "保 存"}
    </button>
  </div>
</form>
