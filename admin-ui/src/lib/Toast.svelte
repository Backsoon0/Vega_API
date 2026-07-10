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
    class="fixed top-4 right-4 z-[200] pl-6 pr-5 py-3.5 rounded-xl text-sm font-medium
           glass-surface shadow-elevated
           flex items-center gap-2.5
           animate-toast-in
           {item.type === 'success'
             ? 'ring-1 ring-accent/30'
             : 'ring-1 ring-danger/30'}"
    role="status"
    aria-live="polite"
  >
    <!-- Gradient accent bar -->
    <div
      class="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl
             {item.type === 'success'
               ? 'bg-gradient-to-b from-accent to-accent-hover'
               : 'bg-gradient-to-b from-danger to-danger-hover'}"
      aria-hidden="true"
    ></div>

    <button
      class="absolute -top-1 -right-1 p-1 rounded-full bg-white/10 hover:bg-white/20 text-secondary hover:text-primary transition-colors"
      onclick={() => toasts.dismiss(item.id)}
      aria-label="关闭通知"
    >
      <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>

    {#if item.type === 'success'}
      <svg class="w-4 h-4 shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    {:else}
      <svg class="w-4 h-4 shrink-0 text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
    {/if}
    <span class="text-primary">{item.message}</span>
  </div>
{/each}
