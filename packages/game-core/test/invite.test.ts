import { describe, expect, it } from 'vitest';
import {
  MAX_START_PARAM_LENGTH,
  composeRoomId,
  decodeInvite,
  encodeInvite,
  inviteUrl,
  parseRoomId,
} from '../src/index.js';

/** Exactly the alphabet Telegram permits in a `startapp` parameter. */
const TELEGRAM_SAFE = /^[A-Za-z0-9_-]+$/;

describe('invite payloads', () => {
  it('round-trips', () => {
    const payload = { game: 'pong', room: 'fly123-ABCD2345', ref: 987654321 };
    expect(decodeInvite(encodeInvite(payload))).toEqual(payload);
  });

  it('round-trips without a referrer', () => {
    const payload = { game: 'pong', room: 'fly123-ABCD2345' };
    expect(decodeInvite(encodeInvite(payload))).toEqual(payload);
  });

  it('only ever emits characters Telegram accepts', () => {
    // A payload containing `+`, `/` or `=` produces a link Telegram silently
    // truncates, which is the kind of bug that only shows up in a real chat.
    for (const ref of [1, 42, 9007199254740991]) {
      for (const game of ['pong', 'a-game_with-symbols']) {
        const encoded = encodeInvite({ game, room: 'fly-XYZ', ref });
        expect(encoded).toMatch(TELEGRAM_SAFE);
        expect(encoded.length).toBeLessThanOrEqual(MAX_START_PARAM_LENGTH);
      }
    }
  });

  it('stays comfortably short for a realistic payload', () => {
    const encoded = encodeInvite({ game: 'pong', room: '148e392a7d1e08-ABCD2345', ref: 987654321 });
    // Short links survive being screenshot, retyped and forwarded.
    expect(encoded.length).toBeLessThan(80);
  });

  it('returns null for anything malformed rather than throwing', () => {
    // This value arrives from a URL a stranger may have edited; a broken
    // invite must land on the home screen, not on an error boundary.
    expect(decodeInvite(null)).toBeNull();
    expect(decodeInvite(undefined)).toBeNull();
    expect(decodeInvite('')).toBeNull();
    expect(decodeInvite('!!!not-base64!!!')).toBeNull();
    expect(decodeInvite('a'.repeat(MAX_START_PARAM_LENGTH + 1))).toBeNull();
    expect(decodeInvite('QUJD')).toBeNull(); // valid base64url, wrong record
  });

  it('rejects a payload from a different codec version', () => {
    const encoded = encodeInvite({ game: 'pong', room: 'r' });
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const bumped = Buffer.from(decoded.replace(/^1/, '9'), 'utf8').toString('base64url');
    expect(decodeInvite(bumped)).toBeNull();
  });

  it('drops a nonsensical referrer instead of trusting it', () => {
    const encoded = Buffer.from('1~pong~room~not-a-number', 'utf8').toString('base64url');
    expect(decodeInvite(encoded)).toEqual({ game: 'pong', room: 'room' });

    const negative = Buffer.from('1~pong~room~-5', 'utf8').toString('base64url');
    expect(decodeInvite(negative)).toEqual({ game: 'pong', room: 'room' });
  });

  it('builds a link of the shape Telegram expects', () => {
    const url = inviteUrl('pongduel_bot', 'pong', { game: 'pong', room: 'm-CODE' });
    expect(url).toMatch(/^https:\/\/t\.me\/pongduel_bot\/pong\?startapp=[A-Za-z0-9_-]+$/);
  });
});

describe('room ids', () => {
  it('carries the machine id so a second machine is a routing header', () => {
    const roomId = composeRoomId('148e392a7d1e08', 'ABCD2345');
    expect(parseRoomId(roomId)).toEqual({ machineId: '148e392a7d1e08', code: 'ABCD2345' });
  });

  it('survives a machine id that itself contains a hyphen', () => {
    // Only the FIRST hyphen separates, so `fly-machine-01` stays intact as a
    // code even though the id has hyphens of its own.
    expect(parseRoomId('fly-machine-01')).toEqual({ machineId: 'fly', code: 'machine-01' });
  });

  it('returns null for a malformed id', () => {
    expect(parseRoomId('nohyphen')).toBeNull();
    expect(parseRoomId('-leading')).toBeNull();
    expect(parseRoomId('trailing-')).toBeNull();
  });
});
