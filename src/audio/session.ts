import {
  AudioPlayer,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
} from '@discordjs/voice';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Layer, type LayerKind } from './layer.js';
import { Mixer } from './mixer.js';

/**
 * Default gains, all below 1.0. Summing layers can overflow int16, and headroom is
 * what stops a sound effect over loud ambience from clipping.
 */
const DEFAULT_GAINS: Record<LayerKind, number> = {
  music: 0.7,
  ambience: 0.5,
  sfx: 0.8,
};

/** Ambience and music are single slots, so their layer ids are fixed. */
const AMBIENCE_ID = 'ambience';
const MUSIC_ID = 'music';

export interface Track {
  /** Library name, e.g. `tracks/tavern-brawl`. */
  name: string;
  title: string;
  path: string;
  loop: boolean;
}

/**
 * Owns the audio pipeline for the guild: one mixer, one player, one connection.
 * Single-guild by design (see PLAN.md), so this is a module-level singleton.
 *
 * Emits `change` after every mutation. That event is the seam the web UI hangs off:
 * the session has no idea a web server exists, and the web server never reaches into
 * the mixer. Both sides only know about state.
 */
export class AudioSession extends EventEmitter {
  private mixer = new Mixer();
  private readonly player: AudioPlayer;
  private connection: VoiceConnection | undefined;
  private channelName: string | undefined;
  private readonly gains: Record<LayerKind, number> = { ...DEFAULT_GAINS };

  /** Music is the only queued layer; ambience is a single replaceable slot. */
  private queue: Track[] = [];
  private current: Track | undefined;

  constructor() {
    super();

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.player.on('error', (error) => {
      console.error('Audio player error:', error);
    });

    this.watchMixer();
  }

  private changed(): void {
    this.emit('change');
  }

  /**
   * Advancing the queue is driven by the mixer's layerFinished event rather than
   * polling, so the next track starts the same frame the last one ends.
   */
  private watchMixer(): void {
    this.mixer.on('layerFinished', (layer: Layer) => {
      if (layer.kind === 'music') {
        this.current = undefined;
        this.startNext();
      }
      // Effects ending also changes what the UI should show.
      this.changed();
    });
  }

  attach(connection: VoiceConnection, channelName?: string): void {
    if (this.connection === connection) {
      if (channelName) this.channelName = channelName;
      return;
    }

    this.connection = connection;
    this.channelName = channelName;

    // A fresh mixer per attach: the previous one may have been consumed or ended.
    this.mixer.destroyAll();
    this.mixer.removeAllListeners('layerFinished');
    this.mixer = new Mixer();
    this.watchMixer();

    const resource = createAudioResource(this.mixer, {
      // Raw PCM — @discordjs/voice handles Opus encoding. Inline volume is off:
      // the mixer already applies per-layer gain.
      inputType: StreamType.Raw,
    });

    this.player.play(resource);
    connection.subscribe(this.player);
    this.changed();
  }

  get attached(): boolean {
    return this.connection !== undefined;
  }

  get channel(): string | undefined {
    return this.channelName;
  }

  // --- Ambience: single slot, always looping -------------------------------

  playAmbience(filePath: string, label: string): void {
    this.mixer.add(
      new Layer({
        id: AMBIENCE_ID,
        kind: 'ambience',
        label,
        filePath,
        loop: true,
        gain: this.gains.ambience,
      }),
    );
    this.changed();
  }

  stopAmbience(): boolean {
    const stopped = this.mixer.remove(AMBIENCE_ID);
    if (stopped) this.changed();
    return stopped;
  }

  get ambienceLabel(): string | undefined {
    return this.mixer.active.find((layer) => layer.kind === 'ambience')?.label;
  }

  // --- Music: queued, loop optional ----------------------------------------

  /**
   * Queues a track. Starts immediately when nothing is playing, otherwise waits its
   * turn. Returns the position, where 0 means it started now.
   */
  enqueue(track: Track): number {
    if (!this.current) {
      this.start(track);
      this.changed();
      return 0;
    }
    this.queue.push(track);
    this.changed();
    return this.queue.length;
  }

  private start(track: Track): void {
    this.current = track;
    this.mixer.add(
      new Layer({
        id: MUSIC_ID,
        kind: 'music',
        label: track.title,
        filePath: track.path,
        // A looping track never finishes, so the queue intentionally stalls on it
        // until skipped — that is what "loop this one" means.
        loop: track.loop,
        gain: this.gains.music,
      }),
    );
  }

  private startNext(): void {
    const next = this.queue.shift();
    if (next) this.start(next);
  }

  /** Ends the current track and moves on. Returns what was skipped. */
  skip(): Track | undefined {
    const skipped = this.current;
    if (!skipped) return undefined;

    this.mixer.remove(MUSIC_ID);
    this.current = undefined;
    this.startNext();
    this.changed();
    return skipped;
  }

  stopMusic(): boolean {
    const wasPlaying = this.current !== undefined || this.queue.length > 0;
    this.mixer.remove(MUSIC_ID);
    this.current = undefined;
    this.queue = [];
    if (wasPlaying) this.changed();
    return wasPlaying;
  }

  stopSfx(): number {
    const count = this.mixer.removeKind('sfx');
    if (count > 0) this.changed();
    return count;
  }

  get nowPlayingTrack(): Track | undefined {
    return this.current;
  }

  get queued(): readonly Track[] {
    return [...this.queue];
  }

  // --- SFX: many, fire and forget ------------------------------------------

  playSfx(filePath: string, label: string): void {
    this.mixer.add(
      new Layer({
        id: `sfx:${randomUUID()}`,
        kind: 'sfx',
        label,
        filePath,
        gain: this.gains.sfx,
      }),
    );
    this.changed();
  }

  get activeSfx(): { id: string; label: string }[] {
    return this.mixer.active
      .filter((layer) => layer.kind === 'sfx')
      .map((layer) => ({ id: layer.id, label: layer.label }));
  }

  // --- Levels ---------------------------------------------------------------

  /** `gain` is 0..1. Applies to current and future layers of that kind. */
  setGain(kind: LayerKind, gain: number): void {
    this.gains[kind] = gain;
    this.mixer.setKindGain(kind, gain);
    this.changed();
  }

  getGain(kind: LayerKind): number {
    return this.gains[kind];
  }

  get allGains(): Record<LayerKind, number> {
    return { ...this.gains };
  }

  /** Every active layer — also what `/nowplaying` renders. */
  get nowPlaying(): { kind: LayerKind; label: string; gain: number }[] {
    return this.mixer.active.map((layer) => ({
      kind: layer.kind,
      label: layer.label,
      gain: layer.gain,
    }));
  }

  /** Stops everything and releases every ffmpeg process. */
  destroy(): void {
    this.player.stop(true);
    this.mixer.destroyAll();
    this.queue = [];
    this.current = undefined;
    this.connection = undefined;
    this.channelName = undefined;
    this.changed();
  }
}

export const session = new AudioSession();
