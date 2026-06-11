// src/log-buffer.ts
// In-memory ring buffer for real-time call logs (not persisted to DB)

import type { LogEntry } from './types';

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];

export function pushLog(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

export function getLogs(since?: string): LogEntry[] {
  if (!since) return [...buffer];
  return buffer.filter(e => e.timestamp >= since);
}

export function clearLogs(): void {
  buffer.length = 0;
}
