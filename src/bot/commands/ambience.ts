import { SlashCommandBuilder } from 'discord.js';
import { suggestSounds } from '../../audio/library.js';
import { session } from '../../audio/session.js';
import { ResolveError } from '../../sources/youtube.js';
import { requireSession, resolveSound } from './shared.js';
import type { Command } from '../command.js';

export const ambience: Command = {
  data: new SlashCommandBuilder()
    .setName('ambience')
    .setDescription('Set a looping ambient bed. Use "stop" to clear it.')
    .addStringOption((option) =>
      option
        .setName('sound')
        .setDescription('Track name, YouTube URL, or "stop"')
        .setRequired(true)
        .setAutocomplete(true),
    ),

  async autocomplete(interaction) {
    const query = interaction.options.getFocused();
    // Ambience and music share the tracks/ folder — the same long-form file is
    // often useful as either.
    const sounds = await suggestSounds('tracks', query);

    const options = [
      ...(!query || 'stop'.includes(query.toLowerCase())
        ? [{ name: 'stop — end the current ambience', value: 'stop' }]
        : []),
      ...sounds.map((sound) => ({ name: sound.title.slice(0, 100), value: sound.name })),
    ];

    await interaction.respond(options.slice(0, 25));
  },

  async execute(interaction) {
    const input = interaction.options.getString('sound', true);

    if (input.toLowerCase() === 'stop') {
      const stopped = session.stopAmbience();
      await interaction.reply(stopped ? 'The ambience fades.' : 'No ambience is playing.');
      return;
    }

    if (!(await requireSession(interaction, true))) return;

    try {
      const sound = await resolveSound('tracks', input);
      session.playAmbience(sound.path, sound.title);

      const downloaded = sound.fresh ? ' — downloaded' : '';
      await interaction.editReply(`Ambience: **${sound.title}** *(looping)*${downloaded}`);
    } catch (error) {
      const message =
        error instanceof ResolveError
          ? error.message
          : 'Something went wrong resolving that sound.';
      if (!(error instanceof ResolveError)) console.error('Ambience failed:', error);
      await interaction.editReply(message);
    }
  },
};
