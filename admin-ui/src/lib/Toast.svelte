<script lang="ts">
  /**
   * Toast notification component with event-based triggering.
   *
   * Usage from any component:
   *   window.dispatchEvent(new CustomEvent("toast", { detail: { message: "...", type: "success" } }));
   *
   * Or import and call directly:
   *   import Toast from "$lib/Toast.svelte";
   *   // Toast.trigger is exported for direct use
   */

  interface ToastDetail {
    message: string;
    type: "success" | "error";
  }

  let visible = $state(false);
  let message = $state("");
  let type = $state<"success" | "error">("success");
  let exiting = $state(false);
  let timer: ReturnType<typeof setTimeout>;
  let exitTimer: ReturnType<typeof setTimeout>;

  function show(msg: string, t: "success" | "error" = "success") {
    clearTimeout(timer);
    clearTimeout(exitTimer);
    exiting = false;
    message = msg;
    type = t;
    visible = true;
    timer = setTimeout(() => dismiss(), 3500);
  }

  function dismiss() {
    exiting = true;
    exitTimer = setTimeout(() => {
      visible = false;
      exiting = false;
    }, 250);
  }

  function onToast(e: CustomEvent<ToastDetail>) {
    show(e.detail.message, e.detail.type);
  }

  $effect(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("toast", onToast as EventListener);
      return () => window.removeEventListener("toast", onToast as EventListener);
    }
  });

  export { show as trigger };
</script>

{#if visible}
  <div
    class="fixed top-4 right-4 z-[200] px-5 py-3 rounded-xl text-sm font-medium
           shadow-2xl backdrop-blur-md
           flex items-center gap-2.5
           transition-all duration-250
           {type === 'success'
             ? 'bg-success/90 text-white shadow-glow-accent'
             : 'bg-danger/90 text-white'}"
    class:translate-y-0={!exiting}
    class:opacity-100={!exiting}
    class:-translate-y-2={exiting}
    class:opacity-0={exiting}
    role="status"
    aria-live="polite"
  >
    <button
      class="absolute -top-1 -right-1 p-1 rounded-full bg-black/20 hover:bg-black/40 text-white/80 hover:text-white transition-colors"
      onclick={dismiss}
      aria-label="关闭通知"
    >
      <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>

    {#if type === "success"}
      <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    {:else}
      <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
    {/if}
    <span>{message}</span>
  </div>
{/if}
