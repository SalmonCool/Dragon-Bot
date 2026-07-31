import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { session } from '../../audio/session.js';
import type { Command } from '../command.js';

export const skip: Command = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current music track.'),

  async execute(interaction) {
    const skipped = session.skip();

    if (!skipped) {
      await interaction.reply({
        content: 'No music is playing.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const next = session.nowPlayingTrack;
    await interaction.reply(
      next
        ? `Skipped **${skipped.title}** — now playing **${next.title}**`
        : `Skipped **${skipped.title}**. Queue is empty.`,
    );
  },
};
