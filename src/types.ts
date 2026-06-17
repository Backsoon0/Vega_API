// src/types.ts
// Shared TypeScript interfaces for Vega API

export interface Provider {
  id: string;
  type: 'vertex_ai' | 'google_ai_studio' | 'openai' | 'anthropic';
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
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	apiKeyName: string;
}

export interface ApiKeyRecord {
	id: number;
	name: string;
	key_hash: string;
	encrypted_key: string;
	created_at: string;
	last_used_at: string | null;
}

export interface ApiKeyInfo {
	id: number;
	name: string;
	createdAt: string;
	lastUsedAt: string | null;
}

export interface Env {
	DB: D1Database;
	ASSETS: { fetch: (request: Request) => Promise<Response> };
	ENCRYPTION_KEY?: string;
	OPENAI_API_KEY?: string;
	clientKeyName?: string;
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
