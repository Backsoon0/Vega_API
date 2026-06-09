<script lang="ts">
  let { message = $bindable(""), type = $bindable("") }: { message: string; type: string } = $props();

  let visible = $state(false);
  let timer: ReturnType<typeof setTimeout>;

  function show(msg: string, t: "success" | "error" = "success") {
    clearTimeout(timer);
    message = msg;
    type = t;
    visible = true;
    timer = setTimeout(() => (visible = false), 3000);
  }

  // Expose show function globally via a simple event-based mechanism
  function onToast(e: CustomEvent<{ message: string; type: "success" | "error" }>) {
    show(e.detail.message, e.detail.type);
  }

  // Listen for toast events
  $effect(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("toast", onToast as EventListener);
      return () => window.removeEventListener("toast", onToast as EventListener);
    }
  });

  // Also expose directly
  export { show as trigger };
</script>

{#if visible}
  <div
    class="fixed top-6 right-6 z-[200] px-5 py-3 rounded-xl text-sm font-medium shadow-2xl backdrop-blur-md transition-all duration-300 {type === 'success'
      ? 'bg-emerald-500/90 text-white shadow-emerald-500/20'
      : 'bg-red-500/90 text-white shadow-red-500/20'}"
    class:translate-x-0={visible}
    class:translate-x-[120%]={!visible}
  >
    {message}
  </div>
{/if}
