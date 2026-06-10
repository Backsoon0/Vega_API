<script lang="ts">
  import {
    Eye, Copy, Trash2, RefreshCw, Edit3,
    Shield, ShieldOff, Check, X, AlertTriangle
  } from "lucide-svelte";
  import { getClientKey, setClientKey, deleteClientKey, revealClientKey } from "$lib/api";

  interface Props {
    onsuccess: (msg: string) => void;
    onerror: (msg: string) => void;
  }

  let { onsuccess, onerror }: Props = $props();

  let configured = $state(false);
  let masked = $state("");
  let length = $state(0);
  let loading = $state(true);
  let showInput = $state(false);
  let showFull = $state(false);
  let fullKey = $state("");
  let customKey = $state("");
  let revealing = $state(false);
  let copying = $state(false);

  async function load() {
    try {
      const info = await getClientKey();
      configured = info.configured;
      masked = info.masked || "";
      length = info.length || 0;
    } catch (err: any) {
      onerror(err.message);
    } finally {
      loading = false;
    }
  }

  async function handleGenerate() {
    try {
      const result = await setClientKey(undefined, true);
      fullKey = result.fullKey;
      showFull = true;
      showInput = false;
      onsuccess("密钥已生成");
      await load();
    } catch (err: any) {
      onerror(err.message);
    }
  }

  async function handleSet() {
    const key = customKey.trim();
    if (!key || key.length < 8) {
      onerror("API Key 至少需要 8 个字符");
      return;
    }
    try {
      await setClientKey(key);
      showInput = false;
      customKey = "";
      onsuccess("密钥已设置");
      await load();
    } catch (err: any) {
      onerror(err.message);
    }
  }

  async function handleReveal() {
    revealing = true;
    try {
      const info = await revealClientKey();
      if (info.fullKey) {
        fullKey = info.fullKey;
        showFull = true;
      }
    } catch (err: any) {
      onerror(err.message);
    } finally {
      revealing = false;
    }
  }

  function hideKey() {
    showFull = false;
    fullKey = "";
  }

  async function handleCopy() {
    copying = true;
    try {
      await navigator.clipboard.writeText(fullKey);
      onsuccess("已复制到剪贴板");
    } catch {
      onerror("复制失败，请手动选择复制");
    } finally {
      copying = false;
    }
  }

  async function handleDelete() {
    if (!confirm("确定要删除客户端 API Key 吗？\n删除后 /v1/* 接口将无需认证即可访问。")) return;
    try {
      await deleteClientKey();
      showFull = false;
      fullKey = "";
      onsuccess("密钥已删除 — 接口可公开访问");
      await load();
    } catch (err: any) {
      onerror(err.message);
    }
  }

  function handleCancelInput() {
    showInput = false;
    customKey = "";
  }

  $effect(() => { load(); });
</script>

<div class="bg-surface border border-white/[0.08] rounded-2xl p-5 sm:p-6 space-y-5 shadow-card">
  <!-- Header -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
    <div class="flex items-center gap-2.5">
      <div class="flex items-center justify-center w-8 h-8 rounded-lg {configured ? 'bg-accent-subtle' : 'bg-warning-subtle'}">
        {#if configured}
          <Shield class="w-4 h-4 text-accent" />
        {:else}
          <ShieldOff class="w-4 h-4 text-warning" />
        {/if}
      </div>
      <div>
        <h2 class="text-sm font-semibold text-primary">客户端 API Key</h2>
        <p class="text-xs text-muted">用于调用 /v1/* 接口的认证凭据</p>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="flex items-center gap-2 flex-wrap">
      <button
        class="px-3 py-2 text-xs font-medium rounded-lg
               bg-surface-elevated hover:bg-surface-hover text-secondary hover:text-primary
               border border-white/[0.08]
               transition-all duration-200
               inline-flex items-center gap-1.5"
        onclick={handleGenerate}
      >
        <RefreshCw class="w-3 h-3" />
        <span class="hidden sm:inline">随机生成</span>
      </button>
      <button
        class="px-3 py-2 text-xs font-medium rounded-lg
               bg-surface-elevated hover:bg-surface-hover text-secondary hover:text-primary
               border border-white/[0.08]
               transition-all duration-200
               inline-flex items-center gap-1.5"
        onclick={() => { showInput = !showInput; showFull = false; }}
      >
        <Edit3 class="w-3 h-3" />
        <span class="hidden sm:inline">自行设置</span>
      </button>
    </div>
  </div>

  <!-- Loading -->
  {#if loading}
    <div class="flex items-center gap-2 text-sm text-muted py-2">
      <svg class="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
        <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
        <path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      加载中...
    </div>

  <!-- Configured state -->
  {:else if configured}
    <div class="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 flex-wrap">
      <span class="text-xs text-muted shrink-0">当前密钥：</span>
      <code class="text-sm text-cta bg-input px-2.5 py-1 rounded-lg font-mono break-all">{masked}</code>
      <span class="text-xs text-muted font-mono tabular-nums">({length} 字符)</span>

      <div class="flex items-center gap-2 sm:ml-auto flex-wrap">
        <button
          class="text-xs text-secondary hover:text-primary transition-colors inline-flex items-center gap-1 py-1"
          onclick={handleReveal}
          disabled={revealing}
        >
          {#if revealing}
            <svg class="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
              <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
              <path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            加载中...
          {:else}
            <Eye class="w-3 h-3" />
            查看完整密钥
          {/if}
        </button>

        <button
          class="text-xs text-danger hover:text-danger-hover transition-colors inline-flex items-center gap-1 py-1"
          onclick={handleDelete}
        >
          <Trash2 class="w-3 h-3" />
          删除（公开访问）
        </button>
      </div>
    </div>

    <!-- Revealed key display — with close button -->
    {#if showFull}
      <div class="p-4 rounded-xl bg-input border border-warning/20 space-y-3">
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1 min-w-0">
            <code class="text-sm text-warning font-mono break-all leading-relaxed">{fullKey}</code>
          </div>
          <!-- Close button -->
          <button
            class="shrink-0 p-1.5 rounded-lg hover:bg-surface-elevated text-muted hover:text-secondary
                   transition-all duration-150"
            onclick={hideKey}
            title="关闭密钥显示"
            aria-label="关闭密钥显示"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <div class="flex items-center justify-between gap-3 flex-wrap">
          <p class="text-xs text-warning flex items-center gap-1.5">
            <AlertTriangle class="w-3.5 h-3.5" />
            此密钥仅显示一次，请立即复制保存
          </p>
          <button
            class="shrink-0 px-3 py-1.5 text-xs font-semibold rounded-lg
                   bg-warning hover:bg-warning/80 text-background
                   transition-all duration-200
                   inline-flex items-center gap-1.5"
            onclick={handleCopy}
            disabled={copying}
          >
            {#if copying}
              <Check class="w-3 h-3" />
              已复制
            {:else}
              <Copy class="w-3 h-3" />
              复制密钥
            {/if}
          </button>
        </div>
      </div>
    {/if}

  <!-- Unconfigured state -->
  {:else}
    <div class="flex items-center gap-2.5 text-sm text-warning bg-warning-subtle rounded-xl px-4 py-3 border border-warning/20">
      <ShieldOff class="w-4 h-4 shrink-0" />
      <span>未设置密钥 — /v1/* 接口可公开访问</span>
    </div>
  {/if}

  <!-- Custom key input -->
  {#if showInput}
    <div class="flex flex-col sm:flex-row gap-2.5">
      <input
        type="text"
        bind:value={customKey}
        placeholder="输入 API Key（至少 8 个字符）"
        class="flex-1 px-3.5 py-2.5 rounded-xl bg-input border border-white/[0.10] text-primary text-sm font-mono
               placeholder:text-placeholder
               focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
               transition-all duration-200"
      />
      <div class="flex gap-2">
        <button
          class="px-4 py-2.5 text-xs font-semibold rounded-xl bg-accent hover:bg-accent-hover text-white
                 transition-all duration-200 active:scale-[0.97]"
          onclick={handleSet}
        >保存</button>
        <button
          class="px-4 py-2.5 text-xs font-semibold rounded-xl bg-surface-elevated hover:bg-surface-hover text-secondary
                 transition-all duration-200"
          onclick={handleCancelInput}
        >取消</button>
      </div>
    </div>
  {/if}
</div>
