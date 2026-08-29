/**
 * Localisation.
 *
 * Initialised **explicitly** from `initData`, never from the browser language
 * detector. Inside Telegram's webview the browser language reports the host
 * OS's language rather than the user's Telegram language, and the two
 * routinely disagree — a Russian-speaking user on an English phone would get
 * an English app while the bot messages them in Russian.
 *
 * Resolution order: explicit in-app choice → signed `language_code` → English.
 *
 * `language_code` is optional and may carry a region (`pt-br`, `en-gb`), so
 * every lookup falls back exact tag → base language → English. Nothing ever
 * renders an empty string.
 *
 * Adding a language is one JSON file plus one line in `resources`.
 */

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import ru from './locales/ru.json';

export const SUPPORTED_LANGUAGES = ['en', 'ru'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const FALLBACK_LANGUAGE: Language = 'en';

const resources = {
  en: { translation: en },
  ru: { translation: ru },
} as const;

/** Exact tag → base language → English. */
export function resolveLanguage(tag: string | null | undefined): Language {
  if (!tag) return FALLBACK_LANGUAGE;
  const normalised = tag.toLowerCase();
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(normalised)) {
    return normalised as Language;
  }
  const base = normalised.split('-')[0];
  if (base && (SUPPORTED_LANGUAGES as readonly string[]).includes(base)) {
    return base as Language;
  }
  return FALLBACK_LANGUAGE;
}

/**
 * @param override - an explicit in-app choice, if the user has made one.
 * @param languageCode - `language_code` from signed `initData`.
 */
export async function initI18n(
  override: string | null,
  languageCode: string | null | undefined,
): Promise<Language> {
  const language = resolveLanguage(override ?? languageCode);

  await i18next.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: FALLBACK_LANGUAGE,
    // Deliberately no `LanguageDetector`. See the file comment.
    interpolation: { escapeValue: false },
    returnEmptyString: false,
  });

  return language;
}

export async function changeLanguage(language: Language): Promise<void> {
  await i18next.changeLanguage(language);
}

/**
 * Number formatting on the resolved locale.
 *
 * Formatters are expensive to construct and are built once per locale rather
 * than per render — a leaderboard rebuilds this on every frame otherwise.
 */
const numberFormatters = new Map<string, Intl.NumberFormat>();

export function formatNumber(value: number, language: string): string {
  let formatter = numberFormatters.get(language);
  if (!formatter) {
    formatter = new Intl.NumberFormat(language);
    numberFormatters.set(language, formatter);
  }
  return formatter.format(value);
}

const percentFormatters = new Map<string, Intl.NumberFormat>();

export function formatPercent(value: number, language: string): string {
  let formatter = percentFormatters.get(language);
  if (!formatter) {
    formatter = new Intl.NumberFormat(language, {
      style: 'percent',
      maximumFractionDigits: 0,
    });
    percentFormatters.set(language, formatter);
  }
  return formatter.format(value);
}

export { i18next };
