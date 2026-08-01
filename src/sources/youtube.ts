import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { enforceCacheLimit } from '../audio/eviction.js';
import { addEntry, findById } from '../audio/manifest.js';
import { categoryDir, type Category } from '../audio/paths.js';

const run = promisify(execFile);

/**
 * YouTube resolution via yt-dlp.
 *
 * Everything is downloaded to disk rather than streamed. That is not just a cache:
 * YouTube's media URLs are signed and expire within hours, so a looping ambience bed
 * playing off a remote URL would die partway through a session. Playing from a local
 * file makes looping reliable, and has the side effect of making replays never touch
 * YouTube at all — which matters a great deal on a datacenter IP.
 */

/** Rejected above this. Long ambience beds are common, 10-hour videos are not welcome. */
export const MAX_DURATION_SECONDS = 3 * 60 * 60;

/** yt-dlp changes often; keep it updatable independently of this project. */
const YTDLP = process.env.YTDLP_PATH?.trim() || 'yt-dlp';

/**
 * Optional path to a Netscape-format cookies.txt exported from a logged-in browser.
 *
 * This is the standard remedy for "Sign in to confirm you're not a bot", which is
 * common on datacenter IPs — a VPS looks like automated traffic to YouTube in a way
 * a home connection does not. Cookies make the request look like a signed-in user.
 *
 * The file contains live session cookies, so it is effectively account credentials:
 * keep it out of version control and readable only by the bot's user.
 */
const COOKIES_PATH = process.env.YTDLP_COOKIES?.trim();

function cookieArgs(): string[] {
  return COOKIES_PATH ? ['--cookies', COOKIES_PATH] : [];
}

const MAX_BUFFER = 32 * 1024 * 1024;

export class ResolveError extends Error {}

export interface ResolvedTrack {
  id: string;
  title: string;
  durationSeconds: number;
  /** Absolute path to the downloaded file. */
  path: string;
  /** Relative, extensionless name usable with the sound library. */
  name: string;
  /** True when served from a previous download. */
  cached: boolean;
}

interface YtDlpMetadata {
  id: string;
  title: string;
  duration?: number;
  is_live?: boolean;
  live_status?: string;
  extractor?: string;
}

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Filesystem-safe, readable, and stable for a given title. */
function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'track'
  );
}

async function ytdlp(args: string[]): Promise<string> {
  try {
    const { stdout } = await run(YTDLP, args, { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const code = (error as { code?: string }).code;

    if (code === 'ENOENT') {
      throw new ResolveError(
        'yt-dlp is not installed or not on PATH. Install it (`winget install yt-dlp` ' +
          'or `pip install -U yt-dlp`), or set YTDLP_PATH in .env.',
      );
    }

    // Surface YouTube's own complaint rather than a generic failure — the
    // bot-detection message in particular is one you need to see verbatim.
    if (/Sign in to confirm|not a bot/i.test(stderr)) {
      throw new ResolveError(
        COOKIES_PATH
          ? 'YouTube is still blocking this request despite the cookies file. The ' +
            'cookies may have expired — export a fresh cookies.txt and try again.'
          : 'YouTube is blocking this request as automated traffic, which is common ' +
            'on datacenter IPs. Set YTDLP_COOKIES to a cookies.txt exported from a ' +
            'logged-in browser — see README.md.',
      );
    }
    if (/Video unavailable|Private video|removed/i.test(stderr)) {
      throw new ResolveError('That video is unavailable, private, or removed.');
    }

    throw new ResolveError(
      `yt-dlp failed: ${stderr.split('\n').find(Boolean) ?? 'unknown error'}`,
    );
  }
}

async function fetchMetadata(url: string): Promise<YtDlpMetadata> {
  const stdout = await ytdlp([
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--format', 'bestaudio/best',
    ...cookieArgs(),
    url,
  ]);

  try {
    return JSON.parse(stdout) as YtDlpMetadata;
  } catch {
    throw new ResolveError('Could not read video metadata from yt-dlp.');
  }
}

function assertPlayable(metadata: YtDlpMetadata): void {
  // Live streams never end, so they cannot be downloaded to a file at all.
  if (metadata.is_live || metadata.live_status === 'is_live') {
    throw new ResolveError(
      'That is a live stream. Live sources are not supported — find a recorded ' +
        'version, or use a local file.',
    );
  }

  if (!metadata.duration) {
    throw new ResolveError('That video has no reported duration and cannot be downloaded.');
  }

  if (metadata.duration > MAX_DURATION_SECONDS) {
    const hours = (metadata.duration / 3600).toFixed(1);
    throw new ResolveError(
      `That video is ${hours}h long — the limit is ${MAX_DURATION_SECONDS / 3600}h.`,
    );
  }
}

/**
 * Downloads a URL into the given category, or returns the existing file if it has
 * already been fetched.
 */
export async function resolveUrl(url: string, category: Category): Promise<ResolvedTrack> {
  const metadata = await fetchMetadata(url);
  assertPlayable(metadata);

  const existing = await findById(metadata.id);
  if (existing) {
    const absolute = path.join(categoryDir(category), path.basename(existing.file));
    const onDisk = await stat(absolute).catch(() => undefined);

    if (onDisk) {
      return {
        id: existing.id,
        title: existing.title,
        durationSeconds: existing.durationSeconds,
        path: absolute,
        name: existing.file.replace(/\.[^.]+$/, ''),
        cached: true,
      };
    }
    // Manifest says we have it but the file is gone — fall through and re-download.
  }

  const base = `${slugify(metadata.title)}-${metadata.id}`;
  const outputTemplate = path.join(categoryDir(category), `${base}.%(ext)s`);

  await ytdlp([
    '--no-playlist',
    '--no-warnings',
    '--format', 'bestaudio/best',
    // Keep the source encoding; ffmpeg decodes it at play time. Transcoding here
    // would cost CPU and quality for no benefit.
    '--output', outputTemplate,
    ...cookieArgs(),
    url,
  ]);

  // yt-dlp picks the extension, so find what actually landed.
  const directory = categoryDir(category);
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(directory);
  const produced = files.find((file) => file.startsWith(`${base}.`));

  if (!produced) {
    throw new ResolveError('Download finished but no file was produced.');
  }

  const absolute = path.join(directory, produced);
  const info = await stat(absolute);
  const relative = `${category}/${produced}`;

  await addEntry({
    id: metadata.id,
    title: metadata.title,
    file: relative,
    category,
    bytes: info.size,
    durationSeconds: metadata.duration ?? 0,
    addedAt: new Date().toISOString(),
    // Count the download itself as a use, so a brand-new track isn't the first
    // thing evicted by its own arrival.
    lastPlayedAt: new Date().toISOString(),
  });

  // Enforce the cap right after growth. Failure here must not fail the playback
  // the user actually asked for.
  await enforceCacheLimit().catch((error) => {
    console.error('Cache eviction failed:', error);
  });

  return {
    id: metadata.id,
    title: metadata.title,
    durationSeconds: metadata.duration ?? 0,
    path: absolute,
    name: relative.replace(/\.[^.]+$/, ''),
    cached: false,
  };
}

export type CookieStatus =
  | { configured: false }
  | { configured: true; path: string; readable: boolean };

/**
 * Reports cookie configuration for the startup diagnostic.
 *
 * A configured-but-missing file fails silently inside yt-dlp, surfacing much later
 * as a confusing bot-detection error — so it is worth catching at boot.
 */
export async function cookieStatus(): Promise<CookieStatus> {
  if (!COOKIES_PATH) return { configured: false };

  const { access } = await import('node:fs/promises');
  const readable = await access(COOKIES_PATH).then(
    () => true,
    () => false,
  );

  return { configured: true, path: COOKIES_PATH, readable };
}

/** Whether yt-dlp is reachable — used by the startup diagnostic. */
export async function ytdlpVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await run(YTDLP, ['--version'], { maxBuffer: 1024 * 64 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}
