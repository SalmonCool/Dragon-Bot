import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../command.js';

export const ping: Command = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check that the dragon stirs.'),

  async execute(interaction) {
    const latency = Math.round(interaction.client.ws.ping);
    await interaction.reply({
      content: `The dragon stirs. \`${latency}ms\``,
      flags: MessageFlags.Ephemeral,
    });
  },
};
