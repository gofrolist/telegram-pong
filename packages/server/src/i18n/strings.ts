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
  /** Sent to the GUEST when the host comes back to a room the guest has left. */
  hostReturned: (name: string) => string;
  hostReturnedButton: string;
  rematchButton: string;
  playButton: string;
  /** Title of the invite in Telegram's share picker. */
  inviteTitle: string;
  /** Body of the invite message the recipient receives. */
  inviteText: (name: string) => string;
  inviteButton: string;
  cardCaption: (winner: string, loser: string, scoreWinner: number, scoreLoser: number) => string;
  help: string;
  unknownCommand: string;
}

const en: Dictionary = {
  start:
    'Pong. Two players, one ball, no bots.\n\nTap Play, then share the invite into any chat — whoever taps it first is your opponent.',
  startPlay: 'Play',
  opponentWaiting: (name) => `${name} took your invite. Open the room and they will get a nudge.`,
  opponentWaitingButton: 'Open the room',
  hostReturned: (name) => `${name} is at the table now. Your seat is still yours.`,
  hostReturnedButton: 'Take your seat',
  rematchButton: 'Rematch',
  playButton: 'Play',
  inviteTitle: 'Pong — first to tap plays',
  inviteText: (name) =>
    `${name} wants to play Pong. Two players, one ball, no bots — whoever taps first is the opponent.`,
  inviteButton: 'Play',
  cardCaption: (winner, loser, scoreWinner, scoreLoser) =>
    `${winner} ${scoreWinner}–${scoreLoser} ${loser}`,
  help: 'Tap Play to open the game. Share an invite link into a chat and the first person to tap it becomes your opponent.',
  unknownCommand: 'Tap Play to start a match.',
};

const ru: Dictionary = {
  start:
    'Понг. Двое игроков, один мяч, никаких ботов.\n\nНажмите «Играть» и отправьте приглашение в любой чат — соперником станет тот, кто нажмёт первым.',
  startPlay: 'Играть',
  opponentWaiting: (name) => `${name} принял приглашение. Откройте комнату — ему придёт напоминание.`,
  opponentWaitingButton: 'Открыть комнату',
  hostReturned: (name) => `${name} за столом. Ваше место свободно.`,
  hostReturnedButton: 'Занять место',
  rematchButton: 'Реванш',
  playButton: 'Играть',
  inviteTitle: 'Понг — играет тот, кто нажмёт первым',
  inviteText: (name) =>
    `${name} зовёт сыграть в понг. Двое игроков, один мяч, никаких ботов — соперником станет тот, кто нажмёт первым.`,
  inviteButton: 'Играть',
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
