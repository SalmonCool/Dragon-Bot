import { findSound } from '../audio/library.js';
import { touchByName, touchEntry } from '../audio/manifest.js';
import type { Category } from '../audio/paths.js';
import { isUrl, ResolveError, resolveUrl } from '../sources/youtube.js';

export interface WebSound {
  name: string;
  title: string;
  path: string;
}

/**
 * Library-name-or-URL resolution for the web API.
 *
 * Mirrors the Discord command helper, but without any interaction plumbing — the
 * web layer only needs the file, and reports failure with a thrown ResolveError
 * that the route turns into a 400.
 */
export async function resolveForWeb(category: Category, input: string): Promise<WebSound> {
  if (isUrl(input)) {
    const track = await resolveUrl(input, category);
    if (track.cached) await touchEntry(track.id);
    return { name: track.name, title: track.title, path: track.path };
  }

  const sound = await findSound(category, input);
  if (!sound) {
    throw new ResolveError(`No sound named "${input}" in ${category}/.`);
  }

  // Feeds the LRU signal used by cache eviction. No-op for hand-added sounds.
  await touchByName(sound.name);

  return { name: sound.name, title: sound.title, path: sound.path };
}
