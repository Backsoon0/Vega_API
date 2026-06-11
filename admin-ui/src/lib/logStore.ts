// admin-ui/src/lib/logStore.ts
// localStorage persistence for real-time call logs

export interface CallLogEntry {
  timestamp: string;
  ip: string;
  providerId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  success: boolean;
}

const STORAGE_KEY = 'vega_call_logs';
const MAX_STORED = 2000;

function load(): CallLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function save(entries: CallLogEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch { /* quota exceeded */ }
}

export function getLogs(): CallLogEntry[] {
  return load();
}

export function mergeLogs(newEntries: CallLogEntry[]): void {
  const existing = load();
  const existingIds = new Set(
    existing.map(e => e.timestamp + e.ip + e.model)
  );
  const fresh = newEntries.filter(
    e => !existingIds.has(e.timestamp + e.ip + e.model)
  );
  if (fresh.length === 0) return;
  const merged = [...fresh, ...existing].slice(0, MAX_STORED);
  save(merged);
}

export function clearLogs(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function searchLogs(
  entries: CallLogEntry[],
  query: string
): CallLogEntry[] {
  if (!query.trim()) return entries;
  const q = query.toLowerCase();
  return entries.filter(e =>
    e.ip.toLowerCase().includes(q) ||
    e.providerId.toLowerCase().includes(q) ||
    e.model.toLowerCase().includes(q)
  );
}
