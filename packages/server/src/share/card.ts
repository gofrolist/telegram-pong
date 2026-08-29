/**
 * The shareable result card.
 *
 * Rendered from an SVG template with values substituted, rasterised by resvg.
 *
 * Explicitly NOT a headless browser. Chromium rendering a card is a
 * multi-hundred-millisecond CPU spike on a machine that is also running the
 * 30 Hz tick of every live match; one share would visibly stutter every
 * concurrent game. resvg is a Rust rasteriser that finishes in single-digit
 * milliseconds, and even that runs strictly off the game loop.
 *
 * Design brief: score in very large numerals, both avatars, an emoji, almost
 * no words. The card is read by people whose language differs from the
 * sharer's, and terse cards travel further.
 */

import { Resvg } from '@resvg/resvg-js';

const WIDTH = 1080;
const HEIGHT = 1080;

export interface CardPlayer {
  name: string;
  photoUrl?: string | null;
  score: number;
  isWinner: boolean;
}

export interface CardInput {
  bottom: CardPlayer;
  top: CardPlayer;
  longestRally: number;
}

/** XML-escape a value before it goes anywhere near the template. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Names are rendered small and must not overflow the card.
 *
 * Cut on code *points*, not UTF-16 code units: Telegram first names routinely
 * contain emoji, and slicing one in half leaves a lone surrogate, which is not
 * a legal XML character — resvg then renders tofu or rejects the SVG outright.
 */
function truncate(value: string, max = 14): string {
  const points = [...value.trim()];
  if (points.length <= max) return points.join('');
  return `${points.slice(0, max - 1).join('')}…`;
}

/**
 * Fetch an avatar and inline it as a data URI.
 *
 * resvg has no network stack, so a remote `<image href>` renders as nothing.
 * A failed or slow fetch falls back to an initials disc rather than delaying
 * the card: the share tap is an interactive moment.
 */
const MAX_AVATAR_BYTES = 2_000_000;

async function fetchAvatar(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const controller = new AbortController();
    // The timeout has to survive until the *body* is read. Clearing it once
    // the headers land leaves a server that returns 200 and then trickles
    // bytes able to hold this promise — and the share request awaiting it —
    // open indefinitely.
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;

      const type = response.headers.get('content-type') ?? 'image/jpeg';
      if (!type.startsWith('image/')) return null;

      // A Telegram avatar is tens of kilobytes; anything far larger is not
      // one. Checked from the header first so an oversized body is never
      // buffered into memory at all.
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) return null;

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_AVATAR_BYTES) return null;
      return `data:${type};base64,${buffer.toString('base64')}`;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

/** Deterministic accent colour from a name, for the initials fallback. */
function accentFor(name: string): string {
  const palette = ['#2f6fed', '#e0533d', '#2fa36b', '#8b5cf6', '#d9820b', '#0e9bb0'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length]!;
}

function avatarMarkup(
  player: CardPlayer,
  dataUri: string | null,
  cx: number,
  cy: number,
  radius: number,
  clipId: string,
): string {
  const ring = player.isWinner ? '#f5c518' : '#3a3f4b';
  const ringWidth = player.isWinner ? 10 : 6;

  const inner = dataUri
    ? `<image href="${dataUri}" x="${cx - radius}" y="${cy - radius}" width="${radius * 2}" height="${radius * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" />`
    : `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${accentFor(player.name)}" />
       <text x="${cx}" y="${cy + 26}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="72" font-weight="700" fill="#ffffff">${escapeXml(
         (player.name.trim()[0] ?? '?').toUpperCase(),
       )}</text>`;

  return `
    <clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${radius}" /></clipPath>
    ${inner}
    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${ring}" stroke-width="${ringWidth}" />
  `;
}

/**
 * The wordless mark at the centre of the card: two paddles and a ball.
 *
 * Drawn as vector rather than set as a 🏓 emoji. resvg renders text through
 * whatever fonts the image happens to carry, and an emoji font is both large
 * and inconsistently supported — the emoji renders as a tofu box on an image
 * without one, which is exactly what a card shared into a chat must never do.
 * Geometry has no such dependency.
 */
function pongMark(cx: number, cy: number): string {
  return `
    <circle cx="${cx}" cy="${cy}" r="52" fill="#12151c" />
    <rect x="${cx - 30}" y="${cy - 32}" width="60" height="9" rx="4.5" fill="#9aa1ad" />
    <rect x="${cx - 30}" y="${cy + 23}" width="60" height="9" rx="4.5" fill="#9aa1ad" />
    <circle cx="${cx + 9}" cy="${cy - 6}" r="8" fill="#f5c518" />
  `;
}

function buildSvg(input: CardInput, bottomAvatar: string | null, topAvatar: string | null): string {
  const { bottom, top } = input;

  // The winner's numeral is the loudest thing on the card; the loser's is
  // deliberately dimmer rather than smaller, so the pair still reads as a score.
  const topColour = top.isWinner ? '#ffffff' : '#6b7280';
  const bottomColour = bottom.isWinner ? '#ffffff' : '#6b7280';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#12151c" />
      <stop offset="100%" stop-color="#080a0f" />
    </linearGradient>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />

  <!-- Centre line, the one piece of Pong iconography that needs no words. -->
  <line x1="120" y1="540" x2="960" y2="540" stroke="#2a2f3a" stroke-width="6" stroke-dasharray="26 22" />

  ${avatarMarkup(top, topAvatar, 250, 300, 96, 'clipTop')}
  ${avatarMarkup(bottom, bottomAvatar, 250, 780, 96, 'clipBottom')}

  <text x="250" y="440" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="40" font-weight="600" fill="#9aa1ad">${escapeXml(
    truncate(top.name),
  )}</text>
  <text x="250" y="920" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="40" font-weight="600" fill="#9aa1ad">${escapeXml(
    truncate(bottom.name),
  )}</text>

  <text x="700" y="380" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="260" font-weight="800" fill="${topColour}">${top.score}</text>
  <text x="700" y="860" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="260" font-weight="800" fill="${bottomColour}">${bottom.score}</text>

  ${pongMark(700, 540)}
</svg>`;
}

/**
 * Render the card to a PNG buffer.
 *
 * Deliberately async and deliberately never called from a tick — the two
 * avatar fetches alone are network round trips.
 */
export async function renderResultCard(input: CardInput): Promise<Buffer> {
  const [bottomAvatar, topAvatar] = await Promise.all([
    fetchAvatar(input.bottom.photoUrl),
    fetchAvatar(input.top.photoUrl),
  ]);

  const svg = buildSvg(input, bottomAvatar, topAvatar);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    // System fonts only: bundling a font file would add megabytes to an image
    // that is otherwise small enough to deploy in seconds.
    font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
  });
  return Buffer.from(resvg.render().asPng());
}
