import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { connectTo, getConnection } from '../../audio/connection.js';
import { findSound } from '../../audio/library.js';
import { touchByName, touchEntry } from '../../audio/manifest.js';
import type { Category } from '../../audio/paths.js';
import { session } from '../../audio/session.js';
import { isSpotifyUrl, resolveSpotifyTrack } from '../../sources/spotify.js';
import { isUrl, ResolveError, resolveSearch, resolveUrl } from '../../sources/youtube.js';

export interface PlayableSound {
  name: string;
  title: string;
  path: string;
  /** True when a URL was downloaded rather than served from the library. */
  fresh: boolean;
}

/**
 * Turns whatever the user typed into a playable file — a library name, or a URL
 * that gets downloaded into the category folder first.
 *
 * Downloads can take a while, so callers must have deferred the reply already.
 */
export async function resolveSound(
  category: Category,
  input: string,
): Promise<PlayableSound> {
  // Spotify audio is DRM-protected and cannot be downloaded, so the link is used
  // only to look up artist and title, and the match comes from YouTube.
  if (isSpotifyUrl(input)) {
    const track = await resolveSpotifyTrack(input);
    const found = await resolveSearch(track.query, category, track.spotifyId);
    if (found.cached) await touchEntry(found.id);
    return {
      name: found.name,
      title: found.title,
      path: found.path,
      fresh: !found.cached,
    };
  }

  if (isUrl(input)) {
    const track = await resolveUrl(input, category);
    if (track.cached) await touchEntry(track.id);
    return {
      name: track.name,
      title: track.title,
      path: track.path,
      fresh: !track.cached,
    };
  }

  const sound = await findSound(category, input);
  if (!sound) {
    throw new ResolveError(
      `No sound named \`${input}\` in \`${category}/\`, and that isn't a URL.`,
    );
  }

  // Feeds the LRU signal used by cache eviction. No-op for hand-added sounds.
  await touchByName(sound.name);

  return { name: sound.name, title: sound.title, path: sound.path, fresh: false };
}

/**
 * Ensures the bot is connected and the audio session is live, joining the caller's
 * channel if needed.
 *
 * Returns false if it could not — in which case the interaction has already been
 * replied to, and the caller should simply return.
 */
export async function requireSession(
  interaction: ChatInputCommandInteraction,
  /** Defer the reply — required when the caller will then do slow work (downloads). */
  defer = false,
): Promise<boolean> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: 'This command only works inside a server.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  let connection = getConnection(interaction.guildId);

  if (!connection) {
    const channel = interaction.member.voice.channel;
    if (!channel) {
      await interaction.reply({
        content: 'Join a voice channel first, or run `/summon`.',
        flags: MessageFlags.Ephemeral,
      });
      return false;
    }

    // Defer only after the cheap checks, so their errors stay ephemeral.
    if (defer) await interaction.deferReply();

    try {
      connection = await connectTo(channel);
    } catch (error) {
      console.error('Failed to join voice channel:', error);
      const message = `I could not reach **${channel.name}**. The voice connection timed out.`;
      if (defer) {
        await interaction.editReply(message);
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
      return false;
    }
  } else if (defer) {
    await interaction.deferReply();
  }

  session.attach(connection, interaction.member.voice.channel?.name);
  return true;
}
