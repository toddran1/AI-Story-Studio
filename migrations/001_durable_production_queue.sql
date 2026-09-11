BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE production_jobs (
  id uuid PRIMARY KEY,
  story_slug text NOT NULL CHECK (story_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  chapter_from integer NOT NULL CHECK (chapter_from > 0),
  chapter_to integer NOT NULL CHECK (chapter_to >= chapter_from),
  profile text,
  options jsonb NOT NULL,
  plan_summary jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','paused','completed','completed_with_warnings','failed','cancelled','needs_review')),
  pause_requested boolean NOT NULL DEFAULT false,
  cancel_requested boolean NOT NULL DEFAULT false,
  current_chapter integer,
  current_stage text,
  total_items integer NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  completed_items integer NOT NULL DEFAULT 0 CHECK (completed_items >= 0),
  warning_items integer NOT NULL DEFAULT 0 CHECK (warning_items >= 0),
  review_items integer NOT NULL DEFAULT 0 CHECK (review_items >= 0),
  failed_items integer NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
  error_summary text,
  finalization_owner text,
  finalization_token text,
  finalization_expires_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX production_jobs_one_active_story
  ON production_jobs (story_slug)
  WHERE status IN ('queued','running','paused','needs_review');
CREATE INDEX production_jobs_status_updated ON production_jobs (status, updated_at DESC);
CREATE INDEX production_jobs_created ON production_jobs (created_at DESC, id DESC);
CREATE INDEX production_jobs_finalization ON production_jobs (finalized_at, finalization_expires_at) WHERE finalized_at IS NULL;

CREATE TABLE production_work_items (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES production_jobs(id) ON DELETE CASCADE,
  chapter integer NOT NULL CHECK (chapter > 0),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  status text NOT NULL CHECK (status IN ('pending','running','completed','warning','retry_wait','failed','needs_review','skipped')),
  current_stage text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  last_error text,
  error_category text CHECK (error_category IS NULL OR error_category IN ('transient','rate_limit','configuration','content_qa','permanent')),
  next_retry_at timestamptz,
  last_attempt_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  reused boolean NOT NULL DEFAULT false,
  qa_status text CHECK (qa_status IS NULL OR qa_status IN ('pass','warn','fail')),
  required_providers text[] NOT NULL DEFAULT '{}',
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, chapter),
  UNIQUE (job_id, ordinal)
);

CREATE INDEX production_work_claim ON production_work_items (status, next_retry_at, job_id, ordinal);
CREATE INDEX production_work_review ON production_work_items (status, updated_at DESC) WHERE status IN ('needs_review','failed');
CREATE INDEX production_work_lease ON production_work_items (lease_expires_at) WHERE status = 'running';

CREATE TABLE production_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES production_jobs(id) ON DELETE CASCADE,
  work_item_id bigint REFERENCES production_work_items(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  message text NOT NULL CHECK (length(message) <= 2000),
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_events_job ON production_events (job_id, id DESC);

CREATE TABLE provider_cooldowns (
  provider text PRIMARY KEY,
  cooldown_until timestamptz NOT NULL,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('001_durable_production_queue')
ON CONFLICT (version) DO NOTHING;
COMMIT;
