<script lang="ts">
  import { login } from "$lib/api";

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
        const errMsg = typeof result.error === "string"
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

<section class="login" id="loginView" data-od-id="login" style="display:grid">
  <div class="login-card">
    <div class="login-logo">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    </div>
    <h1>Vega <em style="font-style:normal;color:var(--cta)">API</em></h1>
    <p class="sub">AI 网关 · 配置管理控制台</p>
    <div class="login-box">
      <label for="adminPass">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        管理密码
      </label>
      <div class="field">
        <div style="position:relative">
          <input
            id="adminPass"
            type={showPassword ? "text" : "password"}
            class="input"
            placeholder="请输入管理密码"
            style="padding-right:42px"
            autocomplete="current-password"
            bind:value={password}
            onkeydown={(e) => { if (e.key === "Enter") handleSubmit(e); }}
          />
          <button
            type="button"
            class="icon-btn"
            onclick={() => (showPassword = !showPassword)}
            style="position:absolute;right:4px;top:50%;transform:translateY(-50%);width:32px;height:32px"
            aria-label={showPassword ? "隐藏密码" : "显示密码"}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8">
              {#if showPassword}
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                <circle cx="12" cy="12" r="3" />
              {:else}
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                <circle cx="12" cy="12" r="3" />
                <line x1="2" y1="2" x2="22" y2="22" />
              {/if}
            </svg>
          </button>
        </div>
      </div>

      {#if error}
        <div
          style="display:flex;align-items:flex-start;gap:8px;background:var(--danger-soft);border:1px solid rgba(239,68,68,.2);border-radius:var(--r-sm);padding:10px 12px;font-size:12.5px;color:var(--danger);margin-bottom:12px"
          role="alert"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" style="margin-top:1px;flex-shrink:0">
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.2 2.3 18a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0z" />
          </svg>
          <span>{error}</span>
        </div>
      {/if}

      <button
        class="btn btn-primary"
        onclick={handleSubmit}
        style="width:100%;font-size:14px;padding:12px"
        disabled={loading}
      >
        {#if loading}
          <span class="spark"></span>
          验证中...
        {:else}
          进入控制台
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        {/if}
      </button>
      <p style="font-size:12px;text-align:center;margin-top:16px;color:var(--muted)">首次使用？输入新密码即可设置管理密码</p>
    </div>
  </div>
</section>
