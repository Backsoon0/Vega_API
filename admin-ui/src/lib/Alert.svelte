<script lang="ts">
  interface Props {
    type?: 'error' | 'warning' | 'success' | 'info';
    children?: import('svelte').Snippet;
    message?: string;
    class?: string;
  }

  let { type = 'error', children, message, class: extraClass = '' }: Props = $props();

  const styles: Record<string, { color: string; bg: string; border: string; icon: string }> = {
    error:   { color: 'var(--danger)',   bg: 'var(--danger-soft)',   border: 'rgba(239,68,68,.2)',     icon: 'M12 9v4M12 17h.01' },
    warning: { color: 'var(--warning)',  bg: 'var(--warning-soft)',  border: 'rgba(245,158,11,.2)',    icon: 'M12 9v4M12 17h.01' },
    success: { color: 'var(--success)',  bg: 'var(--success-soft)',  border: 'rgba(34,197,94,.2)',     icon: 'M20 6 9 17l-5-5' },
    info:    { color: 'var(--cta)',      bg: 'var(--cta-soft)',      border: 'rgba(59,130,246,.2)',    icon: 'M12 16v-4M12 8h.01' },
  };

  let s = $derived(styles[type]);
  let iconPath = $derived(styles[type]?.icon || styles.info.icon);
</script>

<div
  class="flex items-start gap-2.5 text-[13px] rounded-[10px] px-4 py-3 border-l-2 {extraClass}"
  style={{
    backgroundColor: s.bg,
    border: '1px solid ' + s.border,
    borderLeft: '2px solid ' + s.color,
    color: s.color
  }}
  role="alert"
>
  <svg class="shrink-0" style="width:16px;height:16px;margin-top:1px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d={iconPath} />
  </svg>
  {#if children}
    <span class="flex-1">{@render children()}</span>
  {:else if message}
    <span class="flex-1">{message}</span>
  {/if}
</div>
