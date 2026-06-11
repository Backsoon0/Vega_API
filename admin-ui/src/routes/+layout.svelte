<script lang="ts">
  import { isAuthenticated, checkAuth } from "$lib/api";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import Sidebar from "$lib/Sidebar.svelte";
  import Toast from "$lib/Toast.svelte";
  import { sidebarCollapsed, SIDEBAR_EXPANDED, SIDEBAR_COLLAPSED } from "$lib/sidebar-state";
  import "../app.css";

  let { children } = $props();
  let checking = $state(true);
  let authed = $state(false);
  let isDashboard = $state(false);

  let collapsed = $derived($sidebarCollapsed);
  let sidebarWidth = $derived(collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED);

  $effect(() => {
    checkAuth().then((ok) => {
      authed = ok;
      checking = false;
    });
  });

  $effect(() => {
    const path = $page.url.pathname;
    isDashboard = path.startsWith('/dashboard');

    if (!checking && authed !== isAuthenticated()) {
      authed = isAuthenticated();
    }

    if (path === '/' && isAuthenticated()) {
      goto('/dashboard');
    }
  });
</script>

{#if checking}
  <div class="min-h-dvh flex items-center justify-center bg-background">
    <div class="flex flex-col items-center gap-4">
      <svg
        class="animate-spin h-6 w-6 text-cta"
        viewBox="0 0 24 24"
        fill="none"
        aria-label="加载中"
      >
        <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
        <path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <span class="text-sm text-muted font-mono">验证身份...</span>
    </div>
  </div>
{:else if isDashboard && authed}
  <div class="min-h-dvh bg-background flex">
    <Sidebar />
    <main
      class="flex-1 p-3 sm:p-5 lg:p-6 min-h-dvh w-full transition-all duration-300 ease-in-out {collapsed ? 'lg:ml-[64px]' : 'lg:ml-[240px]'}"
    >
      {@render children()}
    </main>
  </div>
  <Toast />
{:else}
  {@render children()}
  <Toast />
{/if}
