<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { LayoutDashboard, ListTodo, Settings, Wrench, LogOut, Key } from "lucide-svelte";
  import { clearToken } from "$lib/api";

  interface NavItem {
    href: string;
    label: string;
    icon: typeof LayoutDashboard;
  }

  const navItems: NavItem[] = [
    { href: "/dashboard", label: "概览", icon: LayoutDashboard },
    { href: "/dashboard/logs", label: "调用记录", icon: ListTodo },
    { href: "/dashboard/api-settings", label: "API 设置", icon: Settings },
    { href: "/dashboard/panel-settings", label: "面板设置", icon: Wrench },
  ];

  function isActive(href: string): boolean {
    if (href === "/dashboard") return $page.url.pathname === "/dashboard";
    return $page.url.pathname.startsWith(href);
  }

  function handleLogout() {
    clearToken();
    goto("/");
  }

  let mobileOpen = $state(false);
</script>

<!-- Mobile overlay -->
{#if mobileOpen}
  <div
    class="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
    onclick={() => (mobileOpen = false)}
  ></div>
{/if}

<!-- Sidebar -->
<aside
  class="fixed left-0 top-0 z-50 h-dvh w-[240px] bg-surface border-r border-white/[0.06] flex flex-col
         transition-transform duration-200
         lg:translate-x-0
         {mobileOpen ? 'translate-x-0' : '-translate-x-full'}"
>
  <!-- Logo -->
  <div class="p-4 border-b border-white/[0.06] flex items-center gap-3">
    <div class="flex items-center justify-center w-9 h-9 rounded-xl bg-cta-subtle ring-1 ring-white/[0.06]">
      <Key class="w-[18px] h-[18px] text-cta" stroke-width={1.75} />
    </div>
    <div>
      <div class="text-sm font-bold text-primary font-mono tracking-tight">
        Vega<span class="text-cta font-sans font-semibold"> API</span>
      </div>
      <div class="text-[10px] text-muted">控制台</div>
    </div>
  </div>

  <!-- Nav items -->
  <nav class="flex-1 p-2 flex flex-col gap-1 overflow-y-auto">
    {#each navItems as item}
      <button
        class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-150
               {isActive(item.href)
                 ? 'bg-cta-subtle text-cta font-semibold'
                 : 'text-secondary hover:bg-surface-hover hover:text-primary'}"
        onclick={() => {
          goto(item.href);
          mobileOpen = false;
        }}
      >
        <item.icon class="w-[18px] h-[18px]" stroke-width={1.5} />
        {item.label}
      </button>
    {/each}
  </nav>

  <!-- Footer -->
  <div class="p-2 border-t border-white/[0.06]">
    <button
      class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-muted hover:text-danger hover:bg-danger-subtle transition-all duration-150 w-full"
      onclick={handleLogout}
    >
      <LogOut class="w-[18px] h-[18px]" stroke-width={1.5} />
      退出登录
    </button>
    <div class="px-3 pt-2 pb-1 text-[10px] text-placeholder font-mono text-center">v2.0.0</div>
  </div>
</aside>

<!-- Mobile toggle -->
<button
  class="lg:hidden fixed bottom-5 left-5 z-50 w-11 h-11 rounded-xl bg-cta text-white shadow-lg flex items-center justify-center"
  onclick={() => (mobileOpen = !mobileOpen)}
  aria-label="菜单"
>
  {#if mobileOpen}
    <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
  {:else}
    <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"/></svg>
  {/if}
</button>
