<script lang="ts">
  import { X } from "lucide-svelte";
  import { fly, fade } from "svelte/transition";

  interface Props {
    title: string;
    open?: boolean;
    onclose?: () => void;
    children?: import("svelte").Snippet;
  }

  let { title, open = $bindable(false), onclose, children }: Props = $props();

  function close() {
    open = false;
    onclose?.();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  function onBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <!-- Backdrop -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-100 flex items-start sm:items-center justify-center
           bg-black/60 backdrop-blur-sm
           px-4 py-6 sm:p-6"
    onclick={onBackdropClick}
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    transition:fade={{ duration: 200 }}
  >
    <!-- Panel -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="bg-surface border border-white/[0.08] rounded-2xl shadow-modal
             w-full max-w-lg max-h-[85dvh] overflow-y-auto
             mx-auto"
      onclick={(e) => e.stopPropagation()}
      role="document"
      transition:fly={{ y: 24, duration: 250, easing: (t: number) => 1 - Math.pow(1 - t, 3) }}
    >
      <!-- Header -->
      <div
        class="sticky top-0 z-10 flex items-center justify-between px-5 sm:px-6 py-4
               bg-surface border-b border-white/[0.06] rounded-t-2xl backdrop-blur-sm"
      >
        <h2 class="text-base font-semibold text-primary font-mono tracking-tight">{title}</h2>
        <button
          class="p-2 -mr-1 rounded-lg hover:bg-surface-hover text-muted hover:text-secondary transition-all duration-150"
          onclick={close}
          aria-label="关闭对话框"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Body -->
      <div class="p-5 sm:p-6">
        {#if children}
          {@render children()}
        {/if}
      </div>
    </div>
  </div>
{/if}
