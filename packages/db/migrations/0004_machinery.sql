CREATE TABLE "hf_activity" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text,
	"body" text,
	"meta" jsonb,
	"run_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hf_label" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_label_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"target" text NOT NULL,
	"target_id" text,
	"value" text NOT NULL,
	"correction" jsonb,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hf_outcome" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_outcome_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"outcome" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "hf_record_link" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_record_link_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_record_id" bigint NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"confidence" double precision,
	"method" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hf_score" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_score_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"spec_version" integer NOT NULL,
	"score" double precision NOT NULL,
	"explanation" text,
	"llm_call_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hf_source_record" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_source_record_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"run_id" bigint,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hf_source_run" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_source_run_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"rows_in" integer DEFAULT 0 NOT NULL,
	"rows_new" integer DEFAULT 0 NOT NULL,
	"rows_changed" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "hf_task" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_task_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"owner_id" text,
	"done_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"origin" text NOT NULL,
	"origin_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hf_activity_record_idx" ON "hf_activity" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE INDEX "hf_label_record_idx" ON "hf_label" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE INDEX "hf_outcome_record_idx" ON "hf_outcome" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hf_record_link_source_record_uq" ON "hf_record_link" USING btree ("source_record_id");--> statement-breakpoint
CREATE INDEX "hf_record_link_record_idx" ON "hf_record_link" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE INDEX "hf_score_record_idx" ON "hf_score" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hf_source_record_source_external_uq" ON "hf_source_record" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "hf_source_record_status_idx" ON "hf_source_record" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hf_task_record_idx" ON "hf_task" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hf_task_origin_ref_uq" ON "hf_task" USING btree ("origin","origin_ref") WHERE "hf_task"."origin_ref" IS NOT NULL;