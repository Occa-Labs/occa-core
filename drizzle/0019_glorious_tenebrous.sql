CREATE TABLE "deployment_channels" (
	"deployment_id" uuid NOT NULL,
	"channel_type" text NOT NULL,
	"credentials" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"chat_enabled" boolean DEFAULT true NOT NULL,
	"notif_enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'off' NOT NULL,
	"status_msg" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment_channels" ADD CONSTRAINT "deployment_channels_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_deployment_channels" ON "deployment_channels" USING btree ("deployment_id","channel_type");--> statement-breakpoint
CREATE INDEX "idx_deployment_channels_deployment" ON "deployment_channels" USING btree ("deployment_id");