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

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Parse an instant coming from the API. The backend buckets on **UTC**, so an
 * hourly key (`YYYY-MM-DDTHH`) carries no zone marker and must be read as UTC
 * (`new Date('2026-09-12T14')` would be treated as LOCAL time by ES2016+).
 */
function parseUtcInstant(value: string): Date {
  const key = /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(value) ? `${value}:00:00Z` : value;
  return new Date(key);
}

/** `HH:MM` of a UTC timestamp / hourly bucket key in the *viewer's* timezone. */
export function formatClockLocal(value: string): string {
  const d = parseUtcInstant(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `MM-DD HH:MM` — for buckets that can straddle days (multi-day ranges), viewer-local. */
export function formatDayClockLocal(value: string): string {
  const d = parseUtcInstant(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `YYYY-MM-DD HH:MM` — spreadsheet-friendly, viewer-local (used by CSV export). */
export function formatDateTimeLocal(value: string): string {
  const d = parseUtcInstant(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
