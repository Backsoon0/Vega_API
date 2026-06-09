<script lang="ts">
  import Modal from "$lib/Modal.svelte";
  import { changePassword } from "$lib/api";

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
</script>

<Modal bind:open title="修改管理密码" {onclose}>
  <form onsubmit={handleSubmit} class="space-y-4">
    <div>
      <label class="block text-xs font-medium text-zinc-400 mb-1.5">当前密码</label>
      <input
        type="password"
        bind:value={currentPassword}
        required
        class="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
      />
    </div>
    <div>
      <label class="block text-xs font-medium text-zinc-400 mb-1.5">新密码（至少6位）</label>
      <input
        type="password"
        bind:value={newPassword}
        required
        minlength="6"
        class="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
      />
    </div>

    {#if error}
      <p class="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
    {/if}

    <div class="flex justify-end gap-3 pt-2">
      <button type="button"
        class="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors"
        onclick={() => open = false}
      >取消</button>
      <button type="submit" disabled={loading}
        class="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
      >{loading ? "修改中..." : "修改密码"}</button>
    </div>
  </form>
</Modal>
