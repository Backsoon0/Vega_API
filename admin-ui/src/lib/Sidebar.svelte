<script lang="ts">
  import { page } from "$app/stores";
  import { LayoutDashboard, ListTodo, Settings, Wrench, LogOut, Key, ChevronLeft, ChevronRight, Menu } from "lucide-svelte";
  import { clearToken, isAuthenticated } from "$lib/api";
  import { sidebarCollapsed } from "$lib/sidebar-state";

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

  let collapsed = $derived($sidebarCollapsed);

  function toggleCollapse() {
    sidebarCollapsed.toggle();
  }

  function isActive(href: string): boolean {
    if (href === "/dashboard") return $page.url.pathname === "/dashboard";
    return $page.url.pathname.startsWith(href);
  }

  function handleLogout() {
    clearToken();
    window.location.href = "/";
  }

  let mobileOpen = $state(false);

  function closeMobile() {
    mobileOpen = false;
  }
</script>

<!-- Mobile overlay -->
{#if mobileOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
    onclick={closeMobile}
    onkeydown={(e) => { if (e.key === 'Escape') closeMobile(); }}
    role="button"
    tabindex="-1"
  ></div>
{/if}

<!-- Mobile toggle button -->
<button
  class="lg:hidden fixed bottom-5 left-5 z-50 w-11 h-11 rounded-xl bg-cta text-white shadow-lg flex items-center justify-center"
  onclick={() => (mobileOpen = !mobileOpen)}
  aria-label="菜单"
>
  <Menu class="w-5 h-5" stroke-width={1.5} />
</button>

<!-- Sidebar -->
<aside
  class="fixed left-0 top-0 z-50 h-dvh bg-surface border-r border-white/[0.06] flex flex-col
         transition-all duration-300 ease-in-out
         lg:translate-x-0
         {mobileOpen ? 'translate-x-0' : '-translate-x-full'}
         {collapsed ? 'w-[64px]' : 'w-[240px]'}"
>
  <!-- Logo -->
  <div class="p-3 border-b border-white/[0.06] flex items-center gap-3 overflow-hidden" class:justify-center={collapsed}>
    <div class="flex items-center justify-center w-9 h-9 shrink-0 rounded-xl bg-cta-subtle ring-1 ring-white/[0.06]">
      <Key class="w-[18px] h-[18px] text-cta" stroke-width={1.75} />
    </div>
    {#if !collapsed}
      <div class="min-w-0">
        <div class="text-sm font-bold text-primary font-mono tracking-tight truncate">
          Vega<span class="text-cta font-sans font-semibold"> API</span>
        </div>
        <div class="text-[10px] text-muted">控制台</div>
      </div>
    {/if}
  </div>

  <!-- Nav items -->
  <nav class="flex-1 p-2 flex flex-col gap-1 overflow-y-auto">
    {#each navItems as item}
      <button
        class="flex items-center gap-3 rounded-lg text-sm transition-all duration-150 overflow-hidden
               {isActive(item.href)
                 ? 'bg-cta-subtle text-cta font-semibold'
                 : 'text-secondary hover:bg-surface-hover hover:text-primary'}
               {collapsed ? 'justify-center p-2.5' : 'px-3 py-2.5'}"
        onclick={() => {
          closeMobile();
          window.location.href = item.href;
        }}
        title={collapsed ? item.label : ''}
      >
        <item.icon class="w-[18px] h-[18px] shrink-0" stroke-width={1.5} />
        {#if !collapsed}
          <span class="truncate">{item.label}</span>
        {/if}
      </button>
    {/each}
  </nav>

  <!-- Footer -->
  <div class="p-2 border-t border-white/[0.06] space-y-1">
    <!-- Collapse toggle (desktop only) -->
    <button
      class="hidden lg:flex items-center gap-3 rounded-lg text-sm text-muted hover:text-secondary hover:bg-surface-hover transition-all duration-150 w-full overflow-hidden
             {collapsed ? 'justify-center p-2.5' : 'px-3 py-2.5'}"
      onclick={toggleCollapse}
      title={collapsed ? '展开侧边栏' : '收起侧边栏'}
    >
      {#if collapsed}
        <ChevronRight class="w-[18px] h-[18px] shrink-0" stroke-width={1.5} />
      {:else}
        <ChevronLeft class="w-[18px] h-[18px] shrink-0" stroke-width={1.5} />
        <span class="truncate">收起</span>
      {/if}
    </button>

    <button
      class="flex items-center gap-3 rounded-lg text-sm text-muted hover:text-danger hover:bg-danger-subtle transition-all duration-150 w-full overflow-hidden
             {collapsed ? 'justify-center p-2.5' : 'px-3 py-2.5'}"
      onclick={handleLogout}
      title={collapsed ? '退出登录' : ''}
    >
      <LogOut class="w-[18px] h-[18px] shrink-0" stroke-width={1.5} />
      {#if !collapsed}
        <span class="truncate">退出登录</span>
      {/if}
    </button>
    <div class="text-[10px] text-placeholder font-mono text-center pt-1" class:hidden={collapsed}>v2.0.0</div>
  </div>
</aside>
