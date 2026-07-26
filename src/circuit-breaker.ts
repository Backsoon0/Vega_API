// src/circuit-breaker.ts
// In-memory circuit breaker for provider failover.
// Tracks consecutive failures per provider; opens circuit after threshold.
// Cooldown period before allowing a probe (half-open → closed on success, re-open on failure).
//
// DESIGN: All state (failures, open/closed) lives in memory — zero per-request D1 overhead.
// Config (threshold, cooldown) is loaded from D1 ONCE on first use, then cached in memory.
// Admin panel writes to D1 AND calls updateConfig() to sync the in-memory copy immediately.

import type { Env } from './types';
import { getConfig as getD1Config } from './config';

interface CircuitState {
	failures: number;
	openedAt: number;
	state: 'closed' | 'open' | 'half-open';
}

const circuits = new Map<string, CircuitState>();

const DEFAULT_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;

let threshold = DEFAULT_THRESHOLD;
let cooldownMs = DEFAULT_COOLDOWN_MS;
let configLoaded = false;
let configLoadPromise: Promise<void> | null = null;

// ---- Lazy config init (D1 → memory, once per isolate) ----

async function loadConfigFromD1(env: Env): Promise<void> {
	const thresholdRaw = await getD1Config(env, 'circuit_breaker_threshold');
	const cooldownRaw = await getD1Config(env, 'circuit_breaker_cooldown_seconds');
	if (thresholdRaw) threshold = Math.max(1, parseInt(thresholdRaw, 10) || DEFAULT_THRESHOLD);
	if (cooldownRaw) cooldownMs = Math.max(5_000, (parseInt(cooldownRaw, 10) || 30) * 1000);
	configLoaded = true;
}

/** Ensure config is loaded from D1. Called lazily on first use. Safe to call multiple times. */
export async function ensureConfigLoaded(env: Env): Promise<void> {
	if (configLoaded) return;
	if (!configLoadPromise) {
		configLoadPromise = loadConfigFromD1(env).finally(() => {
			configLoadPromise = null;
		});
	}
	return configLoadPromise;
}

// ---- Config (in-memory, updated by admin panel) ----

export interface CircuitBreakerConfig {
	threshold: number;
	cooldownMs: number;
}

/** Update in-memory config immediately. Admin panel calls this after persisting to D1. */
export function updateConfig(cfg: Partial<CircuitBreakerConfig>) {
	if (cfg.threshold !== undefined) threshold = Math.max(1, cfg.threshold);
	if (cfg.cooldownMs !== undefined) cooldownMs = Math.max(5_000, cfg.cooldownMs);
	configLoaded = true; // mark as loaded so ensureConfigLoaded is a no-op
}

export function getCircuitConfig(): CircuitBreakerConfig {
	return { threshold, cooldownMs };
}

// ---- Operations (pure in-memory, zero D1 overhead) ----

/** Check if a provider is allowed to receive requests. */
export function isProviderAllowed(providerId: string): boolean {
	const circuit = circuits.get(providerId);
	if (!circuit) return true;

	const now = Date.now();

	if (circuit.state === 'open') {
		if (now - circuit.openedAt >= cooldownMs) {
			circuit.state = 'half-open';
			return true;
		}
		return false;
	}

	return true;
}

/** Record a successful request. Resets the circuit to closed. */
export function recordSuccess(providerId: string) {
	circuits.delete(providerId);
}

/** Record a failed request. Opens circuit if threshold reached. */
export function recordFailure(providerId: string) {
	let circuit = circuits.get(providerId);
	if (!circuit) {
		circuit = { failures: 0, openedAt: 0, state: 'closed' };
		circuits.set(providerId, circuit);
	}

	circuit.failures++;

	if (circuit.failures >= threshold) {
		circuit.state = 'open';
		circuit.openedAt = Date.now();
		console.warn(`Circuit breaker OPEN for provider ${providerId} after ${circuit.failures} failures (threshold: ${threshold})`);
	}
}

/** Get all circuit states (for admin/debug). */
export function getCircuitStates(): Map<string, CircuitState> {
	return new Map(circuits);
}
