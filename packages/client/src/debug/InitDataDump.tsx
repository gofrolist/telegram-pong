/**
 * The `chat_instance` verification probe.
 *
 * Reached at `?debug=initdata`. Its only purpose is to answer, from real
 * devices and real chats, a question that cannot be answered from the docs:
 * **is `chat_instance` identical within a chat and different across chats, on
 * both mobile and desktop?** A past Telegram Desktop bug reported otherwise,
 * and per-chat leaderboards are worthless — worse, actively wrong — if the
 * answer is no.
 *
 * Run the matrix in `docs/CHAT-INSTANCE-VERIFICATION.md` before trusting
 * `CHAT_LEADERBOARDS_ENABLED`.
 *
 * This page shows the user's own signed launch data and nothing about anyone
 * else. It is still worth remembering that `initData` is a bearer credential:
 * a screenshot of this screen is usable until it expires.
 */

import { useMemo, useState } from 'react';

import type { AuthResponse } from '../api.js';
import type { TelegramEnvironment } from '../telegram.js';

interface Props {
  environment: TelegramEnvironment | null;
  auth: AuthResponse | null;
}

export function InitDataDump({ environment, auth }: Props) {
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => {
    if (!environment?.initDataRaw) return null;
    const params = new URLSearchParams(environment.initDataRaw);
    const out: Record<string, string> = {};
    params.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }, [environment?.initDataRaw]);

  const report = useMemo(
    () =>
      JSON.stringify(
        {
          platform: environment?.platform ?? null,
          chat_instance: parsed?.chat_instance ?? null,
          chat_type: parsed?.chat_type ?? null,
          start_param: parsed?.start_param ?? null,
          user_id: auth?.user.id ?? null,
          language_code: auth?.user.languageCode ?? null,
          server_saw_chat: auth?.chat ?? null,
          raw: environment?.initDataRaw ?? null,
        },
        null,
        2,
      ),
    [environment, parsed, auth],
  );

  return (
    <div className="screen debug">
      <h1>initData probe</h1>

      <table className="debug__table">
        <tbody>
          <tr>
            <th>platform</th>
            <td>{environment?.platform ?? '—'}</td>
          </tr>
          <tr>
            <th>chat_instance</th>
            {/* The value the whole per-chat leaderboard feature rests on. */}
            <td className="debug__highlight">{parsed?.chat_instance ?? '(absent)'}</td>
          </tr>
          <tr>
            <th>chat_type</th>
            <td>{parsed?.chat_type ?? '(absent)'}</td>
          </tr>
          <tr>
            <th>start_param</th>
            <td>{parsed?.start_param ?? '(absent)'}</td>
          </tr>
          <tr>
            <th>user.id</th>
            <td>{auth?.user.id ?? '—'}</td>
          </tr>
          <tr>
            <th>language_code</th>
            <td>{auth?.user.languageCode ?? '(absent)'}</td>
          </tr>
          <tr>
            <th>server saw chat</th>
            <td>{auth?.chat ? `${auth.chat.instance} (${auth.chat.type ?? '?'})` : '(none)'}</td>
          </tr>
        </tbody>
      </table>

      <button
        type="button"
        className="button"
        onClick={() => {
          void navigator.clipboard.writeText(report).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            },
            () => {},
          );
        }}
      >
        {copied ? 'Copied' : 'Copy report'}
      </button>

      <pre className="debug__raw">{report}</pre>
    </div>
  );
}
