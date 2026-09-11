BEGIN;
CREATE TABLE IF NOT EXISTS provider_usage (
  id uuid PRIMARY KEY, idempotency_key text NOT NULL UNIQUE, story text NOT NULL, chapter integer,
  production_run_id text, queue_job_id uuid REFERENCES production_jobs(id) ON DELETE SET NULL,
  stage text NOT NULL, provider text NOT NULL, model text NOT NULL, operation text NOT NULL,
  attempted_at timestamptz NOT NULL, completed_at timestamptz NOT NULL, attempt integer NOT NULL,
  input_tokens bigint, cached_input_tokens bigint, output_tokens bigint, input_characters bigint, input_utf8_bytes bigint,
  output_bytes bigint, audio_duration_seconds double precision, image_count integer, image_quality text, image_size text,
  request_id text, success boolean NOT NULL, error_category text, retry boolean NOT NULL,
  cost_usd numeric(20,9), cost_status text NOT NULL, pricing_snapshot jsonb, record jsonb NOT NULL,
  CHECK (chapter IS NULL OR chapter > 0), CHECK (attempt > 0), CHECK (cost_status IN ('calculated','unavailable'))
);
CREATE INDEX IF NOT EXISTS provider_usage_story_time_idx ON provider_usage(story, attempted_at DESC);
CREATE INDEX IF NOT EXISTS provider_usage_story_chapter_idx ON provider_usage(story, chapter);
CREATE INDEX IF NOT EXISTS provider_usage_run_idx ON provider_usage(production_run_id) WHERE production_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS provider_usage_job_idx ON provider_usage(queue_job_id) WHERE queue_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS provider_usage_dimensions_idx ON provider_usage(stage, provider, model, attempted_at DESC);
INSERT INTO schema_migrations(version) VALUES ('003_provider_usage') ON CONFLICT (version) DO NOTHING;
COMMIT;
