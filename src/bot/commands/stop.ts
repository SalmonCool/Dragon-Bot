import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { session } from '../../audio/session.js';
import type { Command } from '../command.js';

/**
 * Stops layers without leaving the channel.
 *
 * `/dismiss` also stops everything, but disconnects — which is the wrong tool when a
 * long sound effect was fired by mistake and the ambience should keep running.
 */
export const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop a layer without leaving the channel.')
    .addStringOption((option) =>
      option
        .setName('layer')
        .setDescription('Which layer to stop (default: all)')
        .addChoices(
          { name: 'all', value: 'all' },
          { name: 'music', value: 'music' },
          { name: 'ambience', value: 'ambience' },
          { name: 'sfx', value: 'sfx' },
        ),
    ),

  async execute(interaction) {
    const layer = interaction.options.getString('layer') ?? 'all';

    switch (layer) {
      case 'music': {
        const stopped = session.stopMusic();
        await interaction.reply(stopped ? 'Music stopped, queue cleared.' : 'No music playing.');
        return;
      }
      case 'ambience': {
        const stopped = session.stopAmbience();
        await interaction.reply(stopped ? 'The ambience fades.' : 'No ambience playing.');
        return;
      }
      case 'sfx': {
        const count = session.stopSfx();
        await interaction.reply(count > 0 ? `Silenced ${count} effect(s).` : 'No effects playing.');
        return;
      }
      default: {
        const music = session.stopMusic();
        const ambience = session.stopAmbience();
        const sfx = session.stopSfx();

        if (!music && !ambience && sfx === 0) {
          await interaction.reply({
            content: 'Nothing is playing.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.reply('All layers stopped. Still in the channel.');
      }
    }
  },
};
