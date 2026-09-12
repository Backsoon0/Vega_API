-- 0010_usage_hourly.sql
-- 用量小时聚合表：每小时一行（bucket = UTC 小时键 'YYYY-MM-DDTHH'）。
-- 用途：admin 用量报表需要按「查看者本地时区」的日/时切分，而 usage_daily 只按 UTC 日期落库、
-- 无法再拆分；有了小时级总量即可在读取时按任意时区偏移重新聚合成本地日。
-- 只存总量（不按 model/key 维度），每调用一次 upsert 一行，写放大最小。
-- 自动清理：只保留最近 35 天（见 src/usage.ts `USAGE_HOURLY_RETENTION_HOURS` + `pruneUsageHourly`，
-- 随 recordUsage 的概率性清理一起执行），最多约 840 行。
-- 注意：本迁移是手动兜底路径；运行时 initSchema 会自动建表，语句本身幂等。
CREATE TABLE IF NOT EXISTS usage_hourly (bucket TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0);
