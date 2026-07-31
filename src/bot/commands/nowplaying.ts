import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { session } from '../../audio/session.js';
import type { Command } from '../command.js';

export const nowplaying: Command = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show every layer currently playing.'),

  async execute(interaction) {
    const layers = session.nowPlaying;

    if (layers.length === 0) {
      await interaction.reply({
        content: 'Nothing is playing.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines = layers.map(
      (layer) => `\`${layer.kind.padEnd(8)}\` **${layer.label}** — ${Math.round(layer.gain * 100)}%`,
    );

    await interaction.reply(lines.join('\n'));
  },
};
