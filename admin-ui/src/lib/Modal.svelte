<script lang="ts">
  import { X } from "lucide-svelte";

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
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-100 flex items-center justify-center bg-black/60 backdrop-blur-sm p-5"
    onclick={close}
    role="dialog"
    aria-modal="true"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
        <h2 class="text-lg font-semibold text-zinc-100">{title}</h2>
        <button
          class="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          onclick={close}
        >
          <X class="w-4 h-4" />
        </button>
      </div>
      <div class="p-6">
        {#if children}
          {@render children()}
        {/if}
      </div>
    </div>
  </div>
{/if}
