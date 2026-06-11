<script lang="ts">
  import { getProviders, createProvider, updateProvider, deleteProvider } from "$lib/api";
  import type { Provider } from "$lib/api";
  import { Settings, Plus, Server } from "lucide-svelte";
  import Modal from "$lib/Modal.svelte";
  import ProviderCard from "$lib/ProviderCard.svelte";
  import ProviderForm from "$lib/ProviderForm.svelte";
  import ClientKeySection from "$lib/ClientKeySection.svelte";

  let providers = $state<Provider[]>([]);
  let loading = $state(true);
  let modalOpen = $state(false);
  let editingProvider = $state<Provider | null>(null);
  let modalTitle = $state('添加提供商');

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    window.dispatchEvent(new CustomEvent('toast', { detail: { message: msg, type } }));
  }

  $effect(() => { loadProviders(); });

  async function loadProviders() {
    try { providers = await getProviders(); }
    catch (err: any) { showToast(err.message, 'error'); }
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
      showToast(p.enabled ? '已禁用' : '已启用');
    } catch (err: any) { showToast(err.message, 'error'); }
  }
  async function handleDelete(id: string) {
    const p = providers.find(x => x.id === id);
    if (!p || !confirm(`确定删除 "${p.name}"?`)) return;
    try { await deleteProvider(id); await loadProviders(); showToast('已删除'); }
    catch (err: any) { showToast(err.message, 'error'); }
  }
  function handleSaved() {
    const wasEdit = !!editingProvider;
    modalOpen = false; editingProvider = null; loadProviders();
    showToast(wasEdit ? '提供商已更新' : '提供商已添加');
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

  <!-- Client Key -->
  <div class="mb-8">
    <ClientKeySection onsuccess={(m: string) => showToast(m)} onerror={(m: string) => showToast(m, 'error')} />
  </div>

  <!-- Providers -->
  {#if loading}
    <div class="space-y-3">
      {#each Array(3) as _}
        <div class="bg-surface border border-white/[0.06] rounded-xl p-5 animate-pulse h-[72px]"></div>
      {/each}
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
  <ProviderForm editing={editingProvider} onsave={handleSaved} onerror={(m: string) => showToast(m, 'error')} />
</Modal>
