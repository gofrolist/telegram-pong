CREATE TABLE "chat_leaderboard" (
	"chat_instance" text NOT NULL,
	"game" text DEFAULT 'pong' NOT NULL,
	"user_id" bigint NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"matches" integer DEFAULT 0 NOT NULL,
	"last_match_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_leaderboard_chat_instance_game_user_id_pk" PRIMARY KEY("chat_instance","game","user_id")
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"chat_instance" text PRIMARY KEY NOT NULL,
	"chat_type" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_match_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cheat_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"game" text DEFAULT 'pong' NOT NULL,
	"reaction_median_ms" real,
	"reaction_stddev_ms" real,
	"tracking_rmse" real,
	"overshoot_rate" real,
	"idle_fraction" real,
	"matches_analysed" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"user_id" bigint,
	"chat_instance" text,
	"game" text,
	"room_id" text,
	"match_id" uuid,
	"props" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "head_to_head" (
	"game" text DEFAULT 'pong' NOT NULL,
	"low_user_id" bigint NOT NULL,
	"high_user_id" bigint NOT NULL,
	"low_wins" integer DEFAULT 0 NOT NULL,
	"high_wins" integer DEFAULT 0 NOT NULL,
	"last_match_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "head_to_head_game_low_user_id_high_user_id_pk" PRIMARY KEY("game","low_user_id","high_user_id")
);
--> statement-breakpoint
CREATE TABLE "match_traces" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"tick_rate" smallint NOT NULL,
	"trace" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game" text DEFAULT 'pong' NOT NULL,
	"origin" text DEFAULT 'invite' NOT NULL,
	"room_id" text NOT NULL,
	"chat_instance" text,
	"seed" integer NOT NULL,
	"player_a_id" bigint NOT NULL,
	"player_b_id" bigint NOT NULL,
	"score_a" smallint NOT NULL,
	"score_b" smallint NOT NULL,
	"winner_id" bigint,
	"end_reason" text NOT NULL,
	"longest_rally" smallint DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_stats" (
	"user_id" bigint NOT NULL,
	"game" text DEFAULT 'pong' NOT NULL,
	"matches" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"longest_rally" smallint DEFAULT 0 NOT NULL,
	"best_streak" integer DEFAULT 0 NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_stats_user_id_game_pk" PRIMARY KEY("user_id","game")
);
--> statement-breakpoint
CREATE TABLE "result_cards" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_creation_counters" (
	"user_id" bigint NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "room_creation_counters_user_id_window_start_pk" PRIMARY KEY("user_id","window_start")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"colyseus_room_id" text NOT NULL,
	"game" text DEFAULT 'pong' NOT NULL,
	"host_user_id" bigint NOT NULL,
	"guest_user_id" bigint,
	"chat_instance" text,
	"status" text DEFAULT 'open' NOT NULL,
	"seed" integer NOT NULL,
	"rematch_of_match_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"filled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"photo_url" text,
	"language_code" text,
	"language_override" text,
	"referrer_user_id" bigint,
	"is_premium" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_traces" ADD CONSTRAINT "match_traces_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_cards" ADD CONSTRAINT "result_cards_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_lb_rank_idx" ON "chat_leaderboard" USING btree ("chat_instance","game","wins");--> statement-breakpoint
CREATE INDEX "cheat_flags_user_idx" ON "cheat_flags" USING btree ("user_id","game","active");--> statement-breakpoint
CREATE INDEX "events_name_time_idx" ON "events" USING btree ("name","created_at");--> statement-breakpoint
CREATE INDEX "events_user_idx" ON "events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "h2h_low_idx" ON "head_to_head" USING btree ("game","low_user_id");--> statement-breakpoint
CREATE INDEX "h2h_high_idx" ON "head_to_head" USING btree ("game","high_user_id");--> statement-breakpoint
CREATE INDEX "matches_player_a_idx" ON "matches" USING btree ("player_a_id","ended_at");--> statement-breakpoint
CREATE INDEX "matches_player_b_idx" ON "matches" USING btree ("player_b_id","ended_at");--> statement-breakpoint
CREATE INDEX "matches_chat_idx" ON "matches" USING btree ("chat_instance","ended_at");--> statement-breakpoint
CREATE INDEX "matches_origin_idx" ON "matches" USING btree ("origin","ended_at");--> statement-breakpoint
CREATE INDEX "rooms_status_expires_idx" ON "rooms" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "rooms_host_created_idx" ON "rooms" USING btree ("host_user_id","created_at");--> statement-breakpoint
CREATE INDEX "users_referrer_idx" ON "users" USING btree ("referrer_user_id");