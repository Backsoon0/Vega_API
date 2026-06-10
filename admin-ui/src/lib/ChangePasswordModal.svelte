<script lang="ts">
  import Modal from "$lib/Modal.svelte";
  import { changePassword } from "$lib/api";
  import { Lock, AlertCircle } from "lucide-svelte";

  interface Props {
    open?: boolean;
    onclose?: () => void;
    onsuccess?: (msg: string) => void;
    onerror?: (msg: string) => void;
  }

  let { open = $bindable(false), onclose, onsuccess, onerror }: Props = $props();

  let currentPassword = $state("");
  let newPassword = $state("");
  let error = $state("");
  let loading = $state(false);
  let showCurrent = $state(false);
  let showNew = $state(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    error = "";

    if (!currentPassword || !newPassword) {
      error = "请填写所有字段";
      return;
    }
    if (newPassword.length < 6) {
      error = "新密码至少需要 6 个字符";
      return;
    }

    loading = true;
    try {
      const result = await changePassword(currentPassword, newPassword);
      if (result.ok) {
        currentPassword = "";
        newPassword = "";
        open = false;
        onsuccess?.("密码已修改");
        onclose?.();
      } else {
        error = result.data?.error || "修改失败";
      }
    } catch (err: any) {
      error = err.message;
      onerror?.(err.message);
    } finally {
      loading = false;
    }
  }

  function handleCancel() {
    currentPassword = "";
    newPassword = "";
    error = "";
    open = false;
  }
</script>

<Modal bind:open title="修改管理密码" onclose={handleCancel}>
  <form onsubmit={handleSubmit} class="space-y-5">
    <!-- Current Password -->
    <div class="space-y-1.5">
      <label for="cp-current" class="block text-xs font-semibold text-secondary uppercase tracking-wider">
        <Lock class="w-3 h-3 inline mr-1.5" />当前密码
      </label>
      <div class="relative">
        <input
          id="cp-current"
          type={showCurrent ? "text" : "password"}
          bind:value={currentPassword}
          required
          autocomplete="current-password"
          class="w-full px-3.5 py-2.5 rounded-xl bg-input border border-white/[0.10] text-primary text-sm font-mono
                 placeholder:text-placeholder
                 focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
                 transition-all duration-200"
        />
        <button type="button"
          class="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary transition-colors p-1"
          onclick={() => (showCurrent = !showCurrent)}
          tabindex="-1"
          aria-label={showCurrent ? "隐藏密码" : "显示密码"}
        >
          {#if showCurrent}
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          {:else}
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          {/if}
        </button>
      </div>
    </div>

    <!-- New Password -->
    <div class="space-y-1.5">
      <label for="cp-new" class="block text-xs font-semibold text-secondary uppercase tracking-wider">
        新密码 <span class="text-muted font-normal normal-case">（至少 6 个字符）</span>
      </label>
      <div class="relative">
        <input
          id="cp-new"
          type={showNew ? "text" : "password"}
          bind:value={newPassword}
          required
          minlength="6"
          autocomplete="new-password"
          class="w-full px-3.5 py-2.5 rounded-xl bg-input border border-white/[0.10] text-primary text-sm font-mono
                 placeholder:text-placeholder
                 focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
                 transition-all duration-200"
        />
        <button type="button"
          class="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary transition-colors p-1"
          onclick={() => (showNew = !showNew)}
          tabindex="-1"
          aria-label={showNew ? "隐藏密码" : "显示密码"}
        >
          {#if showNew}
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          {:else}
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          {/if}
        </button>
      </div>
    </div>

    <!-- Error -->
    {#if error}
      <div class="flex items-start gap-2.5 text-sm text-danger bg-danger-subtle rounded-xl px-4 py-3 border border-danger/20" role="alert">
        <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
        <span>{error}</span>
      </div>
    {/if}

    <!-- Actions -->
    <div class="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-2">
      <button type="button"
        class="w-full sm:w-auto px-5 py-2.5 rounded-xl
               bg-surface-elevated hover:bg-surface-hover text-secondary hover:text-primary
               border border-white/[0.08]
               text-sm font-medium transition-all duration-200"
        onclick={handleCancel}
      >取消</button>
      <button type="submit" disabled={loading}
        class="w-full sm:w-auto px-6 py-2.5 rounded-xl
               bg-cta hover:bg-cta-hover disabled:opacity-40
               text-white text-sm font-semibold tracking-wide
               transition-all duration-200 shadow-glow-cta
               active:scale-[0.98]
               inline-flex items-center justify-center gap-2">
        {#if loading}
          <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
            <path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          修改中...
        {:else}
          修改密码
        {/if}
      </button>
    </div>
  </form>
</Modal>
