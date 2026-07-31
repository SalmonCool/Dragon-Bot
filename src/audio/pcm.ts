/**
 * PCM format constants and mixing primitives.
 *
 * Discord voice expects 48kHz stereo signed 16-bit little-endian, in 20ms frames.
 * Every layer is decoded to exactly this format so frames can be summed directly
 * without resampling.
 */

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const BYTES_PER_SAMPLE = 2;
export const FRAME_MS = 20;

/** Samples per channel in one 20ms frame. */
export const FRAME_SAMPLES = (SAMPLE_RATE / 1000) * FRAME_MS; // 960

/** Total bytes in one 20ms stereo frame: 960 * 2 channels * 2 bytes. */
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * BYTES_PER_SAMPLE; // 3840

const INT16_MIN = -32_768;
const INT16_MAX = 32_767;

/**
 * Adds `source` into `target` in place, scaled by `gain`.
 *
 * Summing is the correct way to combine audio, but it can overflow: two loud layers
 * at full gain exceed int16 range. Clamping is what prevents that overflow from
 * wrapping around into loud crackling. Keep layer gains below 1.0 to leave headroom.
 */
export function mixInto(target: Buffer, source: Buffer, gain: number): void {
  const length = Math.min(target.length, source.length);

  for (let offset = 0; offset + 1 < length; offset += BYTES_PER_SAMPLE) {
    const sum = target.readInt16LE(offset) + source.readInt16LE(offset) * gain;
    const clamped = sum > INT16_MAX ? INT16_MAX : sum < INT16_MIN ? INT16_MIN : sum;
    target.writeInt16LE(clamped | 0, offset);
  }
}
