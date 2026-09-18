CREATE TABLE "hf_approval" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_approval_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" text NOT NULL,
	"key" text NOT NULL,
	"workflow_id" text NOT NULL,
	"type" text NOT NULL,
	"record_type" text,
	"record_id" text,
	"draft" jsonb,
	"edited_draft" jsonb,
	"status" text NOT NULL,
	"assignee_id" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decided_via" text,
	"decision_key" text,
	"resume_workflow_id" text,
	"notified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"batch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hf_approval_run_key_uq" ON "hf_approval" USING btree ("run_id","key");--> statement-breakpoint
CREATE INDEX "hf_approval_status_idx" ON "hf_approval" USING btree ("status","expires_at");