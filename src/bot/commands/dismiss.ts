import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { disconnect } from '../../audio/connection.js';
import { session } from '../../audio/session.js';
import type { Command } from '../command.js';

export const dismiss: Command = {
  data: new SlashCommandBuilder()
    .setName('dismiss')
    .setDescription('Dismiss the dragon from the voice channel.'),

  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({
        content: 'This command only works inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Destroy the session first so every ffmpeg process is killed before the
    // connection goes away — otherwise they linger with nowhere to write.
    session.destroy();

    const left = disconnect(interaction.guildId);
    await interaction.reply(left ? 'The dragon departs.' : "I'm not in a voice channel.");
  },
};
