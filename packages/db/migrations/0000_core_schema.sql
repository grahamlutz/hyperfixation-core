CREATE TABLE "hf_app_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_by" text,
	"budget_usd" numeric(12, 4) NOT NULL,
	"read_token_hash" text,
	"write_token_hash" text,
	CONSTRAINT "hf_app_state_singleton" CHECK ("hf_app_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "hf_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"meta" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hf_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hf_member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hf_organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" text,
	CONSTRAINT "hf_organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "hf_passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "hf_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	"impersonated_by" text,
	"factor" text DEFAULT 'code' NOT NULL,
	CONSTRAINT "hf_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "hf_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	CONSTRAINT "hf_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "hf_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hf_action_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_action_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" text NOT NULL,
	"key" text NOT NULL,
	"workflow_id" text NOT NULL,
	"channel" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"external_id" text,
	"approval_id" bigint,
	"record_type" text,
	"record_id" text,
	"request" jsonb,
	"response" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hf_budget_period" (
	"period" text PRIMARY KEY NOT NULL,
	"budget_usd" numeric(12, 4) NOT NULL,
	"spent_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hf_budget_period_spent_non_negative" CHECK ("hf_budget_period"."spent_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hf_llm_call" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_llm_call_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" text NOT NULL,
	"key" text NOT NULL,
	"workflow_id" text NOT NULL,
	"period" text NOT NULL,
	"step_name" text,
	"prompt_name" text,
	"prompt_hash" text,
	"input_hash" text NOT NULL,
	"model" text,
	"status" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"tokens_in" integer,
	"tokens_out" integer,
	"estimated_cost_usd" numeric(12, 6) NOT NULL,
	"cost_usd" numeric(12, 6),
	"possible_double_charge" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"trace_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hf_run" (
	"run_id" text PRIMARY KEY NOT NULL,
	"flow" text NOT NULL,
	"input" jsonb,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"current_workflow_id" text NOT NULL,
	"version" text,
	"record_type" text,
	"record_id" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "hf_run_current_workflow_id_unique" UNIQUE("current_workflow_id"),
	CONSTRAINT "hf_run_attempt_positive" CHECK ("hf_run"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "hf_account" ADD CONSTRAINT "hf_account_user_id_hf_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."hf_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hf_member" ADD CONSTRAINT "hf_member_organization_id_hf_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."hf_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hf_member" ADD CONSTRAINT "hf_member_user_id_hf_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."hf_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hf_passkey" ADD CONSTRAINT "hf_passkey_user_id_hf_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."hf_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hf_session" ADD CONSTRAINT "hf_session_user_id_hf_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."hf_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hf_action_log_run_key_uq" ON "hf_action_log" USING btree ("run_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "hf_llm_call_run_key_uq" ON "hf_llm_call" USING btree ("run_id","key");--> statement-breakpoint
CREATE INDEX "hf_llm_call_period_status_idx" ON "hf_llm_call" USING btree ("period","status");--> statement-breakpoint
CREATE INDEX "hf_run_status_idx" ON "hf_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hf_run_record_idx" ON "hf_run" USING btree ("record_type","record_id");