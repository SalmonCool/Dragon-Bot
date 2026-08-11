import { SlashCommandBuilder } from 'discord.js';
import { suggestSounds } from '../../audio/library.js';
import { session } from '../../audio/session.js';
import { ResolveError } from '../../sources/youtube.js';
import { requireSession, resolveSound } from './shared.js';
import type { Command } from '../command.js';

export const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Queue music from the library, a YouTube URL, or a Spotify track link.')
    .addStringOption((option) =>
      option
        .setName('track')
        .setDescription('Track name, YouTube URL, or Spotify track link')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addBooleanOption((option) =>
      option
        .setName('loop')
        .setDescription('Repeat this track until skipped (default: play once)'),
    ),

  async autocomplete(interaction) {
    const sounds = await suggestSounds('tracks', interaction.options.getFocused());
    await interaction.respond(
      sounds.map((sound) => ({ name: sound.title.slice(0, 100), value: sound.name })),
    );
  },

  async execute(interaction) {
    const input = interaction.options.getString('track', true);
    const loop = interaction.options.getBoolean('loop') ?? false;

    if (!(await requireSession(interaction, true))) return;

    try {
      const sound = await resolveSound('tracks', input);
      const position = session.enqueue({
        name: sound.name,
        title: sound.title,
        path: sound.path,
        loop,
      });

      const suffix = loop ? ' *(looping)*' : '';
      const downloaded = sound.fresh ? ' — downloaded' : '';

      await interaction.editReply(
        position === 0
          ? `Playing **${sound.title}**${suffix}${downloaded}`
          : `Queued **${sound.title}**${suffix} at position ${position}${downloaded}`,
      );
    } catch (error) {
      const message =
        error instanceof ResolveError
          ? error.message
          : 'Something went wrong resolving that track.';
      if (!(error instanceof ResolveError)) console.error('Play failed:', error);
      await interaction.editReply(message);
    }
  },
};
