import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { clearDownloads, formatBytes, purgeCategory, report } from '../../audio/storage.js';
import type { Category } from '../../audio/paths.js';
import type { Command } from '../command.js';

const CONFIRM_TIMEOUT_MS = 30_000;

export const storage: Command = {
  data: new SlashCommandBuilder()
    .setName('storage')
    .setDescription('Inspect and clean up the sound library.')
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show disk usage and free space.'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('clear')
        .setDescription('Delete downloaded files only. Hand-added files are kept.')
        .addStringOption((option) =>
          option
            .setName('folder')
            .setDescription('Which folder to clear')
            .setRequired(true)
            .addChoices(
              { name: 'tracks (music + ambience)', value: 'tracks' },
              { name: 'sfx', value: 'sfx' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('purge')
        .setDescription('Delete EVERYTHING in a folder, including files you added.')
        .addStringOption((option) =>
          option
            .setName('folder')
            .setDescription('Which folder to purge')
            .setRequired(true)
            .addChoices(
              { name: 'tracks (music + ambience)', value: 'tracks' },
              { name: 'sfx', value: 'sfx' },
            ),
        ),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'status') {
      const info = await report();
      const { usedBytes, capBytes } = info.cache;
      const percent = capBytes > 0 ? Math.round((usedBytes / capBytes) * 100) : 0;

      const lines = [
        `**Disk** — ${formatBytes(info.freeBytes)} free of ${formatBytes(info.totalBytes)}`,
        capBytes > 0
          ? `**Download cache** — ${formatBytes(usedBytes)} of ${formatBytes(capBytes)} (${percent}%)`
          : `**Download cache** — ${formatBytes(usedBytes)} (no limit set)`,
        '',
        ...info.categories.map(
          (entry) =>
            `\`${entry.category.padEnd(6)}\` ${formatBytes(entry.bytes)} — ` +
            `${entry.files} file(s), ${entry.downloaded} downloaded`,
        ),
      ];

      if (capBytes > 0 && percent >= 80) {
        lines.push(
          '',
          '*Nearing the cache limit — least-recently-played downloads will be ' +
            'evicted automatically. Hand-added sounds are never touched.*',
        );
      }

      await interaction.reply(lines.join('\n'));
      return;
    }

    const folder = interaction.options.getString('folder', true) as Category;

    if (sub === 'clear') {
      await interaction.deferReply();
      const result = await clearDownloads(folder);

      if (result.deleted === 0) {
        await interaction.editReply(`No downloaded files in \`${folder}\` to remove.`);
        return;
      }

      const failed = result.failed.length > 0 ? ` (${result.failed.length} failed)` : '';
      await interaction.editReply(
        `Removed ${result.deleted} downloaded file(s) from \`${folder}\`, ` +
          `freeing ${formatBytes(result.bytes)}.${failed}`,
      );
      return;
    }

    // purge — irreversible and includes hand-added files, so require confirmation.
    const confirmId = `purge-confirm-${interaction.id}`;
    const cancelId = `purge-cancel-${interaction.id}`;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(confirmId)
        .setLabel(`Delete everything in ${folder}`)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );

    const prompt = await interaction.reply({
      content:
        `This deletes **every** file in \`${folder}\`, including sounds you added ` +
        `by hand. This cannot be undone.\n\nUse \`/storage clear\` instead if you ` +
        `only want to remove downloads.`,
      components: [row],
      flags: MessageFlags.Ephemeral,
      withResponse: true,
    });

    try {
      const choice = await prompt.resource!.message!.awaitMessageComponent({
        componentType: ComponentType.Button,
        // Only the person who ran it may confirm.
        filter: (button) => button.user.id === interaction.user.id,
        time: CONFIRM_TIMEOUT_MS,
      });

      if (choice.customId === cancelId) {
        await choice.update({ content: 'Cancelled. Nothing was deleted.', components: [] });
        return;
      }

      await choice.update({ content: `Purging \`${folder}\`...`, components: [] });
      const result = await purgeCategory(folder);
      const failed = result.failed.length > 0 ? ` (${result.failed.length} failed)` : '';

      await interaction.editReply(
        `Purged \`${folder}\`: ${result.deleted} file(s) deleted, ` +
          `${formatBytes(result.bytes)} freed.${failed}`,
      );
    } catch {
      await interaction.editReply({
        content: 'Confirmation timed out. Nothing was deleted.',
        components: [],
      });
    }
  },
};
