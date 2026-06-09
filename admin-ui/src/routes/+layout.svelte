<script lang="ts">
  import { isAuthenticated, checkAuth } from "$lib/api";
  import { page } from "$app/stores";
  import "../app.css";

  let { children } = $props();

  let checking = $state(true);
  let authed = $state(false);

  $effect(() => {
    checkAuth().then((ok) => {
      authed = ok;
      checking = false;
    });
  });

  // Re-check on navigation
  $effect(() => {
    $page.url.pathname; // trigger on navigation
    if (!checking && authed !== isAuthenticated()) {
      authed = isAuthenticated();
    }
  });
</script>

{#if checking}
  <div class="min-h-screen flex items-center justify-center bg-zinc-950">
    <div class="flex items-center gap-3 text-zinc-400">
      <svg class="animate-spin h-5 w-5" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <span class="text-sm">加载中...</span>
    </div>
  </div>
{:else}
  {@render children()}
{/if}
