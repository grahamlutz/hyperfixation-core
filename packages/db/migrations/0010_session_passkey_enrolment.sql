CREATE TABLE "hf_session_passkey_enrolment" (
	"session_id" text PRIMARY KEY NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hf_session_passkey_enrolment" ADD CONSTRAINT "hf_session_passkey_enrolment_session_id_hf_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."hf_session"("id") ON DELETE cascade ON UPDATE no action;