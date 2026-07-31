import { REST, Routes } from 'discord.js';
import { config, requireGuildId } from '../config.js';
import { commands } from '../bot/commands/index.js';

/**
 * Uploads the slash command definitions to Discord.
 *
 * Run this MANUALLY (`npm run register`) whenever command definitions change —
 * never on bot startup. Registering on every boot burns the daily rate limit fast.
 *
 * Commands are registered guild-scoped, which propagates instantly. Global commands
 * can take up to an hour to appear.
 */
async function main(): Promise<void> {
  const guildId = requireGuildId();
  const rest = new REST().setToken(config.token);
  const body = commands.map((command) => command.data.toJSON());

  console.log(`Registering ${body.length} command(s) to guild ${guildId}...`);

  await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body });

  for (const command of commands) {
    console.log(`  /${command.data.name} — ${command.data.description}`);
  }
  console.log('Done. Commands are available immediately.');
}

main().catch((error: unknown) => {
  const status = (error as { status?: number }).status;

  // The common failures have unhelpful default messages, so translate them.
  if (status === 401) {
    console.error(
      'Failed to register commands: 401 Unauthorized.\n' +
        'DISCORD_TOKEN in .env is invalid or expired. Resetting the token in the\n' +
        'Developer Portal invalidates the previous one immediately — if you just\n' +
        'reset it, paste the new value into .env.',
    );
  } else if (status === 403) {
    console.error(
      'Failed to register commands: 403 Forbidden.\n' +
        'The bot is likely not in the guild, or was invited without the\n' +
        '`applications.commands` scope. Re-invite it using the URL in README.md.',
    );
  } else {
    console.error('Failed to register commands:', error);
  }
  process.exit(1);
});
