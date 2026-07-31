import {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';

/** How long to wait for the websocket+UDP handshake before giving up. */
const READY_TIMEOUT_MS = 20_000;

/**
 * Joins a voice channel and waits until the connection is actually usable.
 *
 * `joinVoiceChannel` returns immediately, well before audio can flow — so callers
 * that don't await readiness end up "playing" into a dead connection and silently
 * hearing nothing. Waiting here makes that failure loud instead.
 */
export async function connectTo(channel: VoiceBasedChannel): Promise<VoiceConnection> {
  const existing = getVoiceConnection(channel.guild.id);
  if (existing && existing.joinConfig.channelId === channel.id) {
    return existing;
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    // The bot must be undeafened to *send* nothing of consequence, but staying
    // self-deafened avoids receiving (and paying to decode) everyone else's audio.
    selfDeaf: true,
    selfMute: false,
  });

  attachRecovery(connection);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  } catch (error) {
    connection.destroy();
    throw new Error(
      `Failed to establish a voice connection within ${READY_TIMEOUT_MS / 1000}s.`,
      { cause: error },
    );
  }

  return connection;
}

/**
 * Discord routinely moves voice servers, which surfaces as a Disconnected state that
 * is *not* fatal. The documented pattern is to give the connection a brief window to
 * resume on its own, and only tear it down if it genuinely can't.
 *
 * Without this the bot drops out of the channel mid-session for no visible reason.
 */
function attachRecovery(connection: VoiceConnection): void {
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Reconnecting on its own — leave it alone.
    } catch {
      // Genuinely gone (kicked, channel deleted, network dead).
      connection.destroy();
    }
  });

  connection.on('error', (error) => {
    console.error('Voice connection error:', error);
  });
}

export function getConnection(guildId: string): VoiceConnection | undefined {
  return getVoiceConnection(guildId);
}

/** Leaves the voice channel. Returns false if there was nothing to leave. */
export function disconnect(guildId: string): boolean {
  const connection = getVoiceConnection(guildId);
  if (!connection) return false;
  connection.destroy();
  return true;
}
