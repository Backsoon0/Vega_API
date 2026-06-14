// src/types.ts
// Shared TypeScript interfaces for Vega API

export interface Provider {
  id: string;
  type: 'vertex_ai' | 'google_ai_studio' | 'openai';
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  models: string[];
  weight: number;
}

export interface ProviderRow {
  id: string;
  type: string;
  name: string;
  enabled: number;
  config: string;  // JSON string
  models: string;  // JSON string
  weight: number;
}

export interface Model {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  _providerId?: string;
}

export interface UsageRecord {
  calls: number;
  promptTokens: number;
  completionTokens: number;
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

export interface Env {
  DB: D1Database;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  ENCRYPTION_KEY?: string;
  OPENAI_API_KEY?: string;
}

export interface ProviderHandler {
  proxyRequest(
    request: Request,
    env: Env,
    provider: Provider,
    suffix: string
  ): Promise<Response>;
  fetchModelList(
    env: Env,
    config: Record<string, string>
  ): Promise<Model[]>;
}
