import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { allEntries, removeEntries, type ManifestEntry } from './manifest.js';
import { categoryDir } from './paths.js';
import { session } from './session.js';

/**
 * Least-recently-used eviction for downloaded audio.
 *
 * Scope is deliberately narrow: only files the bot downloaded (those in the manifest)
 * count toward the cap and are ever deleted. Sounds you placed by hand are yours —
 * the bot manages its own footprint and nothing else. That mirrors the
 * `/storage clear` policy, so there is one rule to remember rather than two.
 */

const BYTES_PER_GB = 1024 ** 3;

/** Default leaves room for the OS and node_modules on a 25 GB droplet. */
const DEFAULT_MAX_GB = 10;

/** Zero or negative disables eviction entirely. */
function configuredMaxBytes(): number {
  const raw = Number(process.env.CACHE_MAX_GB ?? DEFAULT_MAX_GB);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw * BYTES_PER_GB;
}

/** Log-friendly size. Fixed GB would render a 2 MB eviction as "0.00 GB". */
function describeBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

export interface EvictionResult {
  evicted: { title: string; bytes: number }[];
  freedBytes: number;
  /** Entries that were candidates but are currently playing. */
  skippedInUse: number;
  totalBytesBefore: number;
  totalBytesAfter: number;
  maxBytes: number;
}

function absolutePathFor(entry: ManifestEntry): string {
  return path.join(categoryDir(entry.category), path.basename(entry.file));
}

/**
 * Sorts oldest-first by last play, falling back to when it was added.
 *
 * A track downloaded but never played sorts by its download time, so a burst of
 * additions that never got used is evicted before a bed you use every session.
 */
function byLeastRecentlyUsed(a: ManifestEntry, b: ManifestEntry): number {
  const aTime = Date.parse(a.lastPlayedAt ?? a.addedAt);
  const bTime = Date.parse(b.lastPlayedAt ?? b.addedAt);
  return aTime - bTime;
}

/** Current on-disk total of downloaded files, in bytes. */
export async function downloadedBytes(): Promise<number> {
  const entries = await allEntries();
  let total = 0;

  for (const entry of entries) {
    // Trust the disk over the manifest: a file may have been replaced or removed
    // outside the bot.
    const info = await stat(absolutePathFor(entry)).catch(() => undefined);
    total += info?.size ?? 0;
  }

  return total;
}

export function cacheLimitBytes(): number {
  return configuredMaxBytes();
}

/**
 * Deletes least-recently-used downloads until the total is back under the cap.
 *
 * Safe to call often — it does nothing when already under the limit.
 */
export async function enforceCacheLimit(): Promise<EvictionResult> {
  const maxBytes = configuredMaxBytes();
  const entries = await allEntries();

  const sized = await Promise.all(
    entries.map(async (entry) => {
      const absolute = absolutePathFor(entry);
      const info = await stat(absolute).catch(() => undefined);
      return { entry, absolute, bytes: info?.size ?? 0, exists: info !== undefined };
    }),
  );

  const totalBytesBefore = sized.reduce((sum, item) => sum + item.bytes, 0);

  const result: EvictionResult = {
    evicted: [],
    freedBytes: 0,
    skippedInUse: 0,
    totalBytesBefore,
    totalBytesAfter: totalBytesBefore,
    maxBytes,
  };

  if (maxBytes <= 0 || totalBytesBefore <= maxBytes) return result;

  const inUse = session.activeFilePaths;
  const candidates = sized
    .filter((item) => item.exists)
    .sort((a, b) => byLeastRecentlyUsed(a.entry, b.entry));

  let remaining = totalBytesBefore;
  const removedIds: string[] = [];

  for (const candidate of candidates) {
    if (remaining <= maxBytes) break;

    if (inUse.has(candidate.absolute)) {
      result.skippedInUse += 1;
      continue;
    }

    try {
      await unlink(candidate.absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Eviction failed for ${candidate.entry.file}:`, error);
        continue;
      }
    }

    removedIds.push(candidate.entry.id);
    result.evicted.push({ title: candidate.entry.title, bytes: candidate.bytes });
    result.freedBytes += candidate.bytes;
    remaining -= candidate.bytes;
  }

  if (removedIds.length > 0) await removeEntries(removedIds);

  result.totalBytesAfter = remaining;

  if (result.evicted.length > 0) {
    console.log(
      `Cache eviction: removed ${result.evicted.length} download(s), ` +
        `freed ${describeBytes(result.freedBytes)}.`,
    );
  }

  // Worth surfacing: if everything over the cap is currently playing, the limit
  // cannot be honoured and the operator should know rather than silently overrun.
  if (remaining > maxBytes && result.skippedInUse > 0) {
    console.warn(
      `Cache is over its limit but ${result.skippedInUse} file(s) are in use and ` +
        `were skipped.`,
    );
  }

  return result;
}
