import { SlashCommandBuilder } from 'discord.js';
import { suggestSounds } from '../../audio/library.js';
import { session } from '../../audio/session.js';
import { ResolveError } from '../../sources/youtube.js';
import { requireSession, resolveSound } from './shared.js';
import type { Command } from '../command.js';

export const sfx: Command = {
  data: new SlashCommandBuilder()
    .setName('sfx')
    .setDescription('Fire a one-shot sound effect over whatever is playing.')
    .addStringOption((option) =>
      option
        .setName('sound')
        .setDescription('Effect name or YouTube URL')
        .setRequired(true)
        .setAutocomplete(true),
    ),

  async autocomplete(interaction) {
    // Scoped to sfx/ so short one-shots don't crowd out long tracks, and vice versa.
    const sounds = await suggestSounds('sfx', interaction.options.getFocused());
    await interaction.respond(
      sounds.map((sound) => ({ name: sound.title.slice(0, 100), value: sound.name })),
    );
  },

  async execute(interaction) {
    const input = interaction.options.getString('sound', true);

    if (!(await requireSession(interaction, true))) return;

    try {
      const sound = await resolveSound('sfx', input);
      session.playSfx(sound.path, sound.title);

      const downloaded = sound.fresh ? ' *(downloaded)*' : '';
      await interaction.editReply(`*${sound.title}*${downloaded}`);
    } catch (error) {
      const message =
        error instanceof ResolveError
          ? error.message
          : 'Something went wrong resolving that sound.';
      if (!(error instanceof ResolveError)) console.error('SFX failed:', error);
      await interaction.editReply(message);
    }
  },
};
