/**
 * De-duplication and concurrency limiting for expensive resolutions.
 *
 * Resolving a track can take ten seconds or more — a Spotify lookup, a YouTube
 * search, then a download. Without a guard, every repeat request spawns another
 * yt-dlp: a user who clicks twice because nothing appeared to happen gets two
 * processes, and two downloads racing for the same output path.
 *
 * Observed in production as fifteen identical searches plus two concurrent
 * downloads of the same video, which saturated the CPU badly enough that Discord
 * interactions began timing out at their 3-second deadline.
 */

/** Roughly one core's worth of yt-dlp; beyond this the box stops being responsive. */
const MAX_CONCURRENT = 2;

const inFlight = new Map<string, Promise<unknown>>();

let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  waiting.shift()?.();
}

/**
 * Runs `task` under `key`, or joins the existing run if one is already going.
 *
 * Callers all receive the same result — including the same thrown error — so a
 * duplicate request behaves exactly as if it had done the work itself.
 */
export function dedupe<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const run = (async () => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
      // Cleared only after settling, so late joiners get the finished result
      // rather than starting a second run.
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}

/** Number of resolutions currently running or queued — surfaced by /storage status. */
export function inFlightCount(): number {
  return inFlight.size;
}
