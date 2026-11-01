export type ParsedInput =
  | { kind: 'youtube'; id: string; start?: number }
  | { kind: 'direct'; url: string }
  | null;

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

function parseT(t: string | null): number | undefined {
  if (!t) return undefined;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m) return undefined;
  return (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + +(m[3] ?? 0);
}

/**
 * Accepts any YouTube URL shape (watch, youtu.be, shorts, embed, live, music),
 * a bare 11-char video ID, or a direct .mp4 URL (handy for testing the player).
 */
export function parseVideoInput(raw: string): ParsedInput {
  const input = raw.trim();
  if (!input) return null;

  if (ID_RE.test(input) && looksLikeId(input)) return { kind: 'youtube', id: input };

  const hasScheme = /^https?:\/\//i.test(input);
  let url: URL;
  try {
    url = new URL(hasScheme ? input : `https://${input}`);
  } catch {
    return null;
  }
  // Without a scheme, require a dotted host so plain words stay searches.
  if (!hasScheme && !url.hostname.includes('.')) return null;
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  const start = parseT(url.searchParams.get('t') ?? url.searchParams.get('start'));

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1, 12);
    return ID_RE.test(id) ? { kind: 'youtube', id, start } : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v');
    if (v && ID_RE.test(v)) return { kind: 'youtube', id: v, start };
    const m = /^\/(?:shorts|embed|live|v|e)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
    if (m) return { kind: 'youtube', id: m[1], start };
    return null;
  }
  if (/^https?:/i.test(input) && /\.mp4($|\?)/i.test(url.pathname + url.search)) {
    return { kind: 'direct', url: url.toString() };
  }
  return null;
}

/** Avoid treating ordinary 11-letter search words as video IDs. */
function looksLikeId(s: string): boolean {
  return /[0-9_-]/.test(s) || /[A-Z]/.test(s.slice(1)) ;
}
