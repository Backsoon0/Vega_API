<script lang="ts">
  import { isAuthenticated, checkAuth } from "$lib/api";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import Sidebar from "$lib/Sidebar.svelte";
  import Toast from "$lib/Toast.svelte";
  import { toasts } from "$lib/toast-store";
  import { sidebarCollapsed } from "$lib/sidebar-state";
  import { Menu, RefreshCw, User, LayoutDashboard, MessageSquare, Network, ListTodo, Settings } from "lucide-svelte";
  import "../app.css";

  let { children } = $props();
  let checking = $state(true);
  let authed = $state(false);

  let collapsed = $derived($sidebarCollapsed);

  // Init from $page directly (Svelte auto-subscribes) — no flash on first render
  let isDashboard = $state($page.url.pathname.startsWith("/dashboard"));

  const CRUMBS: Record<string, [string, string]> = {
    "/dashboard": ["概览", "Vega API 运行状态一览"],
    "/dashboard/playground": ["模型调试", "选择模型进行流式对话测试"],
    "/dashboard/routes": ["路由拓扑", "模型路由关系与实时统计"],
    "/dashboard/logs": ["调用记录", "全部 API 调用明细"],
    "/dashboard/api-settings": ["API 设置", "管理 AI 提供商与客户端密钥"],
    "/dashboard/settings": ["设置", "路由策略、熔断与显示偏好"],
  };
  let crumb = $derived(CRUMBS[$page.url.pathname] || ["Vega API", "管理控制台"]);

  let mobileOpen = $state(false);
  function closeMobile() {
    mobileOpen = false;
  }
  function openMobile() {
    mobileOpen = true;
  }

  function refresh() {
    toasts.show("数据已刷新");
  }

  const TAB_ITEMS = [
    { href: "/dashboard", label: "概览", icon: LayoutDashboard },
    { href: "/dashboard/playground", label: "调试", icon: MessageSquare },
    { href: "/dashboard/routes", label: "路由", icon: Network },
    { href: "/dashboard/logs", label: "记录", icon: ListTodo },
    { href: "/dashboard/api-settings", label: "API", icon: Settings },
  ];
  function tabActive(href: string): boolean {
    if (href === "/dashboard") return $page.url.pathname === "/dashboard";
    return $page.url.pathname.startsWith(href);
  }

  $effect(() => {
    isDashboard = $page.url.pathname.startsWith("/dashboard");

    if ($page.url.pathname === "/" && isAuthenticated()) {
      goto("/dashboard");
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
          window.location.href = "/";
        }
      });
    } else {
      checking = false;
    }
  });
</script>

{#if isDashboard}
  <div class="app {collapsed ? 'collapsed' : ''}" id="appShell">
    <!-- Sidebar -->
    <Sidebar open={mobileOpen} onnav={closeMobile} />

    <!-- Scrim for mobile nav -->
    <div class="scrim {mobileOpen ? 'on' : ''}" onclick={closeMobile} role="presentation"></div>

    <!-- Main -->
    <div class="main">
      <header class="topbar" data-od-id="topbar">
        <button class="hamburger" onclick={openMobile} aria-label="菜单" title="菜单">
          <Menu stroke-width={1.8} />
        </button>
        <div class="crumb">
          <div class="t">{crumb[0]}</div>
          <div class="s">{crumb[1]}</div>
        </div>
        <div class="topbar-right">
          <span class="status-pill">
            <span class="dot"></span>
            <span>运行中</span>
          </span>
          <button class="icon-btn" onclick={refresh} title="刷新" aria-label="刷新">
            <RefreshCw stroke-width={1.8} />
          </button>
          <button
            class="icon-btn"
            onclick={() => goto("/dashboard/settings")}
            title="账户"
            aria-label="账户"
            style="border:1px solid var(--b-def)"
          >
            <User stroke-width={1.8} />
          </button>
        </div>
      </header>

      <main class="content">
        <div class="content-inner">
          {#if checking}
            <div class="empty" style="min-height:50vh;display:grid;place-items:center">
              <div class="flex items-center justify-center min-h-[50vh]">
                <div class="flex flex-col items-center gap-4">
                  <svg class="animate-spin h-6 w-6 text-cta" viewBox="0 0 24 24" fill="none">
                    <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
                    <path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span class="mono" style="font-size:13px;color:var(--muted)">验证身份...</span>
                </div>
              </div>
            </div>
          {:else}
            {@render children()}
          {/if}
        </div>
      </main>
    </div>

    <!-- Mobile tab bar -->
    <nav class="tabbar" data-od-id="tabbar">
      {#each TAB_ITEMS as tab}
        <button
          class="tab {tabActive(tab.href) ? 'active' : ''}"
          onclick={() => goto(tab.href)}
          aria-label={tab.label}
        >
          <tab.icon stroke-width={1.7} />
          {tab.label}
        </button>
      {/each}
    </nav>
  </div>
{:else}
  <div class="animate-fade-in">
    {@render children()}
  </div>
{/if}

<Toast />
