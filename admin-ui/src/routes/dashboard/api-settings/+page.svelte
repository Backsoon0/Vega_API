<script lang="ts">
  import { getProviders } from "$lib/api";
  import type { Provider } from "$lib/api";
  import { toasts } from "$lib/toast-store";
  import Modal from "$lib/Modal.svelte";
  import ProviderCard from "$lib/ProviderCard.svelte";
  import ProviderForm from "$lib/ProviderForm.svelte";
	import ClientKeySection from "$lib/ApiKeyList.svelte";
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

<div class="page-head">
  <div>
    <h1>API 设置</h1>
    <p class="lead">管理 AI 提供商与客户端密钥</p>
  </div>
  <div class="actions">
    <button class="btn btn-primary" onclick={handleAdd}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14" /></svg>
      添加提供商
    </button>
  </div>
</div>

<!-- API Endpoint -->
<div class="card mb-lg rise" style="--d:40ms">
  <div class="card-head">
    <div>
      <h2>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="3" width="6" height="6" rx="1" /><rect x="16" y="15" width="6" height="6" rx="1" /><circle cx="7" cy="18" r="2.5" /><circle cx="17" cy="6" r="2.5" /><path d="M7 18h9M17 6 7 10" /></svg>
        API 调用地址
      </h2>
      <div class="sub">用作 SDK 的 base_url</div>
    </div>
    <button class="btn btn-accent btn-sm" onclick={copyApiUrl}>
      {#if copied}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5" /></svg>
        已复制
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        复制
      {/if}
    </button>
  </div>
  <div class="card-pad">
    <div class="input mono" style="font-size:13px;padding:12px 14px">{apiBase}</div>
    <div style="font-size:11.5px;color:var(--muted);margin-top:10px">完整地址：<span style="color:var(--fg-2);font-family:var(--font-mono)">/v1/chat/completions</span></div>
  </div>
</div>

<!-- Client Key -->
<div class="mb-lg">
  <ClientKeySection />
</div>

<!-- Providers -->
{#if loading}
  <div class="empty" style="padding:40px">
    <div class="flex flex-col items-center gap-4"><Spinner class="text-cta" /><span class="mono" style="font-size:13px;color:var(--muted)">加载提供商...</span></div>
  </div>
{:else if providers.length === 0}
  <div class="card" style="padding:40px 16px;text-align:center;border-style:dashed">
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" style="color:var(--muted);margin:0 auto 10px"><path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" /></svg>
    <h3 style="font-size:14px;font-weight:600;color:var(--fg);margin-bottom:4px">暂无 AI 提供商</h3>
    <p style="font-size:12px;color:var(--muted)">点击上方按钮添加第一个提供商</p>
  </div>
{:else}
  <div style="display:flex;flex-direction:column;gap:12px">
    {#each providers as p (p.id)}
      <ProviderCard provider={p} onedit={handleEdit} ontoggle={handleToggle} ondelete={handleDelete} />
    {/each}
  </div>
{/if}

<Modal bind:open={modalOpen} title={modalTitle} onclose={() => (editingProvider = null)}>
  <ProviderForm editing={editingProvider} onsave={handleSaved} />
</Modal>
