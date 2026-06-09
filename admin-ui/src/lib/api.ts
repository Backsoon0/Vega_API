// API client for Vega API admin endpoints
// All requests go to /admin/* on the same origin

let authToken = "";
let initialized = false;

// Restore token from localStorage on load
if (typeof window !== "undefined") {
  const saved = localStorage.getItem("admin_token");
  if (saved) authToken = saved;
  initialized = true;
}

function setToken(token: string) {
  authToken = token;
  localStorage.setItem("admin_token", token);
}

function clearToken() {
  authToken = "";
  localStorage.removeItem("admin_token");
}

function isAuthenticated() {
  return !!authToken;
}

async function request(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const opts: RequestInit = { method, headers };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  const resp = await fetch(`/admin${path}`, opts);
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
  const { ok, data } = await request("POST", "/auth", { password });
  if (ok && data.token) {
    setToken(data.token);
  }
  return { ok, ...data };
}

export async function checkAuth(): Promise<boolean> {
  if (!authToken) return false;
  const { ok } = await request("GET", "/check");
  if (!ok) clearToken();
  return ok;
}

// Providers
export async function getProviders() {
  const { ok, data } = await request("GET", "/providers");
  if (!ok) throw new Error(data.error || "Failed to fetch providers");
  return data as Provider[];
}

export async function createProvider(provider: ProviderInput) {
  const { ok, data } = await request("POST", "/providers", provider);
  if (!ok) throw new Error(data.error || "Failed to create provider");
  return data;
}

export async function updateProvider(id: string, provider: ProviderInput) {
  const { ok, data } = await request(
    "PUT",
    `/providers/${encodeURIComponent(id)}`,
    provider
  );
  if (!ok) throw new Error(data.error || "Failed to update provider");
  return data;
}

export async function deleteProvider(id: string) {
  const { ok, data } = await request(
    "DELETE",
    `/providers/${encodeURIComponent(id)}`
  );
  if (!ok) throw new Error(data.error || "Failed to delete provider");
}

// Client API Key
export async function getClientKey() {
  const { ok, data } = await request("GET", "/client-key");
  return data as ClientKeyInfo;
}

export async function setClientKey(key?: string, generate?: boolean) {
  const { ok, data } = await request("POST", "/client-key", {
    key,
    generate,
  });
  if (!ok) throw new Error(data.error || "Failed to set API key");
  return data as { ok: boolean; message: string; masked: string; fullKey: string; configured: boolean };
}

export async function deleteClientKey() {
  const { ok, data } = await request("DELETE", "/client-key");
  if (!ok) throw new Error(data.error || "Failed to delete API key");
  return data;
}

export async function revealClientKey() {
  const resp = await fetch("/admin/client-key?reveal=true", {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  const data = await resp.json();
  return data as ClientKeyInfo & { fullKey?: string };
}

// Password
export async function changePassword(currentPassword: string, newPassword: string) {
  const { ok, data } = await request("POST", "/change-password", {
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
  const { data } = await request("GET", "/fail2ban-config");
  return data;
}

// Types
export interface Provider {
  id: string;
  type: "vertex_ai" | "google_ai_studio" | "openai";
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

// Export state getters
export { isAuthenticated, clearToken, authToken };
