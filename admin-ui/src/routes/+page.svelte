<script lang="ts">
  import { goto } from "$app/navigation";
  import { login, isAuthenticated } from "$lib/api";
  import { Key } from "lucide-svelte";

  let password = $state("");
  let error = $state("");
  let loading = $state(false);
  let mounted = $state(false);

  $effect(() => {
    mounted = true;
    if (isAuthenticated()) {
      goto("/dashboard");
    }
  });

  async function handleSubmit(e: Event) {
    e.preventDefault();
    error = "";

    if (!password) {
      error = "请输入密码";
      return;
    }

    loading = true;
    try {
      const result = await login(password);
      if (result.ok) {
        await goto("/dashboard");
      } else {
        error = result.error || "登录失败";
        if (result.banned) {
          error += `（封禁剩余 ${Math.ceil(result.remainingSeconds / 60)} 分钟）`;
        } else if (result.remaining !== undefined) {
          error += `（剩余 ${result.remaining} 次尝试）`;
        }
      }
    } catch (err: any) {
      error = "网络错误: " + err.message;
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Vega API — 管理登录</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center bg-zinc-950 p-5">
  <div class="w-full max-w-sm">
    <!-- Header -->
    <div class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-500/10 mb-4">
        <Key class="w-8 h-8 text-blue-400" />
      </div>
      <h1 class="text-2xl font-bold text-zinc-100">Vega API</h1>
      <p class="text-sm text-zinc-500 mt-1">配置管理面板</p>
    </div>

    <!-- Form -->
    <form onsubmit={handleSubmit} class="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-6 space-y-4">
      <div>
        <label for="password" class="block text-xs font-medium text-zinc-400 mb-1.5">管理密码</label>
        <input
          id="password"
          type="password"
          bind:value={password}
          placeholder="请输入密码"
          autofocus
          class="w-full px-3 py-2.5 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all"
        />
      </div>

      {#if error}
        <p class="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
      {/if}

      <button
        type="submit"
        disabled={loading}
        class="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors shadow-lg shadow-blue-600/20"
      >
        {loading ? "登录中..." : "登 录"}
      </button>

      <p class="text-center text-xs text-zinc-600">
        首次使用？输入新密码即可设置管理密码。
      </p>
    </form>
  </div>
</div>
