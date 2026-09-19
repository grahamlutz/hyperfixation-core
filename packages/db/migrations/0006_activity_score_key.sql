ALTER TABLE "hf_activity" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "hf_score" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "hf_score" ADD COLUMN "key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "hf_activity_run_key_uq" ON "hf_activity" USING btree ("run_id","key") WHERE "hf_activity"."key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hf_score_run_key_uq" ON "hf_score" USING btree ("run_id","key") WHERE "hf_score"."key" IS NOT NULL;