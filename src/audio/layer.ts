import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { FRAME_BYTES, SAMPLE_RATE, CHANNELS } from './pcm.js';

/**
 * ffmpeg-static is CommonJS (`module.exports = <path string>`) but ships an
 * ESM-style .d.ts, so under NodeNext the default import is typed as the module
 * namespace. Node's interop hands us the string at runtime; the cast reconciles it.
 */
const ffmpegPath = ffmpegStatic as unknown as string | null;

export type LayerKind = 'music' | 'ambience' | 'sfx';

/**
 * How much decoded audio a layer buffers before it stops reading from ffmpeg.
 *
 * This matters more than it looks: ffmpeg decodes far faster than realtime, so
 * without backpressure a 10-minute ambience track would decode straight into memory
 * at 192 KB/sec — well over 100 MB. One second of buffer is plenty to absorb jitter.
 */
const MAX_BUFFER_BYTES = FRAME_BYTES * 50;
const RESUME_BELOW_BYTES = MAX_BUFFER_BYTES / 2;

export interface LayerOptions {
  id: string;
  kind: LayerKind;
  /** Shown in the queue / web UI. */
  label: string;
  filePath: string;
  /** Loop forever. Used by ambience beds. */
  loop?: boolean;
  gain?: number;
}

/**
 * One independently-decoded audio source, feeding raw PCM into the mixer.
 *
 * Each layer owns an ffmpeg child process. Looping is delegated to ffmpeg's
 * `-stream_loop` rather than restarting the process on end, which is what keeps an
 * ambience bed seamless — a respawn would leave an audible gap at every loop point.
 */
export class Layer {
  readonly id: string;
  readonly kind: LayerKind;
  readonly label: string;
  /** Kept so cache eviction can avoid deleting a file that is currently playing. */
  readonly filePath: string;
  gain: number;

  private readonly process: ChildProcessWithoutNullStreams;
  private readonly chunks: Buffer[] = [];
  private buffered = 0;
  private streamEnded = false;
  private destroyed = false;

  constructor(options: LayerOptions) {
    this.id = options.id;
    this.kind = options.kind;
    this.label = options.label;
    this.filePath = options.filePath;
    this.gain = options.gain ?? 1;

    if (!ffmpegPath) {
      throw new Error('ffmpeg-static did not resolve a binary path.');
    }

    this.process = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel', 'error',
        // -stream_loop must precede -i; it applies to the following input.
        ...(options.loop ? ['-stream_loop', '-1'] : []),
        '-i', options.filePath,
        '-f', 's16le',
        '-ar', String(SAMPLE_RATE),
        '-ac', String(CHANNELS),
        'pipe:1',
      ],
      { windowsHide: true },
    );

    this.process.stdout.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      if (this.buffered >= MAX_BUFFER_BYTES) {
        this.process.stdout.pause();
      }
    });

    this.process.stdout.on('end', () => {
      this.streamEnded = true;
    });

    this.process.stderr.on('data', (data: Buffer) => {
      console.error(`[ffmpeg:${this.label}] ${data.toString().trim()}`);
    });

    this.process.on('error', (error) => {
      console.error(`[ffmpeg:${this.label}] failed to spawn:`, error);
      this.streamEnded = true;
    });

    this.process.on('close', () => {
      this.streamEnded = true;
    });
  }

  /** True once the source is exhausted and every buffered byte has been consumed. */
  get finished(): boolean {
    return this.streamEnded && this.buffered === 0;
  }

  /**
   * Takes exactly `bytes` of PCM, or returns null if not enough is ready yet.
   *
   * Returning null on underrun (rather than a short read) is deliberate: the mixer
   * treats null as silence for this frame and leaves the buffer untouched, so audio
   * is delayed rather than discarded. A short read would permanently drop samples.
   */
  pull(bytes: number): Buffer | null {
    if (this.destroyed) return null;

    if (this.buffered < bytes) {
      if (!this.streamEnded) return null;
      if (this.buffered === 0) return null;

      // Final partial frame: pad with silence so the mixer still gets a full frame.
      const remainder = Buffer.alloc(bytes);
      Buffer.concat(this.chunks).copy(remainder);
      this.chunks.length = 0;
      this.buffered = 0;
      return remainder;
    }

    const frame = Buffer.allocUnsafe(bytes);
    let written = 0;

    while (written < bytes) {
      const chunk = this.chunks[0]!;
      const needed = bytes - written;

      if (chunk.length <= needed) {
        chunk.copy(frame, written);
        written += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(frame, written, 0, needed);
        this.chunks[0] = chunk.subarray(needed);
        written += needed;
      }
    }

    this.buffered -= bytes;

    if (this.buffered < RESUME_BELOW_BYTES && this.process.stdout.isPaused()) {
      this.process.stdout.resume();
    }

    return frame;
  }

  /**
   * Kills the ffmpeg process and releases buffers.
   *
   * Layers churn constantly (every sound effect is one), so leaking a process here
   * would slowly accumulate zombies on the host.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.chunks.length = 0;
    this.buffered = 0;
    this.process.stdout.removeAllListeners();
    this.process.stderr.removeAllListeners();
    if (!this.process.killed) {
      this.process.kill('SIGKILL');
    }
  }
}
