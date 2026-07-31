import { session } from '../audio/session.js';

/**
 * The serialisable view of what the bot is doing.
 *
 * Deliberately a plain data structure with no references to mixers, layers or voice
 * connections — it crosses a network boundary, and keeping it dumb means the web
 * layer can never accidentally reach into audio internals.
 */
export interface Snapshot {
  /** Whether the bot is in a voice channel. Controls are useless if false. */
  connected: boolean;
  channel: string | null;
  music: {
    current: { title: string; name: string; loop: boolean } | null;
    queue: { title: string; name: string; loop: boolean }[];
  };
  ambience: { title: string } | null;
  sfx: { id: string; title: string }[];
  volumes: { music: number; ambience: number; sfx: number };
}

export function buildSnapshot(): Snapshot {
  const current = session.nowPlayingTrack;
  const ambience = session.ambienceLabel;
  const gains = session.allGains;

  return {
    connected: session.attached,
    channel: session.channel ?? null,
    music: {
      current: current
        ? { title: current.title, name: current.name, loop: current.loop }
        : null,
      queue: session.queued.map((track) => ({
        title: track.title,
        name: track.name,
        loop: track.loop,
      })),
    },
    ambience: ambience ? { title: ambience } : null,
    sfx: session.activeSfx.map((layer) => ({ id: layer.id, title: layer.label })),
    // Sent as 0-100 so the UI never has to know about gain units.
    volumes: {
      music: Math.round(gains.music * 100),
      ambience: Math.round(gains.ambience * 100),
      sfx: Math.round(gains.sfx * 100),
    },
  };
}
