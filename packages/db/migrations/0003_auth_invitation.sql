CREATE TABLE "hf_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inviter_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hf_invitation" ADD CONSTRAINT "hf_invitation_organization_id_hf_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."hf_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hf_invitation" ADD CONSTRAINT "hf_invitation_inviter_id_hf_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."hf_user"("id") ON DELETE cascade ON UPDATE no action;