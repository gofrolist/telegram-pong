/**
 * `initData` validation and session-token tests.
 *
 * These are the tests that matter most for security: everything downstream —
 * who owns a match, whose leaderboard row moves, who may share a card — rests
 * on this one HMAC check being right and on a forged or stale payload being
 * rejected rather than merely logged.
 */

import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const BOT_TOKEN = '123456:TEST-BOT-TOKEN-FOR-UNIT-TESTS-ONLY';

// The config module reads the environment at import time, so it has to be
// populated before anything under test is imported.
process.env.NODE_ENV = 'test';
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.TELEGRAM_BOT_USERNAME = 'pong_test_bot';
process.env.TELEGRAM_APP_NAME = 'pong';
process.env.TELEGRAM_WEBHOOK_SECRET = 'webhook-secret-value-1234567890';
process.env.PUBLIC_SERVER_URL = 'https://server.example.com';
process.env.PUBLIC_CLIENT_URL = 'https://client.example.com';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/pong';
process.env.SESSION_SECRET = 'a-session-secret-of-at-least-32-characters';
process.env.INIT_DATA_MAX_AGE_SEC = '900';
process.env.SESSION_TTL_SEC = '3600';

let sign: typeof import('@telegram-apps/init-data-node').sign;
let verifyInitData: typeof import('../src/telegram/initData.js').verifyInitData;
let issueSessionToken: typeof import('../src/telegram/initData.js').issueSessionToken;
let verifySessionToken: typeof import('../src/telegram/initData.js').verifySessionToken;
let InitDataError: typeof import('../src/telegram/initData.js').InitDataError;

beforeAll(async () => {
  ({ sign } = await import('@telegram-apps/init-data-node'));
  ({ verifyInitData, issueSessionToken, verifySessionToken, InitDataError } = await import(
    '../src/telegram/initData.js'
  ));
});

interface SignOverrides {
  chatInstance?: string;
  chatType?: string;
  startParam?: string;
  languageCode?: string;
  userId?: number;
}

function signedInitData(authDate: Date, overrides: SignOverrides = {}): string {
  return sign(
    {
      user: {
        id: overrides.userId ?? 424242,
        first_name: 'Ada',
        last_name: 'Lovelace',
        username: 'ada',
        language_code: overrides.languageCode ?? 'ru',
        is_premium: true,
        photo_url: 'https://example.com/ada.jpg',
      },
      chat_instance: overrides.chatInstance,
      chat_type: overrides.chatType,
      start_param: overrides.startParam,
    },
    BOT_TOKEN,
    authDate,
  );
}

describe('verifyInitData', () => {
  it('accepts freshly signed init data and extracts the user', () => {
    const session = verifyInitData(signedInitData(new Date()));

    expect(session.user.id).toBe(424242);
    expect(session.user.firstName).toBe('Ada');
    expect(session.user.username).toBe('ada');
    // `language_code` is signed, so it is trustworthy for localisation.
    expect(session.user.languageCode).toBe('ru');
    expect(session.user.isPremium).toBe(true);
    expect(session.user.photoUrl).toBe('https://example.com/ada.jpg');
  });

  it('extracts chat context when the app was opened by direct link', () => {
    const session = verifyInitData(
      signedInitData(new Date(), { chatInstance: '-9007199254740991', chatType: 'supergroup' }),
    );
    expect(session.chatInstance).toBe('-9007199254740991');
    expect(session.chatType).toBe('supergroup');
  });

  it('reports no chat context for a launch without one', () => {
    // A launch from the bot menu or `/start` carries no `chat_instance`; the
    // product must fall back to profile and head-to-head rather than showing
    // an empty chat leaderboard.
    const session = verifyInitData(signedInitData(new Date()));
    expect(session.chatInstance).toBeNull();
    expect(session.chatType).toBeNull();
  });

  it('carries the start param through untouched', () => {
    const session = verifyInitData(signedInitData(new Date(), { startParam: 'MX5wb25nfmFiYw' }));
    expect(session.startParam).toBe('MX5wb25nfmFiYw');
  });

  it('rejects a payload signed with a different bot token', () => {
    const forged = sign({ user: { id: 1, first_name: 'Mallory' } }, 'wrong:token', new Date());
    expect(() => verifyInitData(forged)).toThrowError(InitDataError);
    try {
      verifyInitData(forged);
    } catch (error) {
      expect((error as InstanceType<typeof InitDataError>).reason).toBe('signature');
    }
  });

  it('rejects a payload whose fields were edited after signing', () => {
    // The exact attack the HMAC exists to stop: take a valid payload and
    // change whose match it is.
    const valid = signedInitData(new Date());
    const params = new URLSearchParams(valid);
    const user = JSON.parse(params.get('user')!) as { id: number };
    user.id = 999999;
    params.set('user', JSON.stringify(user));

    expect(() => verifyInitData(params.toString())).toThrowError(InitDataError);
  });

  it('rejects stale init data', () => {
    const stale = signedInitData(new Date(Date.now() - 3600_000));
    try {
      verifyInitData(stale);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(InitDataError);
      expect((error as InstanceType<typeof InitDataError>).reason).toBe('expired');
    }
  });

  it('rejects empty, malformed and hash-less payloads', () => {
    expect(() => verifyInitData('')).toThrowError(InitDataError);
    expect(() => verifyInitData('not-even-query-params')).toThrowError(InitDataError);
    expect(() => verifyInitData('user=%7B%22id%22%3A1%7D&auth_date=1')).toThrowError(InitDataError);
  });

  it('rejects init data that carries no user', () => {
    const noUser = sign({ chat_instance: 'abc' }, BOT_TOKEN, new Date());
    try {
      verifyInitData(noUser);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(InitDataError);
      expect((error as InstanceType<typeof InitDataError>).reason).toBe('malformed');
    }
  });
});

describe('session tokens', () => {
  function freshSession() {
    return verifyInitData(
      signedInitData(new Date(), { chatInstance: 'chat-1', chatType: 'group' }),
    );
  }

  it('round-trips a session', () => {
    const token = issueSessionToken(freshSession());
    const decoded = verifySessionToken(token);

    expect(decoded).not.toBeNull();
    expect(decoded!.uid).toBe(424242);
    expect(decoded!.ci).toBe('chat-1');
    expect(decoded!.ct).toBe('group');
    expect(decoded!.l).toBe('ru');
  });

  it('rejects a token whose payload was tampered with', () => {
    const token = issueSessionToken(freshSession());
    const [payload, mac] = token.split('.') as [string, string];

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    decoded.uid = 111;
    const forgedPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');

    // Same MAC, different payload — the whole point of signing it.
    expect(verifySessionToken(`${forgedPayload}.${mac}`)).toBeNull();
  });

  it('rejects a token with a truncated or absent signature', () => {
    const token = issueSessionToken(freshSession());
    const payload = token.split('.')[0]!;
    expect(verifySessionToken(payload)).toBeNull();
    expect(verifySessionToken(`${payload}.`)).toBeNull();
    expect(verifySessionToken(`${payload}.short`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const session = freshSession();
    const token = issueSessionToken(session);
    const payload = token.split('.')[0]!;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    decoded.exp = Math.floor(Date.now() / 1000) - 1;

    // Re-sign it correctly, so only the expiry is wrong: this proves expiry is
    // checked rather than merely encoded.
    const newPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    const newMac = createHmac('sha256', process.env.SESSION_SECRET!)
      .update(newPayload)
      .digest('base64url');

    expect(verifySessionToken(`${newPayload}.${newMac}`)).toBeNull();
  });

  it('rejects null, undefined and rubbish', () => {
    expect(verifySessionToken(null)).toBeNull();
    expect(verifySessionToken(undefined)).toBeNull();
    expect(verifySessionToken('')).toBeNull();
    expect(verifySessionToken('.')).toBeNull();
    expect(verifySessionToken('nonsense')).toBeNull();
  });
});
