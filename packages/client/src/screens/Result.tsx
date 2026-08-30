/**
 * Post-match result.
 *
 * Two buttons, and the order matters: **Rematch** is the retention mechanic,
 * **Share** is the acquisition one. Every result screen carries both, and the
 * shared card carries a rematch button of its own so the loop continues inside
 * the chat rather than only inside the app.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EndReason } from '@pong/game-core';

import * as api from '../api.js';
import { formatNumber } from '../i18n/index.js';
import { sharePreparedMessage } from '../telegram.js';
import type { MatchOutcome } from '../game/MatchView.js';

interface Props {
  outcome: MatchOutcome;
  language: string;
  onRematch(room: api.CreatedRoom): void;
  onHome(): void;
}

export function Result({ outcome, language, onRematch, onHome }: Props) {
  const { t } = useTranslation();
  const [sharing, setSharing] = useState(false);
  const [rematching, setRematching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headline = (() => {
    if (outcome.endReason === EndReason.DISCONNECT) {
      return outcome.won ? t('result.wonByDisconnect') : t('result.lostByDisconnect');
    }
    if (outcome.endReason === EndReason.FORFEIT) {
      return outcome.won ? t('result.wonByForfeit') : t('result.lostByForfeit');
    }
    return outcome.won ? t('result.youWon') : t('result.youLost');
  })();

  const share = useCallback(async () => {
    setSharing(true);
    setError(null);
    try {
      // A fresh prepared-message id on every tap: the id is single-use, and a
      // cached one gives the user a picker that silently does nothing.
      const prepared = await api.prepareShare(outcome.matchId);
      const sent = await sharePreparedMessage(prepared.id);
      api.reportEvent(sent ? 'share_message_sent' : 'share_message_failed', {
        matchId: outcome.matchId,
      });
      if (!sent) setError(t('result.shareFailed'));
    } catch {
      api.reportEvent('share_message_failed', { matchId: outcome.matchId });
      setError(t('result.shareFailed'));
    } finally {
      setSharing(false);
    }
  }, [outcome.matchId, t]);

  const rematch = useCallback(async () => {
    setRematching(true);
    setError(null);
    api.reportEvent('rematch_tapped', { matchId: outcome.matchId });
    try {
      const room = await api.createRoom({ rematchOfMatchId: outcome.matchId });
      onRematch(room);
    } catch {
      setError(t('app.error'));
      setRematching(false);
    }
  }, [outcome.matchId, onRematch, t]);

  return (
    <div className="screen screen--centered">
      <h1 className="result__headline">{headline}</h1>

      <div className="result__score">
        <span className="result__score-value">{formatNumber(outcome.scoreSelf, language)}</span>
        <span className="result__score-separator">:</span>
        <span className="result__score-value result__score-value--muted">
          {formatNumber(outcome.scoreOpponent, language)}
        </span>
      </div>

      {outcome.longestRally > 0 && (
        <p className="result__detail">
          {t('result.longestRally')}: {t('result.hits', { count: outcome.longestRally })}
        </p>
      )}

      <button type="button" className="button button--primary" onClick={rematch} disabled={rematching}>
        {rematching ? t('result.rematchOpening') : t('result.rematch')}
      </button>

      <button type="button" className="button" onClick={share} disabled={sharing}>
        {sharing ? t('result.sharing') : t('result.share')}
      </button>

      <button type="button" className="button button--quiet" onClick={onHome}>
        {t('result.backHome')}
      </button>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
