DROP INDEX "hf_score_run_key_uq";--> statement-breakpoint
ALTER TABLE "hf_score" ADD COLUMN "spec_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "hf_score_run_key_spec_uq" ON "hf_score" USING btree ("run_id","key","spec_name") WHERE "hf_score"."key" IS NOT NULL;