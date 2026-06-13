// Shared utility functions used across components

/** Format token count as human-readable string */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

/** Format number with locale separators */
export function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Format duration in ms to human-readable string */
export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '-';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const secs = Math.floor(ms / 1000);
  return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
}

/** Format ISO timestamp to Chinese locale string */
export function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

/** Create an AbortController that auto-cancels after timeout ms */
export function createTimeoutController(timeoutMs: number): {
  controller: AbortController;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    clear: () => clearTimeout(timer),
  };
}
