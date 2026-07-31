import path from 'node:path';

/**
 * Two categories, deliberately separate on disk.
 *
 * `tracks` holds long-form audio — both ambience beds and music, which share an
 * autocomplete list because the same file is often useful as either. `sfx` is kept
 * apart so short one-shots don't crowd out tracks in the picker (Discord shows at
 * most 25 suggestions).
 */
export type Category = 'tracks' | 'sfx';

export const CATEGORIES: readonly Category[] = ['tracks', 'sfx'];

export const SOUNDS_DIR = path.resolve(process.cwd(), 'sounds');

export function categoryDir(category: Category): string {
  return path.join(SOUNDS_DIR, category);
}
