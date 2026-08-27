// api/neon.ts
// Vercel-only Neon (PostgreSQL) adapter exposing a D1-shaped client so the SAME
// data-access code that runs on Cloudflare D1 works on Vercel Neon.
//
// It implements the minimal `DBClient` interface used throughout `src/`:
//   db.prepare(sql).bind(...).all()/.first()/.run()
//
// SQL translation (SQLite/D1 dialect → PostgreSQL/Neon):
//   * `?` placeholders           → `$1, $2, ...` (positional)
//   * `INSERT OR REPLACE INTO`   → `INSERT ... ON CONFLICT (...) DO UPDATE ...`
//   * `julianday(x)`             → `(EXTRACT(EPOCH FROM (x)::timestamptz) / 86400.0)`

import { neon } from '@neondatabase/serverless';
import type { DBClient, DBPrepared, DBResult } from '../src/types';

// ---- SQL translation (D1/SQLite → Postgres) ----

/** Replace `?` positional placeholders with `$1, $2 ...`, ignoring `?` inside string literals. */
function toPgPlaceholders(sql: string): string {
	let out = '';
	let inStr = false;
	let paramIdx = 1;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		if (ch === "'") {
			out += ch;
			if (inStr && sql[i + 1] === "'") {
				// Escaped `''` inside a string literal — stays in the string.
				out += sql[i + 1];
				i++;
				continue;
			}
			inStr = !inStr;
			continue;
		}
		if (!inStr && ch === '?') {
			out += `$${paramIdx++}`;
			continue;
		}
		out += ch;
	}
	return out;
}

/** Rewrite `INSERT OR REPLACE INTO t (cols) VALUES (vals)` → Postgres upsert. */
function rewriteInsertOrReplace(sql: string): string {
	const m = sql.match(/^INSERT OR REPLACE INTO ([a-zA-Z_][a-zA-Z0-9_]*) \((.*?)\)\s+VALUES \((.*)\)$/is);
	if (!m) return sql;
	const table = m[1];
	const cols = m[2].split(',').map((s) => s.trim()).filter(Boolean);
	const values = m[3];
	if (cols.length < 2) return sql;

	const conflict = cols[0];
	const updates = cols.slice(1).map((c) => `${c} = excluded.${c}`).join(', ');
	if (!updates) return sql;

	return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${values}) ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`;
}

/** Rewrite SQLite `julianday(x)` → Postgres days-since-epoch (keeps existing `* 86400000.0` math valid). */
function rewriteJulianDay(sql: string): string {
	return sql.replace(/julianday\(([^()]*)\)/g, (_m, arg: string) =>
		`(EXTRACT(EPOCH FROM (${arg})::timestamptz) / 86400.0)`,
	);
}

function translateToPg(sql: string): string {
	let s = toPgPlaceholders(sql);
	s = rewriteInsertOrReplace(s);
	s = rewriteJulianDay(s);
	return s;
}

// ---- Result normalization (robust across Neon driver versions) ----

function normalizeRows(res: unknown): any[] {
	if (Array.isArray(res)) return res;
	if (res && typeof res === 'object') {
		const r = res as Record<string, unknown>;
		if (Array.isArray(r.rows)) return r.rows as any[];
		if (Array.isArray(r.data)) return r.data as any[];
	}
	return [];
}

function rowCountOf(res: unknown, rows: any[]): number {
	if (res && typeof res === 'object') {
		const r = res as Record<string, unknown>;
		if (typeof r.rowCount === 'number') return r.rowCount as number;
		if (typeof r.affectedRows === 'number') return r.affectedRows as number;
	}
	return rows.length;
}

// ---- Client ----

class NeonPrepared implements DBPrepared {
	private sql: string;
	private params: unknown[] = [];

	constructor(private readonly client: NeonQueryClient, sql: string) {
		this.sql = sql;
	}

	bind(...values: unknown[]): DBPrepared {
		this.params = values;
		return this;
	}

	private async execute(): Promise<{ rows: any[]; changes: number }> {
		const res = await this.client.query(this.sql, this.params);
		const rows = normalizeRows(res);
		return { rows, changes: rowCountOf(res, rows) };
	}

	async all<T = Record<string, unknown>>(): Promise<DBResult<T>> {
		const { rows } = await this.execute();
		return { results: rows as T[], success: true, meta: { changes: 0, last_row_id: 0 } };
	}

	async first<T = Record<string, unknown>>(): Promise<T | null> {
		const { rows } = await this.execute();
		return (rows[0] as T) ?? null;
	}

	async run(): Promise<DBResult<Record<string, unknown>>> {
		const { changes } = await this.execute();
		return { results: [], success: true, meta: { changes, last_row_id: 0 } };
	}
}

type NeonQueryClient = ReturnType<typeof neon>;

/** D1-compatible client backed by the Neon serverless HTTP driver. */
export class NeonDBClient implements DBClient {
	private readonly client: NeonQueryClient;

	constructor(databaseUrl: string) {
		// `fullResults: true` returns `{ rows, rowCount, ... }` so we can report
		// affected-row counts for DELETE/UPDATE (needed by admin key deletion/rename).
		this.client = neon(databaseUrl, { fullResults: true });
	}

	prepare(sql: string): DBPrepared {
		return new NeonPrepared(this.client, translateToPg(sql));
	}
}
