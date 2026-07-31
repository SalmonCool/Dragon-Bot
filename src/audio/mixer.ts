import { Readable } from 'node:stream';
import { Layer } from './layer.js';
import { FRAME_BYTES, mixInto } from './pcm.js';

/**
 * How many frames the mixer may buffer ahead. This is a latency control, not a
 * performance one: every buffered frame is a frame of already-decided audio, so a
 * large buffer means a sound effect fired now is heard several frames late.
 * Four frames = ~80ms, below the threshold where it feels unresponsive.
 */
const HIGH_WATER_MARK = FRAME_BYTES * 4;

/**
 * Sums all active layers into a single PCM stream.
 *
 * This exists because a bot may hold only one voice connection per guild — playing
 * a sound effect over an ambience bed is not two players, it is one stream that must
 * be mixed. Mixing here rather than in ffmpeg's `amix` filter is what allows layers
 * to be added and removed mid-playback: an `amix` graph fixes its inputs at start,
 * so every new effect would mean rebuilding the graph and cutting the ambience.
 *
 * The stream never ends. When nothing is playing it emits silence, so the voice
 * connection stays live and the next sound starts instantly.
 */
export class Mixer extends Readable {
  private readonly layers = new Map<string, Layer>();

  constructor() {
    super({ highWaterMark: HIGH_WATER_MARK });
  }

  add(layer: Layer): void {
    // Replacing a layer with the same id (e.g. swapping ambience) tears down the old
    // ffmpeg process rather than orphaning it.
    this.layers.get(layer.id)?.destroy();
    this.layers.set(layer.id, layer);
  }

  remove(id: string): boolean {
    const layer = this.layers.get(id);
    if (!layer) return false;
    layer.destroy();
    return this.layers.delete(id);
  }

  removeKind(kind: Layer['kind']): number {
    let removed = 0;
    for (const layer of this.layers.values()) {
      if (layer.kind === kind) {
        layer.destroy();
        this.layers.delete(layer.id);
        removed += 1;
      }
    }
    return removed;
  }

  get active(): readonly Layer[] {
    return [...this.layers.values()];
  }

  setKindGain(kind: Layer['kind'], gain: number): void {
    for (const layer of this.layers.values()) {
      if (layer.kind === kind) layer.gain = gain;
    }
  }

  override _read(): void {
    // Buffer.alloc zero-fills, so an empty frame is already silence.
    const frame = Buffer.alloc(FRAME_BYTES);

    for (const [id, layer] of this.layers) {
      if (layer.finished) {
        // One-shot effects clean themselves up as they end. The event is what lets
        // the music queue advance to the next track without polling.
        layer.destroy();
        this.layers.delete(id);
        this.emit('layerFinished', layer);
        continue;
      }

      const chunk = layer.pull(FRAME_BYTES);
      if (chunk) mixInto(frame, chunk, layer.gain);
    }

    this.push(frame);
  }

  /** Tears down every layer. Called when leaving the voice channel. */
  destroyAll(): void {
    for (const layer of this.layers.values()) layer.destroy();
    this.layers.clear();
  }
}
