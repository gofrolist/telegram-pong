/**
 * Invite payload codec.
 *
 * A Mini App start link looks like `t.me/<bot>/<app>?startapp=<payload>`, and
 * Telegram restricts `<payload>` to `A-Z a-z 0-9 _ -` with a 512-character
 * ceiling. That is base64url minus padding, so we encode a compact
 * pipe-delimited record rather than JSON — a JSON payload for the same data is
 * roughly three times longer, and short links survive being retyped, screenshot
 * and forwarded.
 *
 * Game-agnostic on purpose: the `game` field is what lets a second game reuse
 * the whole invite path untouched.
 */

export interface InvitePayload {
  /** Which game the link opens. `pong` today. */
  game: string;
  /**
   * Room code. Carries the machine id as a prefix (`<machine>-<code>`) so a
   * later multi-machine deployment can route the joiner with `fly-replay`
   * without a shared room registry. See `docs/ASSUMPTIONS.md`.
   */
  room: string;
  /** Telegram user id of whoever created the link, for referral attribution. */
  ref?: number;
}

const VERSION = '1';
const SEPARATOR = '~';

/** Characters Telegram permits in `startapp`. */
const ALLOWED = /^[A-Za-z0-9_-]*$/;
/** Telegram's documented ceiling for a `startapp` parameter. */
export const MAX_START_PARAM_LENGTH = 512;

/**
 * `btoa` / `atob` are used rather than `Buffer`: both are global in Node 22 and
 * in every browser, so this module stays free of a Node-only branch that a
 * bundler would have to shim into the Mini App.
 */
function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Encode a payload into a `startapp`-safe string. */
export function encodeInvite(payload: InvitePayload): string {
  const record = [VERSION, payload.game, payload.room, payload.ref ?? ''].join(SEPARATOR);
  const encoded = toBase64Url(record);
  if (encoded.length > MAX_START_PARAM_LENGTH) {
    throw new Error(`invite payload too long: ${encoded.length} > ${MAX_START_PARAM_LENGTH}`);
  }
  return encoded;
}

/**
 * Decode a `startapp` value.
 *
 * Returns `null` rather than throwing for anything malformed: this string
 * arrives from a URL a stranger may have edited, and a launch with a broken
 * invite should land on the home screen, not on an error boundary.
 */
export function decodeInvite(raw: string | null | undefined): InvitePayload | null {
  if (!raw || !ALLOWED.test(raw) || raw.length > MAX_START_PARAM_LENGTH) return null;
  let decoded: string;
  try {
    decoded = fromBase64Url(raw);
  } catch {
    return null;
  }
  const parts = decoded.split(SEPARATOR);
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, game, room, ref] = parts as [string, string, string, string];
  if (!game || !room) return null;

  const payload: InvitePayload = { game, room };
  if (ref) {
    const parsed = Number(ref);
    if (Number.isSafeInteger(parsed) && parsed > 0) payload.ref = parsed;
  }
  return payload;
}

/** Build the shareable link for an invite. */
export function inviteUrl(botUsername: string, appName: string, payload: InvitePayload): string {
  return `https://t.me/${botUsername}/${appName}?startapp=${encodeInvite(payload)}`;
}

/**
 * Compose a room id that carries the machine that owns it.
 *
 * Not used for routing yet — with `min_machines_running = 1` there is exactly
 * one machine. It exists now so that adding a second machine later is a
 * `fly-replay` header and not a data migration.
 */
export function composeRoomId(machineId: string, code: string): string {
  return `${machineId}-${code}`;
}

/** Split a room id back into machine and code. */
export function parseRoomId(roomId: string): { machineId: string; code: string } | null {
  const index = roomId.indexOf('-');
  if (index <= 0 || index === roomId.length - 1) return null;
  return { machineId: roomId.slice(0, index), code: roomId.slice(index + 1) };
}
