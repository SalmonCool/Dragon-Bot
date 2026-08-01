import { statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { cacheLimitBytes, downloadedBytes } from './eviction.js';
import { categorySize, listSounds } from './library.js';
import { allEntries, entriesIn, removeEntries } from './manifest.js';
import { categoryDir, SOUNDS_DIR, type Category } from './paths.js';

/**
 * Disk accounting and cleanup.
 *
 * Two deletion modes, deliberately distinct: clearing removes only files the bot
 * downloaded (tracked in the manifest), while purging removes everything in a
 * category including files placed by hand. Routine maintenance should never be able
 * to destroy a curated library by accident.
 */

export interface StorageReport {
  freeBytes: number;
  totalBytes: number;
  categories: { category: Category; bytes: number; files: number; downloaded: number }[];
  /** Downloaded bytes against the eviction cap. `capBytes` of 0 means disabled. */
  cache: { usedBytes: number; capBytes: number };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export async function report(): Promise<StorageReport> {
  const stats = await statfs(SOUNDS_DIR);
  const entries = await allEntries();

  const categories = await Promise.all(
    (['tracks', 'sfx'] as const).map(async (category) => {
      const sounds = await listSounds(category);
      return {
        category,
        bytes: await categorySize(category),
        files: sounds.length,
        downloaded: entries.filter((entry) => entry.category === category).length,
      };
    }),
  );

  return {
    // bavail, not bfree: bfree includes blocks reserved for root that we can't use.
    freeBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize,
    categories,
    cache: { usedBytes: await downloadedBytes(), capBytes: cacheLimitBytes() },
  };
}

export interface DeletionResult {
  deleted: number;
  bytes: number;
  failed: string[];
}

/** Removes only bot-downloaded files in a category. Hand-added files survive. */
export async function clearDownloads(category: Category): Promise<DeletionResult> {
  const entries = await entriesIn(category);
  const result: DeletionResult = { deleted: 0, bytes: 0, failed: [] };
  const removedIds: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(categoryDir(category), path.basename(entry.file));
    try {
      await unlink(absolute);
      result.deleted += 1;
      result.bytes += entry.bytes;
      removedIds.push(entry.id);
    } catch (error) {
      // Already gone counts as success — the goal is that it isn't there.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        removedIds.push(entry.id);
        continue;
      }
      result.failed.push(entry.file);
    }
  }

  await removeEntries(removedIds);
  return result;
}

/**
 * Removes every audio file in a category, downloaded or not.
 *
 * This is the destructive one. Callers must confirm with the user first.
 */
export async function purgeCategory(category: Category): Promise<DeletionResult> {
  const sounds = await listSounds(category);
  const result: DeletionResult = { deleted: 0, bytes: 0, failed: [] };

  for (const sound of sounds) {
    try {
      await unlink(sound.path);
      result.deleted += 1;
      result.bytes += sound.bytes;
    } catch {
      result.failed.push(sound.name);
    }
  }

  const entries = await entriesIn(category);
  await removeEntries(entries.map((entry) => entry.id));

  return result;
}
