<script lang="ts">
  import { isAuthenticated, checkAuth } from "$lib/api";
  import { page } from "$app/stores";
  import Toast from "$lib/Toast.svelte";
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

  $effect(() => {
    $page.url.pathname;
    if (!checking && authed !== isAuthenticated()) {
      authed = isAuthenticated();
    }
  });
</script>

{#if checking}
  <div class="min-h-dvh flex items-center justify-center bg-background">
    <div class="flex flex-col items-center gap-4">
      <!-- Spinner -->
      <svg
        class="animate-spin h-6 w-6 text-cta"
        viewBox="0 0 24 24"
        fill="none"
        aria-label="加载中"
      >
        <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
        <path
          class="opacity-80"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      <span class="text-sm text-muted font-mono">验证身份...</span>
    </div>
  </div>
{:else}
  {@render children()}
  <Toast />
{/if}
