// src/runtime.ts
// Cross-platform runtime detection (deployment platform + database engine).
// Used by the admin "settings" panel to display where the app runs and which
// database backs it. This module MUST NOT import any database-specific client
// (it only inspects `env` / `process.env`), so it is safe for both Cloudflare
// and Vercel entry points.

import type { Env } from './types';

export type PlatformKind = 'cloudflare' | 'vercel';
export type DatabaseKind = 'd1' | 'neon';

export interface RuntimeStatus {
	/** Deployment platform: "cloudflare" (Workers) or "vercel" (Serverless). */
	platform: PlatformKind;
	/** Database engine: "d1" (Cloudflare D1) or "neon" (Vercel Neon Postgres). */
	database: DatabaseKind;
	/** Human-readable deployment model label. */
	deploymentModel: string;
	/** Database host or engine label (no credentials leaked). */
	databaseHost: string;
	/** Node.js version when running on Vercel, otherwise undefined. */
	nodeVersion?: string;
}

/** True when running inside a Vercel serverless function. */
function isVercel(): boolean {
	// `process` exists under `nodejs_compat` in workerd too, but `VERCEL` is only
	// set by Vercel. Guard the reference so non-node runtimes don't throw.
	try {
		return typeof process !== 'undefined' && !!((process.env as Record<string, string | undefined>)?.VERCEL);
	} catch {
		return false;
	}
}

/** Resolve the deployment platform (explicit env var wins, then auto-detect). */
export function detectPlatform(env: Env): PlatformKind {
	if (env.DEPLOYMENT_PLATFORM === 'vercel' || env.DEPLOYMENT_PLATFORM === 'cloudflare') {
		return env.DEPLOYMENT_PLATFORM;
	}
	return isVercel() ? 'vercel' : 'cloudflare';
}

/** Resolve the database engine (explicit selector wins, then auto-detect).
 * Accepts Waline-style values: "neon"/"postgres"/"pg" → Neon, "d1"/"sqlite" → D1. */
export function detectDatabase(env: Env): DatabaseKind {
	const sel = (env.DATABASE || env.DATABASE_PROVIDER || '').toLowerCase();
	if (sel === 'neon' || sel === 'postgres' || sel === 'pg') return 'neon';
	if (sel === 'd1' || sel === 'sqlite') return 'd1';
	// A Postgres/Neon connection string (any alias) implies Neon; otherwise use D1.
	if (env.PGURL || env.POSTGRES_URL || env.DATABASE_URL) return 'neon';
	return 'd1';
}

/** The resolved Postgres/Neon connection string (Waline `PGURL` or its aliases). */
function databaseUrl(env: Env): string {
	return env.PGURL || env.DATABASE_URL || env.POSTGRES_URL || '';
}

/** Extract a safe, credential-free hostname from a Postgres connection string. */
function databaseHost(env: Env): string {
	if (detectDatabase(env) === 'neon' && databaseUrl(env)) {
		try {
			const u = new URL(databaseUrl(env).replace(/^postgres(ql)?:\/\//i, 'http://'));
			return u.hostname || 'Neon';
		} catch {
			return 'Neon';
		}
	}
	return 'Cloudflare D1';
}

/** Full runtime report for the admin panel. */
export function getRuntimeStatus(env: Env): RuntimeStatus {
	const platform = detectPlatform(env);
	const database = detectDatabase(env);
	return {
		platform,
		database,
		deploymentModel: platform === 'vercel' ? 'Vercel Serverless (Node)' : 'Cloudflare Workers',
		databaseHost: databaseHost(env),
		nodeVersion: platform === 'vercel' ? tryNodeVersion() : undefined,
	};
}

function tryNodeVersion(): string | undefined {
	try {
		return typeof process !== 'undefined' ? (process.version as string) : undefined;
	} catch {
		return undefined;
	}
}
