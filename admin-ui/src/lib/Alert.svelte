<script lang="ts">
  import { AlertCircle, AlertTriangle, CheckCircle, XCircle, Info } from 'lucide-svelte';

  interface Props {
    type?: 'error' | 'warning' | 'success' | 'info';
    children?: import('svelte').Snippet;
    message?: string;
    class?: string;
  }

  let { type = 'error', children, message, class: extraClass = '' }: Props = $props();

  const styles: Record<string, { bg: string; border: string; text: string; icon: typeof AlertCircle }> = {
    error:   { bg: 'bg-danger-subtle',   border: 'border-danger/20',  text: 'text-danger',   icon: XCircle },
    warning: { bg: 'bg-warning-subtle',  border: 'border-warning/20', text: 'text-warning',  icon: AlertTriangle },
    success: { bg: 'bg-success-subtle',  border: 'border-accent/20',  text: 'text-success',  icon: CheckCircle },
    info:    { bg: 'bg-cta-subtle',      border: 'border-cta/10',     text: 'text-cta',      icon: Info },
  };

  let s = $derived(styles[type]);
</script>

<div
  class="flex items-start gap-2.5 text-sm {s.bg} {s.border} rounded-xl px-4 py-3 border {extraClass}"
  role="alert"
>
  <s.icon class="w-4 h-4 shrink-0 mt-0.5 {s.text}" stroke-width={1.5} />
  {#if children}
    <span class="flex-1">{@render children()}</span>
  {:else if message}
    <span class="flex-1">{message}</span>
  {/if}
</div>
