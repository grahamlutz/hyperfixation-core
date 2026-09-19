ALTER TABLE "hf_activity" ALTER COLUMN "record_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hf_activity" ALTER COLUMN "record_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hf_task" ALTER COLUMN "record_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hf_task" ALTER COLUMN "record_id" DROP NOT NULL;