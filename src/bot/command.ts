import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandBuilder,
} from 'discord.js';

/**
 * Every slash command implements this. `data` is what gets uploaded to Discord by
 * the register script; `execute` runs when the command is invoked.
 *
 * The three builder types are distinct in discord.js: adding subcommands or options
 * narrows the builder, so all three must be accepted here.
 */
export interface Command {
  data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  /** Optional — only for commands with an autocompleting option. */
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}
