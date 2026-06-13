<script lang="ts">
  import { changePassword } from "$lib/api";
  import { Wrench, Lock, Eye, EyeOff } from "lucide-svelte";
  import Alert from "$lib/Alert.svelte";
  import Spinner from "$lib/Spinner.svelte";

  let currentPassword = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let showCurrent = $state(false);
  let showNew = $state(false);
  let showConfirm = $state(false);
  let saving = $state(false);
  let message = $state('');
  let error = $state('');

  async function handleChangePassword(e: Event) {
    e.preventDefault();
    error = ''; message = '';
    if (!currentPassword || !newPassword || !confirmPassword) {
      error = '请填写所有字段'; return;
    }
    if (newPassword.length < 6) {
      error = '新密码至少 6 个字符'; return;
    }
    if (newPassword !== confirmPassword) {
      error = '两次输入的新密码不一致'; return;
    }
    saving = true;
    try {
      const res = await changePassword(currentPassword, newPassword);
      if (res.ok) {
        message = '密码修改成功';
        currentPassword = ''; newPassword = ''; confirmPassword = '';
      } else {
        error = res.error || '修改失败';
      }
    } catch (err: any) {
      error = err.message || '修改失败';
    } finally { saving = false; }
  }
</script>

<svelte:head><title>面板设置 — Vega API</title></svelte:head>

<div class="max-w-6xl mx-auto">
  <div class="mb-8">
    <h1 class="text-lg font-bold text-primary font-mono flex items-center gap-2">
      <Wrench class="w-5 h-5" stroke-width={1.5} />
      面板设置
    </h1>
    <p class="text-xs text-muted mt-1">管理密码和安全设置</p>
  </div>

  <div class="max-w-md">
    <div class="bg-surface border border-white/[0.06] rounded-xl p-6">
      <h2 class="text-sm font-semibold text-primary mb-6 flex items-center gap-2">
        <Lock class="w-4 h-4" stroke-width={1.5} />
        修改管理密码
      </h2>

      <form onsubmit={handleChangePassword} class="space-y-4">
        <!-- Current Password -->
        <div>
          <label for="current-password" class="block text-xs text-secondary mb-1.5">当前密码</label>
          <div class="relative">
            <input
              id="current-password"
              type={showCurrent ? 'text' : 'password'}
              class="w-full px-3 py-2.5 bg-input border border-white/[0.08] rounded-lg text-sm text-primary placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/50"
              bind:value={currentPassword}
              placeholder="输入当前密码"
            />
            <button
              type="button"
              class="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary p-1 transition-colors"
              onclick={() => (showCurrent = !showCurrent)}
              aria-label={showCurrent ? '隐藏密码' : '显示密码'}
            >
              {#if showCurrent}
                <EyeOff class="w-3.5 h-3.5" stroke-width={1.5} />
              {:else}
                <Eye class="w-3.5 h-3.5" stroke-width={1.5} />
              {/if}
            </button>
          </div>
        </div>

        <!-- New Password -->
        <div>
          <label for="new-password" class="block text-xs text-secondary mb-1.5">新密码</label>
          <div class="relative">
            <input
              id="new-password"
              type={showNew ? 'text' : 'password'}
              class="w-full px-3 py-2.5 bg-input border border-white/[0.08] rounded-lg text-sm text-primary placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/50"
              bind:value={newPassword}
              placeholder="至少 6 个字符"
            />
            <button
              type="button"
              class="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary p-1 transition-colors"
              onclick={() => (showNew = !showNew)}
              aria-label={showNew ? '隐藏密码' : '显示密码'}
            >
              {#if showNew}
                <EyeOff class="w-3.5 h-3.5" stroke-width={1.5} />
              {:else}
                <Eye class="w-3.5 h-3.5" stroke-width={1.5} />
              {/if}
            </button>
          </div>
        </div>

        <!-- Confirm New Password -->
        <div>
          <label for="confirm-password" class="block text-xs text-secondary mb-1.5">确认新密码</label>
          <div class="relative">
            <input
              id="confirm-password"
              type={showConfirm ? 'text' : 'password'}
              class="w-full px-3 py-2.5 bg-input border border-white/[0.08] rounded-lg text-sm text-primary placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/50"
              bind:value={confirmPassword}
              placeholder="再次输入新密码"
            />
            <button
              type="button"
              class="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary p-1 transition-colors"
              onclick={() => (showConfirm = !showConfirm)}
              aria-label={showConfirm ? '隐藏密码' : '显示密码'}
            >
              {#if showConfirm}
                <EyeOff class="w-3.5 h-3.5" stroke-width={1.5} />
              {:else}
                <Eye class="w-3.5 h-3.5" stroke-width={1.5} />
              {/if}
            </button>
          </div>
        </div>

        {#if error}
          <Alert type="error" message={error} />
        {/if}
        {#if message}
          <Alert type="success" message={message} />
        {/if}

        <button
          type="submit"
          disabled={saving}
          class="w-full py-2.5 text-sm font-semibold rounded-xl bg-cta hover:bg-cta-hover text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {#if saving}
            <Spinner size="sm" />
            保存中...
          {:else}
            修改密码
          {/if}
        </button>
      </form>
    </div>
  </div>
</div>
