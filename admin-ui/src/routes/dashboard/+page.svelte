<script lang="ts">
  import { goto } from "$app/navigation";
  import { isAuthenticated, clearToken, getProviders, updateProvider, deleteProvider } from "$lib/api";
  import type { Provider } from "$lib/api";
  import { Plus, LogOut, Lock } from "lucide-svelte";
  import Modal from "$lib/Modal.svelte";
  import ProviderCard from "$lib/ProviderCard.svelte";
  import ProviderForm from "$lib/ProviderForm.svelte";
  import ClientKeySection from "$lib/ClientKeySection.svelte";
  import ChangePasswordModal from "$lib/ChangePasswordModal.svelte";

  let providers = $state<Provider[]>([]);
  let loading = $state(true);
  let modalOpen = $state(false);
  let passwordModalOpen = $state(false);
  let editingProvider = $state<Provider | null>(null);
  let modalTitle = $state("添加提供商");

  // Toast state
  let toastMessage = $state("");
  let toastType = $state<"success" | "error">("success");
  let toastVisible = $state(false);
  let toastTimer: ReturnType<typeof setTimeout>;

  function showToast(msg: string, type: "success" | "error" = "success") {
    clearTimeout(toastTimer);
    toastMessage = msg;
    toastType = type;
    toastVisible = true;
    toastTimer = setTimeout(() => (toastVisible = false), 3000);
  }

  // Auth guard
  $effect(() => {
    if (!isAuthenticated()) {
      goto("/");
    }
  });

  // Load providers
  $effect(() => {
    loadProviders();
  });

  async function loadProviders() {
    try {
      providers = await getProviders();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      loading = false;
    }
  }

  function handleAdd() {
    editingProvider = null;
    modalTitle = "添加提供商";
    modalOpen = true;
  }

  function handleEdit(id: string) {
    const p = providers.find((x) => x.id === id);
    if (p) {
      editingProvider = p;
      modalTitle = `编辑提供商: ${p.name}`;
      modalOpen = true;
    }
  }

  async function handleToggle(id: string) {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    try {
      await updateProvider(id, {
        id: p.id,
        type: p.type,
        name: p.name,
        enabled: !p.enabled,
        config: p.config,
        models: p.models,
        weight: p.weight,
      });
      loadProviders();
      showToast(p.enabled ? "已禁用" : "已启用");
    } catch (err: any) {
      showToast(err.message, "error");
    }
  }

  async function handleDelete(id: string) {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    if (!confirm(`确定要删除提供商 "${p.name}" 吗？\n此操作不可撤销。`)) return;
    try {
      await deleteProvider(id);
      loadProviders();
      showToast("已删除");
    } catch (err: any) {
      showToast(err.message, "error");
    }
  }

  function handleSaved() {
    modalOpen = false;
    editingProvider = null;
    loadProviders();
    showToast(editingProvider ? "提供商已更新" : "提供商已添加");
  }

  function handleLogout() {
    clearToken();
    goto("/");
  }
</script>

<svelte:head>
  <title>Vega API — 配置管理</title>
</svelte:head>

<div class="min-h-screen bg-zinc-950">
  <div class="max-w-3xl mx-auto px-5 py-8">
    <!-- Toast -->
    {#if toastVisible}
      <div
        class="fixed top-6 right-6 z-[200] px-5 py-3 rounded-xl text-sm font-medium shadow-2xl backdrop-blur-md transition-all duration-300 {toastType === 'success'
          ? 'bg-emerald-500/90 text-white shadow-emerald-500/20'
          : 'bg-red-500/90 text-white shadow-red-500/20'}"
      >
        {toastMessage}
      </div>
    {/if}

    <!-- Header -->
    <div class="text-center pb-6 mb-8 border-b border-zinc-800">
      <h1 class="text-xl font-bold text-zinc-100">🔑 Vega API</h1>
      <p class="text-sm text-zinc-500 mt-1">配置管理面板</p>
    </div>

    <!-- Toolbar -->
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-base font-semibold text-zinc-100">API 提供商</h2>
      <div class="flex items-center gap-2">
        <button
          class="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors inline-flex items-center gap-1.5 shadow-lg shadow-blue-600/20"
          onclick={handleAdd}
        >
          <Plus class="w-3.5 h-3.5" /> 添加提供商
        </button>
        <button
          class="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          onclick={() => (passwordModalOpen = true)}
          title="修改密码"
        >
          <Lock class="w-4 h-4" />
        </button>
        <button
          class="p-1.5 rounded-lg hover:bg-red-500/10 text-zinc-400 hover:text-red-400 transition-colors"
          onclick={handleLogout}
          title="退出"
        >
          <LogOut class="w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- Client Key Section -->
    <div class="mb-8">
      <ClientKeySection onsuccess={(m) => showToast(m)} onerror={(m) => showToast(m, "error")} />
    </div>

    <!-- Provider List -->
    {#if loading}
      <div class="text-center py-12">
        <div class="inline-flex items-center gap-3 text-zinc-500">
          <svg class="animate-spin h-5 w-5" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span class="text-sm">加载中...</span>
        </div>
      </div>
    {:else if providers.length === 0}
      <div class="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-10 text-center">
        <p class="text-sm text-zinc-500">暂无提供商。点击"添加提供商"开始配置。</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each providers as p (p.id)}
          <ProviderCard provider={p} onedit={handleEdit} ontoggle={handleToggle} ondelete={handleDelete} />
        {/each}
      </div>
    {/if}
  </div>
</div>

<!-- Provider Modal -->
<Modal bind:open={modalOpen} title={modalTitle} onclose={() => (editingProvider = null)}>
  <ProviderForm editing={editingProvider} onsave={handleSaved} onerror={(m) => showToast(m, "error")} />
</Modal>

<!-- Change Password Modal -->
<ChangePasswordModal
  bind:open={passwordModalOpen}
  onsuccess={(m) => showToast(m)}
  onerror={(m) => showToast(m, "error")}
/>
