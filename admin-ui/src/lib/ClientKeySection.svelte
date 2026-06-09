<script lang="ts">
  import { Key, Eye, Copy, Trash2, RefreshCw, Edit3 } from "lucide-svelte";
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
    try {
      const info = await revealClientKey();
      if (info.fullKey) {
        fullKey = info.fullKey;
        showFull = true;
      }
    } catch (err: any) {
      onerror(err.message);
    }
  }

  async function handleDelete() {
    if (!confirm("确定要删除客户端 API Key 吗？\n删除后 /v1/* 接口将无需认证即可访问。")) return;
    try {
      await deleteClientKey();
      showFull = false;
      fullKey = "";
      onsuccess("密钥已删除，接口可公开访问");
      await load();
    } catch (err: any) {
      onerror(err.message);
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(fullKey)
      .then(() => onsuccess("已复制到剪贴板"))
      .catch(() => onerror("复制失败，请手动选择复制"));
  }

  // Load on mount
  $effect(() => { load(); });
</script>

<div class="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-6 space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-sm font-semibold text-zinc-100 flex items-center gap-2">
        <Key class="w-4 h-4 text-amber-400" />
        客户端 API Key
      </h2>
      <p class="text-xs text-zinc-500 mt-0.5">用于调用 /v1/* 接口的认证凭据</p>
    </div>
    <div class="flex items-center gap-2">
      <button
        class="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors inline-flex items-center gap-1.5"
        onclick={handleGenerate}
      >
        <RefreshCw class="w-3 h-3" /> 随机生成
      </button>
      <button
        class="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors inline-flex items-center gap-1.5"
        onclick={() => { showInput = !showInput; showFull = false; }}
      >
        <Edit3 class="w-3 h-3" /> 自行设置
      </button>
    </div>
  </div>

  {#if loading}
    <p class="text-sm text-zinc-500">加载中...</p>
  {:else if configured}
    <div class="flex items-center gap-3 flex-wrap">
      <span class="text-xs text-zinc-400">当前密钥：</span>
      <code class="text-sm text-blue-400 bg-zinc-800 px-2 py-0.5 rounded font-mono">{masked}</code>
      <span class="text-xs text-zinc-500">({length} 字符)</span>
      <button class="text-xs text-zinc-400 hover:text-zinc-200 transition-colors inline-flex items-center gap-1" onclick={handleReveal}>
        <Eye class="w-3 h-3" /> 查看
      </button>
      <button class="text-xs text-red-400 hover:text-red-300 transition-colors inline-flex items-center gap-1 ml-auto" onclick={handleDelete}>
        <Trash2 class="w-3 h-3" /> 删除密钥（公开访问）
      </button>
    </div>

    {#if showFull}
      <div class="p-3 rounded-xl bg-zinc-800 border border-zinc-700 space-y-2">
        <div class="flex items-center justify-between gap-3">
          <code class="text-sm text-emerald-400 font-mono break-all">{fullKey}</code>
          <button class="shrink-0 px-2 py-1 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors inline-flex items-center gap-1" onclick={handleCopy}>
            <Copy class="w-3 h-3" /> 复制
          </button>
        </div>
        <p class="text-[11px] text-amber-400">⚠️ 此密钥仅显示一次，请立即复制保存</p>
      </div>
    {/if}
  {:else}
    <p class="text-sm text-amber-400 flex items-center gap-1.5">
      <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
      未设置密钥 — /v1/* 接口可公开访问
    </p>
  {/if}

  <!-- Custom key input -->
  {#if showInput}
    <div class="flex items-center gap-2">
      <input
        type="text"
        bind:value={customKey}
        placeholder="输入 API Key（至少8位）"
        class="flex-1 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
      />
      <button
        class="px-3 py-2 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
        onclick={handleSet}
      >保存</button>
      <button
        class="px-3 py-2 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
        onclick={() => { showInput = false; customKey = ""; }}
      >取消</button>
    </div>
  {/if}
</div>
