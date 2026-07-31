import { MessageFlags, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { connectTo } from '../../audio/connection.js';
import { session } from '../../audio/session.js';
import type { Command } from '../command.js';

export const summon: Command = {
  data: new SlashCommandBuilder()
    .setName('summon')
    .setDescription('Summon the dragon to your voice channel.'),

  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({
        content: 'This command only works inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = interaction.member.voice.channel;
    if (!channel) {
      await interaction.reply({
        content: 'Join a voice channel first, then summon me.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Checking up front turns an opaque connection timeout into a clear message.
    const permissions = channel.permissionsFor(interaction.client.user);
    const missing = [
      permissions?.has(PermissionsBitField.Flags.Connect) ? null : 'Connect',
      permissions?.has(PermissionsBitField.Flags.Speak) ? null : 'Speak',
    ].filter((name): name is string => name !== null);

    if (missing.length > 0) {
      await interaction.reply({
        content:
          `I lack the ${missing.join(' and ')} permission in **${channel.name}**. ` +
          `Grant it in that channel's settings, or re-invite me with the link in README.md.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // The handshake can outrun Discord's 3s interaction deadline, so defer first.
    await interaction.deferReply();

    try {
      const connection = await connectTo(channel);
      // Start the mixer immediately so the stream is live and the first sound
      // effect plays without waiting for the pipeline to spin up.
      session.attach(connection, channel.name);
      await interaction.editReply(`The dragon descends upon **${channel.name}**.`);
    } catch (error) {
      console.error('Failed to join voice channel:', error);
      await interaction.editReply(
        `I could not reach **${channel.name}**. The voice connection timed out.`,
      );
    }
  },
};
