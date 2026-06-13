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

  let collapsed = $derived($sidebarCollapsed);
  let sidebarWidth = $derived(collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED);

  // Init from $page directly (Svelte auto-subscribes) — no flash on first render
  let isDashboard = $state($page.url.pathname.startsWith('/dashboard'));

  $effect(() => {
    isDashboard = $page.url.pathname.startsWith('/dashboard');

    if ($page.url.pathname === '/' && isAuthenticated()) {
      goto('/dashboard');
      return;
    }

    if (isDashboard) {
      // Only check auth if we don't already know we're authenticated
      if (authed) {
        checking = false;
        return;
      }
      checkAuth().then((ok) => {
        authed = ok;
        checking = false;
        if (!ok) {
          window.location.href = '/';
        }
      });
    } else {
      checking = false;
    }
  });
</script>

{#if isDashboard}
  <div class="min-h-dvh bg-background flex">
    <Sidebar />
    <main
      class="flex-1 p-3 sm:p-5 lg:p-6 min-h-dvh w-full transition-all duration-300 ease-in-out {collapsed ? 'lg:ml-[64px]' : 'lg:ml-[240px]'}"
    >
      {#if checking}
        <div class="flex items-center justify-center min-h-[50vh]">
          <div class="flex flex-col items-center gap-4">
            <svg class="animate-spin h-6 w-6 text-cta" viewBox="0 0 24 24" fill="none">
              <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
              <path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span class="text-sm text-muted font-mono">验证身份...</span>
          </div>
        </div>
      {:else}
        <div class="animate-fade-in">
          {@render children()}
        </div>
      {/if}
    </main>
  </div>
{:else}
  <div class="animate-fade-in">
    {@render children()}
  </div>
{/if}

<Toast />
