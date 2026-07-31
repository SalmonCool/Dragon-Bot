import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { findByName } from './manifest.js';
import { categoryDir, SOUNDS_DIR, type Category } from './paths.js';

/**
 * Index of local sound files, scoped by category.
 *
 * Scans recursively so sounds can be organised into subfolders without the bot
 * caring. Names are the path relative to `sounds/`, minus extension:
 * `sounds/tracks/forest/rain.mp3` is referred to as `tracks/forest/rain`.
 */

const AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.opus', '.wav', '.flac', '.m4a', '.webm']);

export interface Sound {
  /** Relative, extensionless, forward-slashed. What the user types. */
  name: string;
  /** Human-readable label — the YouTube title for downloads, else the name. */
  title: string;
  path: string;
  category: Category;
  bytes: number;
}

async function walk(directory: string, category: Category, out: Sound[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await walk(absolute, category, out);
      continue;
    }

    if (!AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

    const name = path
      .relative(SOUNDS_DIR, absolute)
      .replace(/\\/g, '/')
      .replace(/\.[^.]+$/, '');

    const info = await stat(absolute).catch(() => undefined);
    const downloaded = await findByName(name);

    out.push({
      name,
      title: downloaded?.title ?? path.basename(name),
      path: absolute,
      category,
      bytes: info?.size ?? 0,
    });
  }
}

export async function listSounds(category: Category): Promise<Sound[]> {
  const sounds: Sound[] = [];
  await walk(categoryDir(category), category, sounds);
  return sounds.sort((a, b) => a.title.localeCompare(b.title));
}

export async function findSound(
  category: Category,
  name: string,
): Promise<Sound | undefined> {
  const sounds = await listSounds(category);
  const wanted = name.toLowerCase();

  return (
    sounds.find((sound) => sound.name.toLowerCase() === wanted) ??
    // Basename match, so `rain` finds `tracks/forest/rain`.
    sounds.find((sound) => sound.name.toLowerCase().endsWith(`/${wanted}`)) ??
    // Title match, so users can type what autocomplete showed them.
    sounds.find((sound) => sound.title.toLowerCase() === wanted)
  );
}

/** Discord allows at most 25 autocomplete suggestions. */
export async function suggestSounds(category: Category, query: string): Promise<Sound[]> {
  const sounds = await listSounds(category);
  if (!query) return sounds.slice(0, 25);

  const wanted = query.toLowerCase();
  return sounds
    .filter(
      (sound) =>
        sound.title.toLowerCase().includes(wanted) ||
        sound.name.toLowerCase().includes(wanted),
    )
    .slice(0, 25);
}

/** Total bytes on disk for a category. */
export async function categorySize(category: Category): Promise<number> {
  const sounds = await listSounds(category);
  return sounds.reduce((total, sound) => total + sound.bytes, 0);
}
