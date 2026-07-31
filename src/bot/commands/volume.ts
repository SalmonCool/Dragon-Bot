import { SlashCommandBuilder } from 'discord.js';
import type { LayerKind } from '../../audio/layer.js';
import { session } from '../../audio/session.js';
import type { Command } from '../command.js';

export const volume: Command = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the volume of an audio layer.')
    .addStringOption((option) =>
      option
        .setName('layer')
        .setDescription('Which layer to adjust')
        .setRequired(true)
        .addChoices(
          { name: 'ambience', value: 'ambience' },
          { name: 'sfx', value: 'sfx' },
          { name: 'music', value: 'music' },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName('level')
        .setDescription('0–100')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(100),
    ),

  async execute(interaction) {
    const kind = interaction.options.getString('layer', true) as LayerKind;
    const level = interaction.options.getInteger('level', true);

    // 100 maps to 1.0. Gains above 1.0 would clip once layers are summed, which is
    // why the option is capped rather than open-ended.
    session.setGain(kind, level / 100);

    await interaction.reply(`**${kind}** volume set to ${level}%.`);
  },
};
