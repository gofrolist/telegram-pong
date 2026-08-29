/**
 * Home.
 *
 * The one job of this screen is to get an invite into a chat. Everything else
 * — stats, head-to-head, the chat leaderboard — is below the fold, because the
 * product's whole loop starts with a link being shared.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import * as api from '../api.js';
import { formatNumber, formatPercent } from '../i18n/index.js';

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
  const [invite, setInvite] = useState<api.CreatedRoom | null>(null);
  const [copied, setCopied] = useState(false);

  const startMatch = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const room = await api.createRoom();
      setInvite(room);
      onRoomOpened(room);
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

  const copyLink = useCallback(async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.inviteUrl);
      setCopied(true);
      api.reportEvent('invite_shared', { props: { method: 'copy' } });
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission can be denied inside the webview; the link is
      // visible on screen either way.
      setError(t('app.error'));
    }
  }, [invite, t]);

  return (
    <div className="screen">
      <header className="screen__header">
        <h1 className="screen__title">{t('app.title')}</h1>
        <p className="screen__tagline">{t('home.tagline')}</p>
      </header>

      {!invite ? (
        <button type="button" className="button button--primary" onClick={startMatch} disabled={creating}>
          {creating ? t('home.creating') : t('home.play')}
        </button>
      ) : (
        <section className="card">
          <p className="card__text">{t('home.inviteReady')}</p>
          <code className="card__link">{invite.inviteUrl}</code>
          <button type="button" className="button button--primary" onClick={copyLink}>
            {copied ? t('home.copied') : t('home.copyLink')}
          </button>
        </section>
      )}

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
