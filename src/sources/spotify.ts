import { ResolveError } from './youtube.js';

/**
 * Spotify link resolution.
 *
 * Spotify audio cannot be downloaded — it is DRM-protected and only playable through
 * their own client with a Premium session. What a link *can* give us is metadata, so
 * a Spotify URL is resolved to "artist title" and that is searched on YouTube. The
 * track you hear is therefore a YouTube match, not the Spotify master, and may be a
 * different mix, a live take, or a cover.
 *
 * No API credentials are needed: the public oEmbed endpoint supplies the title and
 * the page's Open Graph tags supply the artist.
 */

const OEMBED = 'https://open.spotify.com/oembed?url=';
const EMBED = 'https://open.spotify.com/embed/track/';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Crawler user agent, deliberately.
 *
 * Spotify serves browsers a JavaScript shell with no metadata in the HTML, and
 * crawlers a pre-rendered page. A browser-shaped UA returns 156KB containing
 * nothing useful.
 */
const USER_AGENT = 'facebookexternalhit/1.1';

export interface SpotifyTrack {
  /** Spotify's track id, used as a cache alias so repeat links skip the search. */
  spotifyId: string;
  title: string;
  artist?: string;
  /** What to search YouTube for. */
  query: string;
}

export function isSpotifyUrl(input: string): boolean {
  return /^(?:https?:\/\/(?:open|play)\.spotify\.com\/|spotify:)/i.test(input.trim());
}

/**
 * Pulls the track id out of a Spotify link.
 *
 * Handles the `intl-xx` locale prefix and the `spotify:track:` URI form, and rejects
 * the link types we deliberately don't support.
 */
function extractTrackId(input: string): string {
  const value = input.trim();

  const unsupported = value.match(
    /(?:spotify[:.]com\/(?:intl-\w+\/)?|spotify:)(playlist|album|artist|episode|show)/i,
  );
  if (unsupported) {
    const kind = unsupported[1]!.toLowerCase();
    throw new ResolveError(
      `Spotify ${kind} links aren't supported — only individual tracks. ` +
        `Open the ${kind}, right-click a song, and copy its link instead.`,
    );
  }

  const match =
    value.match(/open\.spotify\.com\/(?:intl-\w+\/)?track\/([A-Za-z0-9]+)/i) ??
    value.match(/spotify:track:([A-Za-z0-9]+)/i);

  if (!match) {
    throw new ResolveError("That doesn't look like a Spotify track link.");
  }

  return match[1]!;
}

async function get(url: string, accept: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ResolveError(`Spotify returned ${response.status} for that link.`);
    }
    return await response.text();
  } catch (error) {
    if (error instanceof ResolveError) throw error;
    throw new ResolveError('Could not reach Spotify to look up that track.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Artists come from the embed page's inline JSON, which carries a proper
 * `"artists": [{ "name": ... }]` array.
 *
 * Preferred over the og:description tag because it is structured rather than a
 * "Artist · Album · Song · Year" string that has to be split on a separator, and
 * because the embed page is ~11KB against ~178KB for the full page.
 *
 * Still scraping, so treated as optional — if the shape changes we search on the
 * title alone, which works but matches less precisely.
 */
function parseArtists(html: string): string | undefined {
  const block = html.match(/"artists":\s*(\[[^\]]*\])/);
  if (!block) return undefined;

  const names = [...block[1]!.matchAll(/"name":\s*"([^"]+)"/g)].map((match) => match[1]!);
  if (names.length === 0) return undefined;

  // Two artists is plenty for a search query; more just adds noise.
  return names.slice(0, 2).join(' ');
}

export async function resolveSpotifyTrack(input: string): Promise<SpotifyTrack> {
  const spotifyId = extractTrackId(input);
  const canonical = `https://open.spotify.com/track/${spotifyId}`;

  const oembedRaw = await get(`${OEMBED}${encodeURIComponent(canonical)}`, 'application/json');

  let title: string;
  try {
    title = (JSON.parse(oembedRaw) as { title?: string }).title?.trim() ?? '';
  } catch {
    throw new ResolveError('Could not read that track from Spotify.');
  }

  if (!title) {
    throw new ResolveError('Spotify returned no title for that track.');
  }

  // Best-effort: a failure here costs match accuracy, not the whole lookup.
  const artist = await get(`${EMBED}${spotifyId}`, 'text/html')
    .then(parseArtists)
    .catch(() => undefined);

  return {
    spotifyId,
    title,
    artist,
    query: artist ? `${artist} ${title}` : title,
  };
}
