-- Migration: 0004_rate_limits_banned_until
-- Add banned_until column to rate_limits table (missing from 0001_init.sql schema)
ALTER TABLE rate_limits ADD COLUMN banned_until INTEGER NOT NULL DEFAULT 0;
