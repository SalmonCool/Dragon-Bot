import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { webPublicUrl } from '../../config.js';
import type { Command } from '../command.js';

export const panel: Command = {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Get the link to the web control panel.'),

  async execute(interaction) {
    const url = webPublicUrl();

    if (!url) {
      // Ephemeral: this is an operator problem, not something the table needs to see.
      await interaction.reply({
        content:
          'No web panel is configured. Set `WEB_URL` in `.env` and restart the bot.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Web control panel')
      .setURL(url)
      .setDescription(
        `${url}\n\n` +
          'Shows what is playing on every layer, the music queue, volume sliders, ' +
          'and soundboards. Updates live — no refreshing.\n\n' +
          'You will need the shared password. Ask whoever runs the bot.',
      )
      .setColor(0xa03030);

    // Public on purpose: the point is telling the table where to find it.
    await interaction.reply({ embeds: [embed] });
  },
};
