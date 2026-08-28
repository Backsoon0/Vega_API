-- 0009_api_key_quota.sql
-- Per-key quota: api_keys 增加配额字段；key_usage_daily 按 key_name+date 聚合每日用量。
-- 配额为 NULL 表示不限制。
ALTER TABLE api_keys ADD COLUMN quota_calls INTEGER
ALTER TABLE api_keys ADD COLUMN quota_tokens INTEGER
ALTER TABLE api_keys ADD COLUMN quota_period TEXT NOT NULL DEFAULT 'day'

CREATE TABLE IF NOT EXISTS key_usage_daily (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	key_name TEXT NOT NULL,
	date TEXT NOT NULL,
	calls INTEGER NOT NULL DEFAULT 0,
	prompt_tokens INTEGER NOT NULL DEFAULT 0,
	completion_tokens INTEGER NOT NULL DEFAULT 0,
	UNIQUE(key_name, date)
)