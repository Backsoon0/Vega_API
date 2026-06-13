<script lang="ts">
  // Shared loading spinner — single source of truth for all loading states
  interface Props {
    size?: 'sm' | 'md';
    class?: string;
  }

  let { size = 'md', class: extraClass = '' }: Props = $props();

  const sizeClasses: Record<string, string> = {
    sm: 'h-3.5 w-3.5',
    md: 'h-6 w-6',
  };
</script>

<svg
  class="animate-spin {sizeClasses[size]} {extraClass}"
  viewBox="0 0 24 24"
  fill="none"
  aria-hidden="true"
>
  <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
  <path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
</svg>
