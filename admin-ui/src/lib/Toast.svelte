<script lang="ts">
  /**
   * Toast notification component driven by a Svelte store.
   *
   * Import the store to trigger toasts from anywhere:
   *   import { toasts } from '$lib/toast-store';
   *   toasts.show('保存成功', 'success');
   */
  import { toasts, type ToastMessage } from '$lib/toast-store';

  let items = $state<ToastMessage[]>([]);

  $effect(() => {
    const unsub = toasts.subscribe((v) => (items = v));
    return unsub;
  });
</script>

{#each items as item (item.id)}
  <div
    class="fixed top-4 right-4 z-[200] px-5 py-3 rounded-xl text-sm font-medium
           shadow-2xl backdrop-blur-md
           flex items-center gap-2.5
           animate-toast-in
           {item.type === 'success'
             ? 'bg-success/90 text-white shadow-glow-accent'
             : 'bg-danger/90 text-white'}"
    role="status"
    aria-live="polite"
  >
    <button
      class="absolute -top-1 -right-1 p-1 rounded-full bg-black/20 hover:bg-black/40 text-white/80 hover:text-white transition-colors"
      onclick={() => toasts.dismiss(item.id)}
      aria-label="关闭通知"
    >
      <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>

    {#if item.type === 'success'}
      <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    {:else}
      <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
    {/if}
    <span>{item.message}</span>
  </div>
{/each}
