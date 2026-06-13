<script lang="ts">
  import { goto } from "$app/navigation";
  import { login, isAuthenticated } from "$lib/api";
  import { Key, Shield, ChevronRight } from "lucide-svelte";

  let password = $state("");
  let error = $state("");
  let loading = $state(false);
  let showPassword = $state(false);

  // Redirect handled by parent layout — no need for duplicate here

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
			try {
				await goto("/dashboard");
			} catch (navErr) {
				error = "登录成功，跳转失败，正在重定向...";
				setTimeout(() => { window.location.href = "/dashboard"; }, 500);
			}
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
	} catch (err) {
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
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            {:else}
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            {/if}
          </button>
        </div>
      </div>

      <!-- Error -->
      {#if error}
        <div
          class="flex items-start gap-2.5 text-sm text-danger bg-danger-subtle rounded-xl px-4 py-3 border border-danger/20"
          role="alert"
        >
          <svg class="w-4 h-4 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          <span>{error}</span>
        </div>
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
          <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
            <path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
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
