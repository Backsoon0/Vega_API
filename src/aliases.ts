// src/aliases.ts
// Model alias / redirect rules (feature 1).
//
// An alias maps a client-visible model name to a target model (which is then
// routed to a provider by findProviderForModel). Rules live in the `model_aliases`
// table. `resolveAlias` is the single entry point the router calls at the TOP of
// findProviderForModel so all three API dialects (/v1, /v1beta, /anthropic) resolve
// aliases uniformly.
//
// Conflict rules enforced at write time:
//   - alias is globally UNIQUE (DB constraint) → duplicate returns an error
//   - target === alias (self-reference)      → rejected
//   - cascading cycle (A→B, B→A)             → rejected via DFS at save time
//   - alias colliding with a real model name → allowed, alias takes precedence at runtime

import type { Env, ModelAlias } from './types.js';

const MAX_CHAIN_DEPTH = 10;

/** ISO timestamp — used instead of `datetime('now')` for cross-platform (D1 + Neon) safety. */
function nowIso(): string {
	return new Date().toISOString();
}

interface AliasRow {
	id: number;
	alias: string;
	target: string;
	provider_id: string | null;
	enabled: number;
	description: string;
	created_at: string;
	updated_at: string;
}

function rowToAlias(row: AliasRow): ModelAlias {
	return {
		id: row.id,
		alias: row.alias,
		target: row.target,
		providerId: row.provider_id,
		enabled: row.enabled === 1,
		description: row.description,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function listAliases(env: Env): Promise<ModelAlias[]> {
	const res = await env.DB
		.prepare('SELECT * FROM model_aliases ORDER BY alias ASC')
		.all<AliasRow>();
	return (res.results || []).map(rowToAlias);
}

export async function getAlias(env: Env, alias: string): Promise<ModelAlias | null> {
	const row = await env.DB
		.prepare('SELECT * FROM model_aliases WHERE alias = ?')
		.bind(alias)
		.first<AliasRow>();
	return row ? rowToAlias(row) : null;
}

export async function getAliasById(env: Env, id: number): Promise<ModelAlias | null> {
	const row = await env.DB
		.prepare('SELECT * FROM model_aliases WHERE id = ?')
		.bind(id)
		.first<AliasRow>();
	return row ? rowToAlias(row) : null;
}

export interface AliasInput {
	alias: string;
	target: string;
	providerId?: string | null;
	enabled?: boolean;
	description?: string;
}

/** Validate + resolve whether writing a rule creates a cycle. Throws on invalid. */
async function assertNoCycle(env: Env, alias: string, target: string, ignoreId?: number): Promise<void> {
	const seen = new Set<string>([alias]);
	let current = target;
	for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
		if (current === alias) {
			throw new Error(`别名规则会形成循环引用: ${alias} → ${target}`);
		}
		if (seen.has(current)) {
			throw new Error(`别名规则会形成循环引用: ${current}`);
		}
		seen.add(current);
		const next = await getAlias(env, current);
		if (!next || next.id === ignoreId) break;
		current = next.target;
	}
}

/**
 * Create or update an alias. Returns the saved record. Throws an Error with a
 * user-facing message on any conflict (invalid target/self-reference/cycle/duplicate).
 */
export async function upsertAlias(env: Env, input: AliasInput, id?: number): Promise<ModelAlias> {
	const alias = (input.alias || '').trim();
	const target = (input.target || '').trim();

	if (!alias) throw new Error('别名不能为空');
	if (!target) throw new Error('目标模型不能为空');
	if (alias === target) throw new Error('别名与目标模型不能相同');

	// Self-reference check is already covered above (alias === target).
	// If updating, ensure the rule exists.
	let existingId = id;
	if (existingId !== undefined) {
		const existing = await getAliasById(env, existingId);
		if (!existing) throw new Error('别名规则不存在');
	}

	// Duplicate check (excluding self on update).
	const byName = await getAlias(env, alias);
	if (byName && byName.id !== existingId) {
		throw new Error(`别名已存在: ${alias}`);
	}

	// Cycle detection: walk forward from target, stop if we ever return to alias.
	await assertNoCycle(env, alias, target, existingId);

	const providerId = input.providerId || null;
	const enabled = input.enabled === undefined ? true : input.enabled !== false;
	const description = (input.description || '').slice(0, 500);

	if (existingId !== undefined) {
		await env.DB
			.prepare(
				'UPDATE model_aliases SET alias = ?, target = ?, provider_id = ?, enabled = ?, description = ?, updated_at = ? WHERE id = ?',
			)
			.bind(alias, target, providerId, enabled ? 1 : 0, description, nowIso(), existingId)
			.run();
		return (await getAliasById(env, existingId))!;
	}

	const res = await env.DB
		.prepare(
			'INSERT INTO model_aliases (alias, target, provider_id, enabled, description) VALUES (?, ?, ?, ?, ?)',
		)
		.bind(alias, target, providerId, enabled ? 1 : 0, description)
		.run();
	// D1 reports meta.last_row_id; the Neon adapter always returns 0 — fall back
	// to a lookup by the UNIQUE alias name so both platforms read the row back.
	const newId = Number(res.meta.last_row_id);
	const created = Number.isFinite(newId) && newId > 0
		? await getAliasById(env, newId)
		: await getAlias(env, alias);
	if (!created) throw new Error('保存失败：无法读取新建的别名规则');
	return created;
}

export async function deleteAlias(env: Env, id: number): Promise<boolean> {
	const res = await env.DB
		.prepare('DELETE FROM model_aliases WHERE id = ?')
		.bind(id)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

export async function setAliasEnabled(env: Env, id: number, enabled: boolean): Promise<boolean> {
	const res = await env.DB
		.prepare('UPDATE model_aliases SET enabled = ?, updated_at = ? WHERE id = ?')
		.bind(enabled ? 1 : 0, nowIso(), id)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

/**
 * Resolve a requested model name through the alias chain. Pure-ish (reads the DB
 * once per hop) — returns the final target model name, or the original name when
 * no (enabled) alias applies. Throws only on a runaway cycle (should never happen
 * given save-time cycle checks, but guards against hand-edited DB rows).
 */
export async function resolveAlias(env: Env, modelId: string): Promise<string> {
	let current = modelId;
	for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
		const rule = await getAlias(env, current);
		if (!rule || !rule.enabled) return current;
		if (rule.target === current) return current; // safety: self-reference guard
		current = rule.target;
	}
	throw new Error(`别名解析超出最大深度(${MAX_CHAIN_DEPTH})，可能存在循环: ${modelId}`);
}
