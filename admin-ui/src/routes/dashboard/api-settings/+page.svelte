<script lang="ts">
  import { getProviders, createProvider, updateProvider, deleteProvider } from "$lib/api";
  import type { Provider } from "$lib/api";
  import { Settings, Plus, Server, Copy, Check } from "lucide-svelte";
  import { toasts } from "$lib/toast-store";
  import Modal from "$lib/Modal.svelte";
  import ProviderCard from "$lib/ProviderCard.svelte";
  import ProviderForm from "$lib/ProviderForm.svelte";
  import ClientKeySection from "$lib/ClientKeySection.svelte";
  import Spinner from "$lib/Spinner.svelte";

  let providers = $state<Provider[]>([]);
  let loading = $state(true);
  let modalOpen = $state(false);
  let editingProvider = $state<Provider | null>(null);
  let modalTitle = $state('添加提供商');

  // ---- API Endpoint section ----
  let apiBase = $state('');
  let copied = $state(false);

  $effect(() => {
    apiBase = `${window.location.origin}/v1`;
  });

  async function copyApiUrl() {
    try {
      await navigator.clipboard.writeText(apiBase);
    } catch {
      // fallback
      const input = document.createElement('input');
      input.value = apiBase;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  // ---- Providers ----
  $effect(() => { loadProviders(); });

  async function loadProviders() {
    try { providers = await getProviders(); }
    catch (err: any) { toasts.show(err.message, 'error'); }
    finally { loading = false; }
  }

  function handleAdd() { editingProvider = null; modalTitle = '添加 AI 提供商'; modalOpen = true; }
  function handleEdit(id: string) {
    const p = providers.find(x => x.id === id);
    if (p) { editingProvider = p; modalTitle = `编辑: ${p.name}`; modalOpen = true; }
  }
  async function handleToggle(id: string) {
    const p = providers.find(x => x.id === id);
    if (!p) return;
    try {
      await updateProvider(id, {
        id: p.id, type: p.type, name: p.name, enabled: !p.enabled,
        config: p.config, models: p.models, weight: p.weight,
      });
      await loadProviders();
      toasts.show(p.enabled ? '已禁用' : '已启用');
    } catch (err: any) { toasts.show(err.message, 'error'); }
  }
  async function handleDelete(id: string) {
    const p = providers.find(x => x.id === id);
    if (!p || !confirm(`确定删除 "${p.name}"?`)) return;
    try { await deleteProvider(id); await loadProviders(); toasts.show('已删除'); }
    catch (err: any) { toasts.show(err.message, 'error'); }
  }
  function handleSaved() {
    const wasEdit = !!editingProvider;
    modalOpen = false; editingProvider = null; loadProviders();
    toasts.show(wasEdit ? '提供商已更新' : '提供商已添加');
  }
</script>

<svelte:head><title>API 设置 — Vega API</title></svelte:head>

<div class="max-w-6xl mx-auto">
  <div class="mb-8 flex items-center justify-between flex-wrap gap-4">
    <div>
      <h1 class="text-lg font-bold text-primary font-mono flex items-center gap-2">
        <Settings class="w-5 h-5" stroke-width={1.5} />
        API 设置
      </h1>
      <p class="text-xs text-muted mt-1">管理 AI 提供商和客户端 API 密钥</p>
    </div>
    <button
      class="px-4 py-2.5 text-sm font-semibold rounded-xl bg-cta hover:bg-cta-hover text-white transition-all shadow-glow-cta active:scale-[0.97] inline-flex items-center gap-2"
      onclick={handleAdd}
    >
      <Plus class="w-4 h-4" stroke-width={2.5} /> 添加提供商
    </button>
  </div>

  <!-- API Endpoint -->
  <div class="mb-8 bg-surface border border-white/[0.08] rounded-2xl p-6 shadow-card">
    <h2 class="text-sm font-semibold text-primary font-mono flex items-center gap-2 mb-4">
      <Server class="w-4 h-4 text-cta" stroke-width={1.5} />
      API 调用地址
    </h2>
    <p class="text-xs text-muted mb-3">
      将此地址用作 OpenAI SDK 的 <code class="text-accent bg-accent-subtle px-1.5 py-0.5 rounded text-[11px] font-mono">base_url</code>，即可通过标准 OpenAI 接口访问所有已配置的 AI 模型。
    </p>
    <div class="flex items-center gap-2">
      <code
        class="flex-1 bg-input border border-white/[0.10] rounded-xl px-4 py-3 text-sm text-primary font-mono break-all select-all"
      >{apiBase}</code>
      <button
        onclick={copyApiUrl}
        class="shrink-0 px-4 py-3 rounded-xl text-sm text-white font-semibold transition-all duration-200 flex items-center gap-1.5 {copied ? 'bg-accent' : 'bg-cta hover:bg-cta-hover active:scale-[0.97]'}"
      >
        {#if copied}
          <Check class="w-4 h-4" stroke-width={2.5} />
          已复制
        {:else}
          <Copy class="w-4 h-4" stroke-width={1.75} />
          复制
        {/if}
      </button>
    </div>
    <p class="text-[11px] text-muted mt-2">
      完整地址: <span class="text-secondary font-mono">{apiBase}/chat/completions</span>
    </p>
  </div>

  <!-- Client Key -->
  <div class="mb-8">
    <ClientKeySection />
  </div>

  <!-- Providers -->
  {#if loading}
    <div class="flex items-center justify-center py-12">
      <div class="flex flex-col items-center gap-4">
        <Spinner class="text-cta" />
        <span class="text-sm text-muted font-mono">加载提供商...</span>
      </div>
    </div>
  {:else if providers.length === 0}
    <div class="bg-surface border border-white/[0.06] border-dashed rounded-2xl p-12 text-center">
      <div class="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-cta-subtle mb-4">
        <Server class="w-6 h-6 text-cta" stroke-width={1.5} />
      </div>
      <h3 class="text-sm font-semibold text-primary mb-1">暂无 AI 提供商</h3>
      <p class="text-xs text-muted">点击上方按钮添加第一个提供商</p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each providers as p (p.id)}
        <ProviderCard provider={p} onedit={handleEdit} ontoggle={handleToggle} ondelete={handleDelete} />
      {/each}
    </div>
  {/if}
</div>

<Modal bind:open={modalOpen} title={modalTitle} onclose={() => (editingProvider = null)}>
  <ProviderForm editing={editingProvider} onsave={handleSaved} />
</Modal>
