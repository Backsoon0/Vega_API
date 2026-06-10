<script lang="ts">
  import { goto } from "$app/navigation";
  import { isAuthenticated, clearToken, getProviders, updateProvider, deleteProvider } from "$lib/api";
  import type { Provider } from "$lib/api";
  import { Plus, LogOut, Lock, Key, Server, Shield } from "lucide-svelte";
  import Modal from "$lib/Modal.svelte";
  import ProviderCard from "$lib/ProviderCard.svelte";
  import ProviderForm from "$lib/ProviderForm.svelte";
  import ClientKeySection from "$lib/ClientKeySection.svelte";
  import ChangePasswordModal from "$lib/ChangePasswordModal.svelte";

  const CURRENT_YEAR = new Date().getFullYear();

  let providers = $state<Provider[]>([]);
  let loading = $state(true);
  let modalOpen = $state(false);
  let passwordModalOpen = $state(false);
  let editingProvider = $state<Provider | null>(null);
  let modalTitle = $state("添加提供商");

  // Toast
  function showToast(msg: string, type: "success" | "error" = "success") {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("toast", { detail: { message: msg, type } }));
    }
  }

  // Auth guard
  $effect(() => {
    if (!isAuthenticated()) goto("/");
  });

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
    modalTitle = "添加 AI 提供商";
    modalOpen = true;
  }

  function handleEdit(id: string) {
    const p = providers.find((x) => x.id === id);
    if (p) {
      editingProvider = p;
      modalTitle = `编辑: ${p.name}`;
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
      await loadProviders();
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
      await loadProviders();
      showToast("已删除");
    } catch (err: any) {
      showToast(err.message, "error");
    }
  }

  function handleSaved() {
    const wasEdit = !!editingProvider;
    modalOpen = false;
    editingProvider = null;
    loadProviders();
    showToast(wasEdit ? "提供商已更新" : "提供商已添加");
  }

  function handleLogout() {
    clearToken();
    goto("/");
  }
</script>

<svelte:head>
  <title>控制台 — Vega API</title>
</svelte:head>

<div class="min-h-dvh bg-background">
  <div class="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
    <!-- ═══════════ Header ═══════════ -->
    <header class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8 pb-6 border-b border-white/[0.06]">
      <div class="flex items-center gap-3">
        <div class="flex items-center justify-center w-10 h-10 rounded-xl bg-cta-subtle ring-1 ring-white/[0.06]">
          <Key class="w-5 h-5 text-cta" stroke-width={1.75} />
        </div>
        <div>
          <h1 class="text-lg font-bold text-primary font-mono tracking-tight">
            Vega<span class="text-cta font-sans font-semibold"> API</span>
          </h1>
          <p class="text-xs text-muted">配置管理控制台</p>
        </div>
      </div>

      <!-- Desktop actions -->
      <div class="hidden sm:flex items-center gap-2">
        <button
          class="p-2 rounded-xl hover:bg-surface-elevated text-muted hover:text-secondary transition-all duration-200"
          onclick={() => (passwordModalOpen = true)}
          title="修改管理密码"
          aria-label="修改管理密码"
        >
          <Lock class="w-4 h-4" />
        </button>
        <button
          class="p-2 rounded-xl hover:bg-danger-subtle text-muted hover:text-danger transition-all duration-200"
          onclick={handleLogout}
          title="退出登录"
          aria-label="退出登录"
        >
          <LogOut class="w-4 h-4" />
        </button>
      </div>
    </header>

    <!-- ═══════════ Toolbar ═══════════ -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
      <div class="flex items-center gap-2.5">
        <Server class="w-4 h-4 text-cta" />
        <h2 class="text-sm font-semibold text-primary uppercase tracking-wider">AI 提供商</h2>
        {#if !loading}
          <span class="text-xs text-muted font-mono tabular-nums">({providers.length})</span>
        {/if}
      </div>

      <div class="flex items-center gap-2">
        <!-- Mobile actions (visible only on small screens) -->
        <button
          class="sm:hidden p-2 rounded-xl hover:bg-surface-elevated text-muted hover:text-secondary transition-all duration-200"
          onclick={() => (passwordModalOpen = true)}
          aria-label="修改管理密码"
        >
          <Lock class="w-4 h-4" />
        </button>
        <button
          class="sm:hidden p-2 rounded-xl hover:bg-danger-subtle text-muted hover:text-danger transition-all duration-200"
          onclick={handleLogout}
          aria-label="退出登录"
        >
          <LogOut class="w-4 h-4" />
        </button>

        <button
          class="flex-1 sm:flex-none px-4 py-2.5 text-sm font-semibold rounded-xl
                 bg-cta hover:bg-cta-hover text-white
                 transition-all duration-200 shadow-glow-cta
                 active:scale-[0.97]
                 inline-flex items-center justify-center gap-2"
          onclick={handleAdd}
        >
          <Plus class="w-4 h-4" stroke-width={2.5} />
          添加提供商
        </button>
      </div>
    </div>

    <!-- ═══════════ Client Key Section ═══════════ -->
    <div class="mb-8">
      <ClientKeySection onsuccess={(m) => showToast(m)} onerror={(m) => showToast(m, "error")} />
    </div>

    <!-- ═══════════ Provider List ═══════════ -->
    {#if loading}
      <div class="space-y-3">
        {#each Array(3) as _}
          <div class="bg-surface border border-white/[0.06] rounded-xl p-5 animate-pulse">
            <div class="flex items-center gap-4">
              <div class="h-6 w-20 rounded-lg bg-white/[0.04]"></div>
              <div class="flex-1 space-y-2">
                <div class="h-4 w-40 rounded bg-white/[0.04]"></div>
                <div class="h-3 w-24 rounded bg-white/[0.03]"></div>
              </div>
              <div class="flex gap-1">
                <div class="h-8 w-8 rounded-lg bg-white/[0.04]"></div>
                <div class="h-8 w-8 rounded-lg bg-white/[0.04]"></div>
                <div class="h-8 w-8 rounded-lg bg-white/[0.04]"></div>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {:else if providers.length === 0}
      <div
        class="bg-surface border border-white/[0.06] border-dashed rounded-2xl p-10 sm:p-14 text-center"
      >
        <div
          class="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-cta-subtle ring-1 ring-white/[0.06] mb-5"
        >
          <Server class="w-6 h-6 text-cta" stroke-width={1.5} />
        </div>
        <h3 class="text-base font-semibold text-primary mb-1.5">暂无 AI 提供商</h3>
        <p class="text-sm text-muted mb-6 max-w-xs mx-auto">
          点击上方「添加提供商」按钮开始配置您的第一个 AI 服务。
        </p>
        <button
          class="px-5 py-2.5 text-sm font-semibold rounded-xl
                 bg-cta hover:bg-cta-hover text-white
                 transition-all duration-200 shadow-glow-cta
                 active:scale-[0.97]
                 inline-flex items-center gap-2"
          onclick={handleAdd}
        >
          <Plus class="w-4 h-4" stroke-width={2.5} />
          添加第一个提供商
        </button>
      </div>
    {:else}
      <div class="space-y-3">
        {#each providers as p (p.id)}
          <ProviderCard provider={p} onedit={handleEdit} ontoggle={handleToggle} ondelete={handleDelete} />
        {/each}
      </div>
    {/if}

    <!-- ═══════════ Footer ═══════════ -->
    <footer class="mt-12 pt-6 border-t border-white/[0.06] text-center">
      <p class="text-xs text-muted font-mono">
        Vega API &copy; {CURRENT_YEAR} &mdash;
        <span class="inline-flex items-center gap-1">
          <Shield class="w-3 h-3" /> 连接即安全
        </span>
      </p>
    </footer>
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
