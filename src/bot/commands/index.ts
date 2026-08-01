import type { Command } from '../command.js';
import { ambience } from './ambience.js';
import { dismiss } from './dismiss.js';
import { help } from './help.js';
import { nowplaying } from './nowplaying.js';
import { panel } from './panel.js';
import { ping } from './ping.js';
import { play } from './play.js';
import { queue } from './queue.js';
import { sfx } from './sfx.js';
import { skip } from './skip.js';
import { stop } from './stop.js';
import { storage } from './storage.js';
import { summon } from './summon.js';
import { volume } from './volume.js';

/**
 * The command registry, grouped for display.
 *
 * `commands` is derived from these groups rather than listed separately, so adding a
 * command to a group registers it with Discord *and* puts it in `/help`. There is no
 * second list to forget to update.
 */
export const commandGroups = [
  { name: 'Voice', commands: [summon, dismiss] },
  { name: 'Music', commands: [play, queue, skip, stop] },
  { name: 'Layers', commands: [ambience, sfx, volume, nowplaying] },
  { name: 'Library', commands: [storage] },
  { name: 'Utility', commands: [help, panel, ping] },
] as const satisfies readonly { name: string; commands: readonly Command[] }[];

export const commands: readonly Command[] = commandGroups.flatMap(
  (group) => group.commands,
);

export const commandsByName = new Map<string, Command>(
  commands.map((command) => [command.data.name, command]),
);
