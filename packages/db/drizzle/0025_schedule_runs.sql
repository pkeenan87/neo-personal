CREATE TABLE "schedule_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"runner" text NOT NULL,
	"mode" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "schedule_runs_runner_check" CHECK ("schedule_runs"."runner" in ('inngest', 'eve')),
	CONSTRAINT "schedule_runs_mode_check" CHECK ("schedule_runs"."mode" in ('shadow', 'live')),
	CONSTRAINT "schedule_runs_outcome_check" CHECK ("schedule_runs"."outcome" in ('ok', 'error')),
	CONSTRAINT "schedule_runs_error_length_check" CHECK ("schedule_runs"."error" is null or char_length("schedule_runs"."error") <= 300)
);
--> statement-breakpoint
CREATE INDEX "schedule_runs_job_started_idx" ON "schedule_runs" USING btree ("job","started_at" DESC NULLS LAST);
--> statement-breakpoint
-- Job-level, not household data: no tenant_id and no RLS (like reputation_cache). Default privileges
-- already cover app_user on a database created from sql/create-app-user.sql; this covers one that
-- predates it. No UPDATE: a run is inserted once, when it finishes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, DELETE ON "public"."schedule_runs" TO app_user;
  END IF;
END
$$;
