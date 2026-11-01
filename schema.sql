PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, email TEXT,
  webhook_url TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, title TEXT NOT NULL,
  r2_key TEXT NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE,
  watermark_id TEXT NOT NULL UNIQUE, c2pa_status TEXT NOT NULL DEFAULT 'pending',
  license_code TEXT NOT NULL DEFAULT 'ARR', license_url TEXT,
  max_downloads INTEGER, download_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
  FOREIGN KEY(creator_id) REFERENCES creators(id)
);
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, licensee_id TEXT,
  license_code TEXT NOT NULL, starts_at TEXT NOT NULL, expires_at TEXT,
  max_downloads INTEGER, status TEXT NOT NULL DEFAULT 'active', terms_json TEXT NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES assets(id)
);
CREATE TABLE IF NOT EXISTS sightings (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, method TEXT NOT NULL,
  confidence REAL, source TEXT, country_code TEXT, ip_hash TEXT,
  created_at TEXT NOT NULL, FOREIGN KEY(asset_id) REFERENCES assets(id)
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, asset_id TEXT, event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_watermark ON assets(watermark_id);
CREATE INDEX IF NOT EXISTS idx_sightings_asset ON sightings(asset_id, created_at);

-- Basic per-IP fixed-window rate limiting
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window);

-- Fallback master storage used only when the R2 binding is not configured (files <= 1 MB)
CREATE TABLE IF NOT EXISTS asset_blobs (
  key TEXT PRIMARY KEY, content_type TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL
);

-- Phase 2: visual recognition features
CREATE TABLE IF NOT EXISTS visual_features (
  asset_id TEXT PRIMARY KEY,
  feature_json TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES assets(id)
);
