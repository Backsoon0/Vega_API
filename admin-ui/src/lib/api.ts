// API client for Vega API admin endpoints
// All requests go to /admin/* on the same origin

import { writable, get } from 'svelte/store';

let _authToken = '';
let _restored = false;

// Restore token from localStorage on load
if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('admin_token');
  if (saved) _authToken = saved;
  _restored = true;
}

// Live-updating auth token (reactive for components)
export const authToken = writable(_authToken);

function setToken(token: string) {
  _authToken = token;
  authToken.set(token);
  localStorage.setItem('admin_token', token);
}

function clearToken() {
  _authToken = '';
  authToken.set('');
  localStorage.removeItem('admin_token');
}

function isAuthenticated() {
  return !!_authToken;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<{ ok: boolean; status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (_authToken) {
    headers['Authorization'] = `Bearer ${_authToken}`;
  }

  const fetchOpts: RequestInit = { method, headers };
  if (body !== undefined) {
    fetchOpts.body = JSON.stringify(body);
  }
  if (opts?.signal) {
    fetchOpts.signal = opts.signal;
  }

  const resp = await fetch(`/admin${path}`, fetchOpts);
  let data;
  try {
    data = await resp.json();
  } catch {
    data = {};
  }

  // Auto-logout on 401
  if (resp.status === 401) {
    clearToken();
  }

  return { ok: resp.ok, status: resp.status, data };
}

// Auth
export async function login(password: string) {
  const { ok, data } = await request('POST', '/auth', { password });
  if (ok && data.token) {
    setToken(data.token);
  }
  return { ok, ...data };
}

export async function checkAuth(): Promise<boolean> {
  if (!_authToken) return false;
  const { ok } = await request('GET', '/check');
  if (!ok) clearToken();
  return ok;
}

// Providers
export async function getProviders() {
  const { ok, data } = await request('GET', '/providers');
  if (!ok) throw new Error(data.error || 'Failed to fetch providers');
  return data as Provider[];
}

export async function createProvider(provider: ProviderInput) {
  const { ok, data } = await request('POST', '/providers', provider);
  if (!ok) throw new Error(data.error || 'Failed to create provider');
  return data;
}

export async function updateProvider(id: string, provider: ProviderInput) {
  const { ok, data } = await request(
    'PUT',
    `/providers/${encodeURIComponent(id)}`,
    provider,
  );
  if (!ok) throw new Error(data.error || 'Failed to update provider');
  return data;
}

export async function deleteProvider(id: string) {
  const { ok, data } = await request(
    'DELETE',
    `/providers/${encodeURIComponent(id)}`,
  );
  if (!ok) throw new Error(data.error || 'Failed to delete provider');
}

// Client API Key
export async function getClientKey() {
  const { ok, data } = await request('GET', '/client-key');
  return data as ClientKeyInfo;
}

export async function setClientKey(key?: string, generate?: boolean) {
  const { ok, data } = await request('POST', '/client-key', {
    key,
    generate,
  });
  if (!ok) throw new Error(data.error || 'Failed to set API key');
  return data as { ok: boolean; message: string; masked: string; fullKey: string; configured: boolean };
}

export async function deleteClientKey() {
  const { ok, data } = await request('DELETE', '/client-key');
  if (!ok) throw new Error(data.error || 'Failed to delete API key');
  return data;
}

export async function revealClientKey() {
  const { ok, data } = await request('GET', '/client-key?reveal=true');
  if (!ok) throw new Error(data.error || 'Failed to reveal API key');
  return data as ClientKeyInfo & { fullKey?: string };
}

// Password
export async function changePassword(currentPassword: string, newPassword: string) {
  const { ok, data } = await request('POST', '/change-password', {
    currentPassword,
    newPassword,
  });
  if (ok && data.token) {
    setToken(data.token);
  }
  return { ok, ...data };
}

// Fail2ban
export async function getFail2banConfig() {
  const { data } = await request('GET', '/fail2ban-config');
  return data;
}

// Usage statistics
export async function getUsage(from?: string, to?: string) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  const { data } = await request('GET', `/usage${qs ? `?${qs}` : ''}`);
  return data as UsageData;
}

// Call logs (with AbortController support)
export async function getCallLogs(params: URLSearchParams, signal?: AbortSignal) {
  const qs = params.toString();
  const { ok, data } = await request('GET', `/logs${qs ? `?${qs}` : ''}`, undefined, { signal });
  if (!ok) throw new Error(data.error || 'Failed to fetch logs');
  return data as { logs: LogEntry[]; total: number; hasMore: boolean };
}

export interface UsageData {
  totals?: Record<string, { calls: number; promptTokens: number; completionTokens: number }>;
  total?: { calls: number; promptTokens: number; completionTokens: number };
  byProvider?: Record<string, { calls: number; promptTokens: number; completionTokens: number }>;
  daily?: Record<string, { calls: number; promptTokens: number; completionTokens: number }>;
}

// Types
export interface Provider {
  id: string;
  type: 'vertex_ai' | 'google_ai_studio' | 'openai' | 'anthropic';
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  models: string[];
  weight: number;
}

export interface ProviderInput {
  id?: string;
  type: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  models: string[];
  weight: number;
}

export interface ClientKeyInfo {
  configured: boolean;
  masked?: string;
  length?: number;
  prefix?: string;
  message?: string;
}

export interface LogEntry {
  id: number;
  timestamp: string;
  ip: string;
  providerId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  success: boolean;
  requestId: string;
  isStream: boolean;
  extra: Record<string, string>;
}

// Export state getters
export { isAuthenticated, clearToken };
