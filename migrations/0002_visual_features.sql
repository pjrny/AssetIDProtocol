-- Phase 2: visual recognition features
CREATE TABLE IF NOT EXISTS visual_features (
  asset_id TEXT PRIMARY KEY,
  feature_json TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES assets(id)
);
