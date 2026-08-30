/**
 * Home.
 *
 * The one job of this screen is to get an invite into a chat. Everything else
 * — stats, head-to-head, the chat leaderboard — is below the fold, because the
 * product's whole loop starts with a link being shared.
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import * as api from '../api.js';
import { formatNumber, formatPercent } from '../i18n/index.js';
import { isNetcodeDebugEnabled, loadNetcodeOverlay, setNetcodeDebug } from '../debug/netcode.js';

interface Props {
  language: string;
  profile: api.ProfileResponse | null;
  chatLeaderboard: api.ChatLeaderboardResponse | null;
  onRoomOpened(room: api.CreatedRoom): void;
}

export function Home({ language, profile, chatLeaderboard, onRoomOpened }: Props) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugOn, setDebugOn] = useState(isNetcodeDebugEnabled);

  /**
   * Five taps on the title toggles the netcode overlay.
   *
   * A gesture rather than a setting, because there is nowhere to put a
   * setting: inside Telegram the URL is fixed by BotFather, so a query
   * parameter is not reachable, and a visible switch would be a developer
   * control shipped to every player. Five is high enough that nobody reaches
   * it by fidgeting and low enough to do one-handed while reporting a bug.
   */
  const taps = useRef<{ count: number; last: number }>({ count: 0, last: 0 });
  const tapTitle = useCallback(() => {
    const now = Date.now();
    // Taps more than a second apart are two separate intentions, not a gesture.
    taps.current = now - taps.current.last > 1000
      ? { count: 1, last: now }
      : { count: taps.current.count + 1, last: now };

    if (taps.current.count < 5) return;
    taps.current = { count: 0, last: 0 };

    const next = setNetcodeDebug(!isNetcodeDebugEnabled());
    setDebugOn(next);
    if (next) void loadNetcodeOverlay();
  }, []);
  const startMatch = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      // The host goes straight into their own room; the invite link travels
      // with them and is rendered on the waiting screen. Keeping a copy of it
      // here would be dead state — this component unmounts in the same batch.
      onRoomOpened(await api.createRoom());
    } catch (caught) {
      setError(
        caught instanceof api.ApiError && caught.code === 'too_many_rooms'
          ? t('home.tooManyRooms')
          : t('app.error'),
      );
    } finally {
      setCreating(false);
    }
  }, [onRoomOpened, t]);

  return (
    <div className="screen">
      <header className="screen__header">
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <h1 className="screen__title" onClick={tapTitle}>
          {t('app.title')}
        </h1>
        <p className="screen__tagline">{t('home.tagline')}</p>
        {debugOn && <p className="screen__tagline">{t('home.netcodeDebugOn')}</p>}
      </header>

      <button type="button" className="button button--primary" onClick={() => void startMatch()} disabled={creating}>
        {creating ? t('home.creating') : t('home.play')}
      </button>

      {error && <p className="error">{error}</p>}

      {profile && (
        <section className="card">
          <h2 className="card__title">{t('stats.title')}</h2>
          <dl className="stats">
            <div className="stats__item">
              <dt>{t('stats.matches')}</dt>
              <dd>{formatNumber(profile.stats.matches, language)}</dd>
            </div>
            <div className="stats__item">
              <dt>{t('stats.winRate')}</dt>
              <dd>{formatPercent(profile.stats.winRate, language)}</dd>
            </div>
            <div className="stats__item">
              <dt>{t('stats.longestRally')}</dt>
              <dd>{formatNumber(profile.stats.longestRally, language)}</dd>
            </div>
            <div className="stats__item">
              <dt>{t('stats.bestStreak')}</dt>
              <dd>{formatNumber(profile.stats.bestStreak, language)}</dd>
            </div>
          </dl>
        </section>
      )}

      {profile && profile.opponents.length > 0 && (
        <section className="card">
          <h2 className="card__title">{t('stats.headToHead')}</h2>
          <ul className="list">
            {profile.opponents.map((opponent) => (
              <li key={opponent.opponentId} className="list__row">
                <span className="list__name">
                  {opponent.username ? `@${opponent.username}` : opponent.name}
                </span>
                <span className="list__value">
                  {t('stats.record', {
                    mine: formatNumber(opponent.mine, language),
                    theirs: formatNumber(opponent.theirs, language),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2 className="card__title">{t('stats.chatLeaderboard')}</h2>
        {chatLeaderboard?.available ? (
          <ul className="list">
            {chatLeaderboard.rows.map((row, index) => (
              <li key={row.userId} className="list__row">
                <span className="list__rank">{t('stats.rank', { position: index + 1 })}</span>
                <span className="list__name">{row.username ? `@${row.username}` : row.name}</span>
                <span className="list__value">
                  {formatNumber(row.wins, language)} {t('stats.wins')}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          // `chat_instance` is opaque, so this never names the chat — it can
          // only ever say "this chat".
          <p className="card__text card__text--muted">
            {chatLeaderboard?.reason === 'solo_conversation'
              ? t('stats.chatSolo')
              : t('stats.chatLeaderboardUnavailable')}
          </p>
        )}
      </section>
    </div>
  );
}
