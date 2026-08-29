<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import {
    LayoutDashboard, MessageSquare, Network, ListTodo, Settings, Wrench, LogOut,
    ChevronsRight, ChevronsLeft, Zap,
  } from "lucide-svelte";
  import { clearToken } from "$lib/api";
  import { sidebarCollapsed } from "$lib/sidebar-state";

  let { open = null, onnav = () => {} } = $props();

  interface NavItem {
    href: string;
    label: string;
    icon: typeof LayoutDashboard;
    badge?: string;
  }

  const navItems: NavItem[] = [
    { href: "/dashboard", label: "概览", icon: LayoutDashboard },
    { href: "/dashboard/playground", label: "模型调试", icon: MessageSquare },
    { href: "/dashboard/routes", label: "路由拓扑", icon: Network },
    { href: "/dashboard/logs", label: "调用记录", icon: ListTodo },
    { href: "/dashboard/api-settings", label: "API 设置", icon: Settings },
    { href: "/dashboard/settings", label: "设置", icon: Wrench },
  ];

  let collapsed = $derived($sidebarCollapsed);

  function isActive(href: string): boolean {
    if (href === "/dashboard") return $page.url.pathname === "/dashboard";
    return $page.url.pathname.startsWith(href);
  }

  function go(href: string) {
    onnav();
    goto(href);
  }

  function toggleCollapse() {
    sidebarCollapsed.toggle();
  }

  function handleLogout() {
    clearToken();
    window.location.href = "/";
  }
</script>

<aside
  class="sidebar {open ? 'open' : ''}"
  data-od-id="sidebar"
>
  <!-- Brand -->
  <div class="brand">
    <div class="brand-mark">
      <Zap class="w-5 h-5" stroke-width={1.8} />
    </div>
    <div class="brand-txt">
      <div class="brand-name">Vega<em> API</em></div>
      <div class="brand-cap">管理控制台</div>
    </div>
  </div>

  <!-- Nav -->
  <nav class="nav">
    <div class="nav-label">导航</div>
    {#each navItems as item}
      <button
        class="nav-item {isActive(item.href) ? 'active' : ''}"
        onclick={() => go(item.href)}
        title={collapsed ? item.label : ""}
        aria-label={item.label}
      >
        <item.icon stroke-width={1.6} />
        <span class="nav-txt">{item.label}</span>
        {#if item.badge}
          <span class="nav-badge">{item.badge}</span>
        {/if}
      </button>
    {/each}
  </nav>

  <!-- Footer -->
  <div class="side-foot">
    <button class="nav-item" id="collapseBtn" onclick={toggleCollapse} title={collapsed ? "展开侧边栏" : "收起侧边栏"} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}>
      {#if collapsed}
        <ChevronsRight class="collapse-chev" stroke-width={1.8} />
      {:else}
        <ChevronsLeft class="collapse-chev" stroke-width={1.8} />
      {/if}
      <span class="nav-txt">{collapsed ? "展开" : "收起"}</span>
    </button>
    <button class="nav-item logout" onclick={handleLogout} title="退出登录">
      <LogOut stroke-width={1.6} />
      <span class="nav-txt">退出登录</span>
    </button>
    <div class="ver">v2.3.0</div>
  </div>
</aside>
