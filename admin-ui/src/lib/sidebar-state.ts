// Shared Svelte writable store for sidebar collapsed state
// Both Sidebar.svelte and +layout.svelte read from this

import { writable } from 'svelte/store';

function createCollapsedStore() {
  const initial = typeof window !== 'undefined'
    ? localStorage.getItem('sidebar_collapsed') === 'true'
    : false;
  const { subscribe, set, update } = writable(initial);

  return {
    subscribe,
    toggle: () => update(v => {
      const next = !v;
      localStorage.setItem('sidebar_collapsed', String(next));
      return next;
    }),
    set: (v: boolean) => {
      localStorage.setItem('sidebar_collapsed', String(v));
      set(v);
    },
  };
}

export const sidebarCollapsed = createCollapsedStore();

// Sidebar widths
export const SIDEBAR_EXPANDED = 240;
export const SIDEBAR_COLLAPSED = 64;
