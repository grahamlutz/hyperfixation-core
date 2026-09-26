CREATE TABLE "hf_fetch_domain" (
	"domain" text PRIMARY KEY NOT NULL,
	"min_interval_ms" integer DEFAULT 1000 NOT NULL,
	"last_fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hf_raw_fetch" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hf_raw_fetch_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"method" text DEFAULT 'GET' NOT NULL,
	"status" integer NOT NULL,
	"headers" jsonb,
	"body" "bytea",
	"content_type" text,
	"etag" text,
	"error" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"run_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hf_raw_fetch_url_method_uq" ON "hf_raw_fetch" USING btree ("url_hash","method");