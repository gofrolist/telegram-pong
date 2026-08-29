/**
 * Bot-side localisation.
 *
 * A plain object of strings. No gettext machinery, no extraction pipeline —
 * the bot has a dozen messages and a build step for them would cost more than
 * it saves.
 *
 * Resolution is exact tag → base language → English, and never an empty
 * string: `language_code` is optional and may carry a region (`pt-br`,
 * `en-gb`), so a naive lookup silently renders nothing for a large minority of
 * users.
 *
 * Adding a language is adding one key to `dictionaries`.
 */

export const SUPPORTED_LANGUAGES = ['en', 'ru'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

interface Dictionary {
  start: string;
  startPlay: string;
  opponentWaiting: (name: string) => string;
  opponentWaitingButton: string;
  rematchButton: string;
  playButton: string;
  cardCaption: (winner: string, loser: string, scoreWinner: number, scoreLoser: number) => string;
  help: string;
  unknownCommand: string;
}

const en: Dictionary = {
  start:
    'Pong. Two players, one ball, no bots.\n\nTap Play, then share the invite into any chat — whoever taps it first is your opponent.',
  startPlay: 'Play',
  opponentWaiting: (name) => `${name} took your invite and is waiting in the room. Jump in.`,
  opponentWaitingButton: 'Join the match',
  rematchButton: 'Rematch',
  playButton: 'Play',
  cardCaption: (winner, loser, scoreWinner, scoreLoser) =>
    `${winner} ${scoreWinner}–${scoreLoser} ${loser}`,
  help: 'Tap Play to open the game. Share an invite link into a chat and the first person to tap it becomes your opponent.',
  unknownCommand: 'Tap Play to start a match.',
};

const ru: Dictionary = {
  start:
    'Понг. Двое игроков, один мяч, никаких ботов.\n\nНажмите «Играть» и отправьте приглашение в любой чат — соперником станет тот, кто нажмёт первым.',
  startPlay: 'Играть',
  opponentWaiting: (name) => `${name} принял приглашение и ждёт в комнате. Заходите.`,
  opponentWaitingButton: 'Войти в матч',
  rematchButton: 'Реванш',
  playButton: 'Играть',
  cardCaption: (winner, loser, scoreWinner, scoreLoser) =>
    `${winner} ${scoreWinner}–${scoreLoser} ${loser}`,
  help: 'Нажмите «Играть», чтобы открыть игру. Отправьте ссылку-приглашение в чат — соперником станет тот, кто нажмёт первым.',
  unknownCommand: 'Нажмите «Играть», чтобы начать матч.',
};

const dictionaries: Record<Language, Dictionary> = { en, ru };

/**
 * Resolve a Telegram `language_code` to a language we ship.
 *
 * `language_code` is signed by Telegram, so it is trustworthy server-side and
 * matches what the bot sees in `from.language_code` — the Mini App and the bot
 * therefore never disagree about a user's language.
 */
export function resolveLanguage(languageCode: string | null | undefined): Language {
  if (!languageCode) return DEFAULT_LANGUAGE;
  const normalised = languageCode.toLowerCase();

  // Exact tag first: `pt-br` should be able to beat `pt` once we ship it.
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(normalised)) {
    return normalised as Language;
  }
  const base = normalised.split('-')[0];
  if (base && (SUPPORTED_LANGUAGES as readonly string[]).includes(base)) {
    return base as Language;
  }
  return DEFAULT_LANGUAGE;
}

export function t(languageCode: string | null | undefined): Dictionary {
  return dictionaries[resolveLanguage(languageCode)];
}
