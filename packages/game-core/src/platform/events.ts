/**
 * The analytics funnel.
 *
 * Every name the product needs in order to be falsifiable lives here, in one
 * closed union, so that a typo becomes a type error instead of a silently
 * missing row. The two questions the platform is judged on — does this make
 * someone more likely to invite another person, and does it still hold with a
 * second game — are answerable only from these events.
 */

export const AnalyticsEvent = {
  /** Mini App opened, for any reason. */
  LAUNCH: 'launch',
  /** Launch carried a referrer in the start param. */
  REFERRER_PRESENT: 'referrer_present',
  /** `initData` carried a `chat_instance`, i.e. opened via a direct link. */
  CHAT_CONTEXT_PRESENT: 'chat_context_present',
  ROOM_CREATED: 'room_created',
  INVITE_SHARED: 'invite_shared',
  OPPONENT_JOINED: 'opponent_joined',
  MATCH_STARTED: 'match_started',
  MATCH_COMPLETED: 'match_completed',
  DISCONNECT: 'disconnect',
  RECONNECTED: 'reconnected',
  SHARE_TAPPED: 'share_tapped',
  SHARE_MESSAGE_SENT: 'share_message_sent',
  SHARE_MESSAGE_FAILED: 'share_message_failed',
  REMATCH_TAPPED: 'rematch_tapped',
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

/** Where a match came from. Tagged from day one so a future global rating can
 * be computed exclusively from pool matches without a backfill. */
export const MatchOrigin = {
  INVITE: 'invite',
  POOL: 'pool',
} as const;
export type MatchOriginValue = (typeof MatchOrigin)[keyof typeof MatchOrigin];

export interface AnalyticsPayload {
  name: AnalyticsEventName;
  /** Telegram user id, when known. */
  userId?: number;
  /** Opaque chat identity, when the session has one. */
  chatInstance?: string | null;
  game?: string;
  roomId?: string;
  matchId?: string;
  props?: Record<string, string | number | boolean | null>;
}
