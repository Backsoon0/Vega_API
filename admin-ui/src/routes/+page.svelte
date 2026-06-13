<script lang="ts">
  import { login } from "$lib/api";
  import { Key, Shield, ChevronRight, Eye, EyeOff } from "lucide-svelte";
  import Spinner from "$lib/Spinner.svelte";
  import Alert from "$lib/Alert.svelte";

  let password = $state("");
  let error = $state("");
  let loading = $state(false);
  let showPassword = $state(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    error = "";

    if (!password) {
      error = "请输入管理密码";
      return;
    }

    loading = true;
    try {
      const result = await login(password);
      if (result.ok) {
        window.location.href = "/dashboard";
      } else {
        const errMsg = typeof result.error === 'string'
          ? result.error
          : (result.error?.message || "登录失败");
        error = errMsg;
        if (result.banned) {
          error += `（封禁剩余 ${Math.ceil(result.remainingSeconds / 60)} 分钟）`;
        } else if (result.remaining !== undefined) {
          error += `（剩余 ${result.remaining} 次尝试）`;
        }
      }
    } catch (err: any) {
      error = "网络错误: " + (err.message || String(err));
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>登录 — Vega API</title>
</svelte:head>

<div class="min-h-dvh flex items-center justify-center bg-background px-4 py-8 sm:px-6">
  <div class="w-full max-w-sm">
    <!-- Logo & Brand -->
    <div class="text-center mb-10">
      <div
        class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-cta-subtle ring-1 ring-white/[0.06] mb-5"
      >
        <Key class="w-7 h-7 text-cta" stroke-width={1.75} />
      </div>
      <h1 class="text-2xl font-bold text-primary tracking-tight font-mono">
        Vega<span class="text-cta font-sans font-semibold"> API</span>
      </h1>
      <p class="text-sm text-muted mt-2">AI 网关 · 配置管理面板</p>
    </div>

    <!-- Login Card -->
    <form
      onsubmit={handleSubmit}
      class="bg-surface border border-white/[0.08] rounded-2xl p-6 sm:p-8 space-y-5 shadow-card"
    >
      <!-- Password Field -->
      <div class="space-y-2">
        <label
          for="password"
          class="flex items-center gap-2 text-xs font-semibold text-secondary uppercase tracking-wider"
        >
          <Shield class="w-3.5 h-3.5" />
          管理密码
        </label>
        <div class="relative">
          <!-- svelte-ignore a11y_autofocus -->
          <input
            id="password"
            type={showPassword ? "text" : "password"}
            bind:value={password}
            placeholder="请输入管理密码"
            autofocus
            autocomplete="current-password"
            class="w-full px-4 py-3 rounded-xl bg-input border border-white/[0.10] text-primary text-sm
                   placeholder:text-placeholder
                   focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
                   transition-all duration-200 font-mono tracking-wide"
          />
          <button
            type="button"
            class="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary transition-colors p-1"
            onclick={() => (showPassword = !showPassword)}
            tabindex="-1"
            aria-label={showPassword ? "隐藏密码" : "显示密码"}
          >
            {#if showPassword}
              <EyeOff class="w-4 h-4" stroke-width={1.5} />
            {:else}
              <Eye class="w-4 h-4" stroke-width={1.5} />
            {/if}
          </button>
        </div>
      </div>

      <!-- Error -->
      {#if error}
        <Alert type="error" message={error} />
      {/if}

      <!-- Submit -->
      <button
        type="submit"
        disabled={loading}
        class="w-full py-3 rounded-xl bg-cta hover:bg-cta-hover disabled:opacity-40
               text-white text-sm font-semibold tracking-wide
               transition-all duration-200
               shadow-glow-cta
               active:scale-[0.98]
               flex items-center justify-center gap-2"
      >
        {#if loading}
          <Spinner size="sm" />
          <span>验证中...</span>
        {:else}
          <span>登 录</span>
          <ChevronRight class="w-4 h-4" />
        {/if}
      </button>

      <!-- Hint -->
      <p class="text-center text-xs text-muted pt-1">
        首次使用？输入新密码即可设置管理密码
      </p>
    </form>
  </div>
</div>
