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

<div class="toasts" id="toasts">
  {#each items as item (item.id)}
    <div class="toast {item.type === 'success' ? 'ok' : 'err'}" role="status" aria-live="polite">
      <span class="ic">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          {#if item.type === 'success'}
            <path d="M20 6 9 17l-5-5" />
          {:else}
            <path d="M18 6 6 18M6 6l12 12" />
          {/if}
        </svg>
      </span>
      <span>{item.message}</span>
      <button
        class="icon-btn"
        style="width:26px;height:26px;margin-left:6px;flex-shrink:0"
        onclick={() => toasts.dismiss(item.id)}
        aria-label="关闭通知"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>
  {/each}
</div>
