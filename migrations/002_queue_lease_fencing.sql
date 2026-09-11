BEGIN;

ALTER TABLE production_work_items ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE production_jobs ADD COLUMN IF NOT EXISTS finalization_token text;

INSERT INTO schema_migrations(version) VALUES ('002_queue_lease_fencing')
ON CONFLICT (version) DO NOTHING;
COMMIT;
