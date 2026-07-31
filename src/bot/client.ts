import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { checkAudioDependencies } from '../audio/diagnostics.js';
import { config } from '../config.js';
import { commandsByName } from './commands/index.js';

export function createClient(): Client {
  return new Client({
    intents: [
      // Base guild data — required for essentially everything.
      GatewayIntentBits.Guilds,
      // Needed to see who is in which voice channel, so /summon can find the caller.
      GatewayIntentBits.GuildVoiceStates,
    ],
    // Note: no MessageContent intent. It is privileged, and slash commands don't
    // need it. Avoid adding it unless a feature genuinely requires reading messages.
  });
}

export async function startBot(): Promise<Client> {
  await checkAudioDependencies();

  const client = createClient();

  client.once(Events.ClientReady, (ready) => {
    console.log(`Logged in as ${ready.user.tag}`);
    console.log(`Serving ${ready.guilds.cache.size} guild(s)`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      const command = commandsByName.get(interaction.commandName);
      try {
        await command?.autocomplete?.(interaction);
      } catch (error) {
        // Autocomplete has no user-visible error path — it just shows no results.
        console.error(`Autocomplete for /${interaction.commandName} failed:`, error);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = commandsByName.get(interaction.commandName);
    if (!command) {
      console.warn(`Received unknown command: ${interaction.commandName}`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`Command /${interaction.commandName} failed:`, error);

      // Discord requires a response within 3 seconds, so the command may already
      // have replied or deferred by the time it threw. Pick the right recovery.
      const message = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral } as const;
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(message);
        } else {
          await interaction.reply(message);
        }
      } catch {
        // The interaction token expired; nothing more we can do.
      }
    }
  });

  client.on(Events.Error, (error) => {
    console.error('Discord client error:', error);
  });

  await client.login(config.token);
  return client;
}
