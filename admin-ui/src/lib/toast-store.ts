// Toast notification store — replaces fragile window.dispatchEvent pattern
import { writable } from 'svelte/store';

export interface ToastMessage {
  id: number;
  message: string;
  type: 'success' | 'error';
}

let nextId = 0;

function createToastStore() {
  const { subscribe, update } = writable<ToastMessage[]>([]);

  function show(message: string, type: 'success' | 'error' = 'success') {
    const id = ++nextId;
    update((msgs) => [...msgs, { id, message, type }]);
    // Auto-dismiss after 3.5s
    setTimeout(() => dismiss(id), 3500);
  }

  function dismiss(id: number) {
    update((msgs) => msgs.filter((m) => m.id !== id));
  }

  return { subscribe, show, dismiss };
}

export const toasts = createToastStore();
