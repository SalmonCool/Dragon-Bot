import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { session } from '../../audio/session.js';
import type { Command } from '../command.js';

const MAX_SHOWN = 15;

export const queue: Command = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the music queue.'),

  async execute(interaction) {
    const current = session.nowPlayingTrack;
    const upcoming = session.queued;

    if (!current && upcoming.length === 0) {
      await interaction.reply({
        content: 'The music queue is empty.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines: string[] = [];

    if (current) {
      lines.push(`**Now playing:** ${current.title}${current.loop ? ' *(looping)*' : ''}`);
    }

    if (upcoming.length > 0) {
      lines.push('', '**Up next:**');
      lines.push(
        ...upcoming
          .slice(0, MAX_SHOWN)
          .map((track, index) => `\`${index + 1}.\` ${track.title}${track.loop ? ' *(loop)*' : ''}`),
      );

      if (upcoming.length > MAX_SHOWN) {
        lines.push(`*...and ${upcoming.length - MAX_SHOWN} more*`);
      }
    }

    await interaction.reply(lines.join('\n'));
  },
};
