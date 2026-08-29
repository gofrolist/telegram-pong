# Verifying `chat_instance` before trusting per-chat leaderboards

**Status: NOT RUN.** This requires two Telegram accounts, two group chats, and
a deployed HTTPS page. Until it has been run and the results recorded below,
`CHAT_LEADERBOARDS_ENABLED` stays `false`.

## Why this exists

Per-chat leaderboards key entirely on `chat_instance` from `initData`. The
documented behaviour is that it identifies a chat opaquely and stably. If that
is not true in practice, the feature is not merely useless — it is *wrong*:
leaderboards would fragment across launches, or worse, two different chats
would share one board and members would see strangers' scores.

A Telegram Desktop bug has been reported in which `chat_instance` differed
where it should have matched. That report is the whole reason for this
document. Do not build on the field until you have seen it behave.

## What must be true

| # | Claim | Why it matters |
|---|---|---|
| 1 | `chat_instance` is **identical** for two different users opening the same link from the same chat | Otherwise each member gets a private leaderboard of one |
| 2 | `chat_instance` is **identical** across repeated launches by the same user from the same chat | Otherwise a member's wins scatter across boards |
| 3 | `chat_instance` **differs** between two different chats | Otherwise two chats share a board and leak scores |
| 4 | Claims 1–3 hold on **both** mobile and desktop | The reported bug was desktop-specific |
| 5 | `chat_instance` is **absent** when launched from the bot menu or `/start` | The code must fall back to profile + head-to-head, not render an empty board |
| 6 | `chat_type` is present and correct | Used to suppress the board in `sender`/`private` conversations |

## The probe

Already built. Deploy the client and open:

```
https://<your-app>.vercel.app/?debug=initdata
```

It renders `chat_instance`, `chat_type`, `start_param`, the platform, and what
the server independently parsed from the same payload — plus a **Copy report**
button that yields a JSON blob to paste into the table below.

> `initData` is a bearer credential. A screenshot of the probe is usable until
> it expires. Do not paste raw `initData` into a shared document; the report
> button gives you the fields without it if you strip `raw`.

## The matrix

You need:

- Two Telegram accounts: **A** and **B**
- Two group chats: **G1** (both accounts present) and **G2** (at least A)
- Both a phone and a desktop client for at least account A

Post the Mini App link into **G1** and into **G2**, then open it via each link
and record `chat_instance`:

| Run | Account | Chat | Platform | `chat_instance` | `chat_type` |
|---|---|---|---|---|---|
| 1 | A | G1 | mobile | | |
| 2 | A | G1 | mobile (relaunch) | | |
| 3 | B | G1 | mobile | | |
| 4 | A | G2 | mobile | | |
| 5 | A | G1 | desktop | | |
| 6 | B | G1 | desktop | | |
| 7 | A | G2 | desktop | | |
| 8 | A | — (bot menu `/start`) | mobile | | |
| 9 | A | direct chat with bot | mobile | | |

## Reading the results

```
Claim 1  →  run 1 == run 3      and  run 5 == run 6
Claim 2  →  run 1 == run 2
Claim 3  →  run 1 != run 4      and  run 5 != run 7
Claim 4  →  run 1 == run 5      (same chat, different platform)
Claim 5  →  run 8 is absent
Claim 6  →  run 9 chat_type is 'sender' or 'private'
```

## What each outcome changes

- **All claims hold** → set `CHAT_LEADERBOARDS_ENABLED=true`. No code changes.
- **Claim 4 fails** (mobile and desktop disagree for the same chat) → the
  feature still works, but a member switching devices splits their record.
  Either keep it disabled, or store both instances against one chat and merge —
  a schema change to `chats`, not to the leaderboard logic.
- **Claim 1 fails** (two users in one chat get different values) → the feature
  is unbuildable on this field. Leave it off. Head-to-head and profile stats
  are unaffected and already ship.
- **Claim 3 fails** (two chats collide) → leave it off, and report it. This is
  a privacy problem, not a feature problem.
- **Claim 5 or 6 fails** → the fallback code already handles an absent
  `chat_instance`, and `/api/stats/chat` returns `{ available: false, reason }`
  rather than an empty table. Verify the UI shows the fallback copy.

## Record the outcome here

```
Date run:
Run by:
Telegram versions (mobile / desktop):
Result:
Decision:
```
