import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SOUNDS_DIR, type Category } from './paths.js';

/**
 * Record of everything the bot downloaded, as opposed to files you placed by hand.
 *
 * This distinction is the whole point: `/storage clear` removes only what is listed
 * here, so routine maintenance can never delete a hand-curated library. It also
 * carries the real YouTube title, so autocomplete shows "Tavern Ambience" rather
 * than the sanitised filename.
 */

const MANIFEST_PATH = path.join(SOUNDS_DIR, '.manifest.json');

export interface ManifestEntry {
  /** YouTube video id — the cache key. */
  id: string;
  title: string;
  /** Path relative to sounds/, forward-slashed. e.g. `tracks/tavern-dQw4w9.webm` */
  file: string;
  category: Category;
  bytes: number;
  durationSeconds: number;
  addedAt: string;
  lastPlayedAt?: string;
}

interface ManifestData {
  version: 1;
  entries: ManifestEntry[];
}

const EMPTY: ManifestData = { version: 1, entries: [] };

let cache: ManifestData | undefined;

/** Serialises writes so concurrent commands can't interleave read-modify-write. */
let writeChain: Promise<unknown> = Promise.resolve();

async function load(): Promise<ManifestData> {
  if (cache) return cache;

  try {
    const raw = await readFile(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ManifestData;
    cache = parsed.entries ? parsed : { ...EMPTY };
  } catch {
    // Missing or corrupt: start fresh rather than crashing the bot. The audio files
    // themselves are still on disk and still playable by name.
    cache = { ...EMPTY, entries: [] };
  }

  return cache;
}

function persist(): Promise<void> {
  writeChain = writeChain.then(async () => {
    if (!cache) return;
    await writeFile(MANIFEST_PATH, JSON.stringify(cache, null, 2), 'utf8');
  });
  return writeChain as Promise<void>;
}

export async function allEntries(): Promise<ManifestEntry[]> {
  return [...(await load()).entries];
}

export async function entriesIn(category: Category): Promise<ManifestEntry[]> {
  return (await load()).entries.filter((entry) => entry.category === category);
}

export async function findById(id: string): Promise<ManifestEntry | undefined> {
  return (await load()).entries.find((entry) => entry.id === id);
}

export async function addEntry(entry: ManifestEntry): Promise<void> {
  const data = await load();
  data.entries = data.entries.filter((existing) => existing.id !== entry.id);
  data.entries.push(entry);
  await persist();
}

export async function removeEntries(ids: readonly string[]): Promise<void> {
  const data = await load();
  const doomed = new Set(ids);
  data.entries = data.entries.filter((entry) => !doomed.has(entry.id));
  await persist();
}

/** Updates last-played time, used for LRU eviction decisions. */
export async function touchEntry(id: string): Promise<void> {
  const data = await load();
  const entry = data.entries.find((candidate) => candidate.id === id);
  if (!entry) return;
  entry.lastPlayedAt = new Date().toISOString();
  await persist();
}

/** Maps `tracks/foo-abc123` (extensionless name) to its manifest entry. */
export async function findByName(name: string): Promise<ManifestEntry | undefined> {
  const data = await load();
  return data.entries.find((entry) => entry.file.replace(/\.[^.]+$/, '') === name);
}

/**
 * Records a play for a library name, if that name is a tracked download.
 *
 * Most playback goes through autocomplete by name rather than by URL, so without
 * this the LRU signal would only ever be updated on the rare re-paste of a link —
 * and eviction would silently degrade into "oldest download first".
 */
export async function touchByName(name: string): Promise<void> {
  const entry = await findByName(name);
  if (entry) await touchEntry(entry.id);
}
