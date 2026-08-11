import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
// Cyclic with index.ts by design: the registry owns the grouping, and help renders
// it. Safe because `commandGroups` is only read inside execute(), long after every
// module has finished evaluating.
import { commandGroups } from './index.js';
import type { Command } from '../command.js';

/** Discord's option type ids we care about when building a usage signature. */
const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;

interface RawOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  options?: RawOption[];
}

function signature(options: readonly RawOption[] | undefined): string {
  if (!options || options.length === 0) return '';
  return ` ${options
    .map((option) => (option.required ? `<${option.name}>` : `[${option.name}]`))
    .join(' ')}`;
}

/**
 * Renders one command as one or more lines — a command with subcommands is listed
 * per subcommand, since `/storage` on its own is not something you can run.
 */
function describe(command: Command): string[] {
  const json = command.data.toJSON() as {
    name: string;
    description: string;
    options?: RawOption[];
  };

  const subcommands = (json.options ?? []).filter(
    (option) => option.type === SUBCOMMAND || option.type === SUBCOMMAND_GROUP,
  );

  if (subcommands.length > 0) {
    return subcommands.map(
      (sub) =>
        `\`/${json.name} ${sub.name}${signature(sub.options)}\`\n  ${sub.description}`,
    );
  }

  return [
    `\`/${json.name}${signature(json.options)}\`\n  ${json.description}`,
  ];
}

export const help: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('List every command the dragon understands.'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('Dragon Bot')
      .setDescription(
        'Three audio layers play at once: a looping **ambience** bed, a **music** ' +
          'queue, and one-shot **sfx** over the top.\n\n' +
          '`/play`, `/ambience` and `/sfx` accept a library name, a **YouTube** URL, ' +
          'or a **Spotify track** link.\n\n' +
          '⚠️ **Spotify links are matched, not played.** Spotify audio cannot be ' +
          'downloaded, so the link is only used to look up the artist and title, ' +
          'which is then searched on YouTube. What you hear may be a different mix, ' +
          'a live version, or a cover — check `/nowplaying`. Obscure tracks may find ' +
          'no match at all, and playlist or album links are not supported.',
      )
      .setColor(0xa03030);

    for (const group of commandGroups) {
      const lines = group.commands.flatMap(describe);
      if (lines.length > 0) {
        embed.addFields({ name: group.name, value: lines.join('\n') });
      }
    }

    // Ephemeral: a reference sheet is for the person who asked, not the channel.
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
