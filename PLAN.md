# Dragon Bot — Project Plan

A D&D-themed Discord bot for playing music and sound effects from YouTube links,
with an optional web UI for viewing and controlling the queue.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Runtime | Node 22 + TypeScript | Node 22.14 already installed; shares a language with the web UI |
| Discord lib | discord.js v14 + `@discordjs/voice` | Raw voice control — required for custom audio layering |
| Audio model | Layered mixer (ambience bed + one-shot SFX) | The signature D&D feature |
| Source resolution | `yt-dlp` subprocess | Handles YouTube's churn better than any JS library |
| Web UI | Express + WebSocket, control-capable | Read + control, publicly reachable |
| Hosting | VPS | Always-on, independent of any local machine |
| Web UI exposure | Public HTTPS on a domain, Caddy for TLS | A few friends need access without installing anything |
| Auth | Single shared password → signed session cookie | Verified server-side on the VPS |

## Why the audio design is the crux

A Discord bot may hold **exactly one voice connection per guild**. Playing a tavern
ambience loop *while* dropping a sword-clash effect over it is therefore not two
players — it is one output stream that we must mix ourselves.

The obvious approach, a single ffmpeg `amix` filter graph, is wrong here: `amix`
requires its inputs be fixed when the graph starts, so every new sound effect would
mean tearing down and rebuilding the whole graph — audible gaps in the ambience.

**Instead, mix in Node:**

```
YouTube URL ─ yt-dlp ─┐
                      ├─ ffmpeg ─→ PCM s16le 48kHz stereo ─┐
local SFX file ───────┘                                    │
                                                           ├─→ Mixer ─→ AudioResource
YouTube URL ─ yt-dlp ─→ ffmpeg ─→ PCM s16le 48kHz stereo ──┘  (sum +    (StreamType.Raw)
                                                               per-layer      │
                                                               gain)          ↓
                                                                        Opus encode
                                                                              ↓
                                                                     Voice connection
```

Each layer is its own ffmpeg process decoding to raw PCM. A `Mixer` Transform stream
sums the layers sample-by-sample with an independent gain per layer, emitting silence
when idle so the stream never ends. `@discordjs/voice` accepts this via
`StreamType.Raw` and handles Opus encoding.

This buys us: add/remove layers with zero interruption, independent runtime volume
per layer, and ducking (auto-lower ambience when an effect fires) as a trivial
gain change.

**Layer model:**
- `MUSIC` — one slot, fed by a queue. Skippable, ordered. Loop is opt-in per track;
  a looping track never ends, so the queue intentionally stalls until skipped.
- `AMBIENCE` — one slot, loops forever until stopped. No queue.
- `SFX` — many slots, fire-and-forget, auto-removed on end.

All three play simultaneously.

## Storage model

The sound library *is* the download cache — there is no separate opaque cache dir.

```
sounds/
├─ tracks/   long-form: ambience + music, shared autocomplete
├─ sfx/      short-form one-shots, separate autocomplete
└─ .manifest.json
```

Two folders rather than three because ambience and music are the same kind of file
and are often interchangeable; sfx is separated only to stop short effects crowding
long tracks out of Discord's 25-suggestion autocomplete limit.

`.manifest.json` records what the **bot downloaded** (id, title, file, bytes,
duration, timestamps). Files placed by hand are absent from it. That distinction is
load-bearing: `/storage clear` deletes only manifest-tracked files, so routine
maintenance can never destroy a curated library. `/storage purge` deletes everything
and requires an explicit button confirmation.

**YouTube guards:** 3-hour duration cap; live streams rejected (they cannot be
downloaded to a file, and looping is meaningless for them).

## Architecture

```
dragon-bot/
├─ src/
│  ├─ bot/          discord.js client, slash command handlers
│  ├─ audio/        Mixer, layers, ffmpeg process management, voice connection
│  ├─ sources/      Resolver interface + yt-dlp impl + on-disk cache
│  ├─ state/        Queue/session state — the single source of truth
│  ├─ web/          Express + WebSocket server, static frontend
│  └─ scripts/
│     └─ register-commands.ts   Run manually, NOT on startup
├─ sounds/          D&D SFX and ambience (starts empty)
└─ cache/           Cached extracted audio (gitignored)
```

`state/` is the seam that makes the web UI cheap: the bot mutates session state, state
emits change events, and both the Discord side and the WebSocket server are just
subscribers. Neither knows about the other.

## Command surface (D&D themed)

| Command | Layer | Notes |
|---|---|---|
| `/play <url\|search>` | MUSIC | Queue a track |
| `/queue` | — | Show queue (also the web UI's view) |
| `/skip`, `/pause`, `/resume`, `/stop` | MUSIC | Standard transport |
| `/ambience <name\|url>` | AMBIENCE | Looping bed — tavern, rain, dungeon, combat |
| `/sfx <name>` | SFX | One-shot over the top |
| `/volume <layer> <0-100>` | any | Per-layer gain |
| `/summon` / `/dismiss` | — | Join / leave voice channel |
| `/scene <name>` | AMBIENCE+ | Preset: ambience + volumes in one command |

`/scene` is the feature worth building for an actual table — one command to go from
"tavern" to "ambush".

Slash commands only, so the privileged **Message Content intent is not needed**.
Required intents: `Guilds`, `GuildVoiceStates`. Required permissions: `Connect`, `Speak`.

## Build phases

**Phase 0 — Foundations**
Scaffold TS project, `.env` handling, Discord application + bot token, invite URL,
`register-commands` script. Install ffmpeg and yt-dlp on the host.
*Done when:* bot appears online and `/ping` responds.

**Phase 1 — Voice + single stream**
`/summon`, `/dismiss`, and `/play` with one hardcoded local file. Verify
`generateDependencyReport()` shows encryption + Opus + ffmpeg all present.
*Done when:* audio is audible in a voice channel.

**Phase 2 — The Mixer**
Build the PCM mixing Transform, layer registry, per-layer gain. Prove it with
ambience + SFX simultaneously from local files only — no YouTube yet.
*Done when:* an effect plays over an unbroken ambient loop.

**Phase 3 — YouTube resolution**
`Resolver` interface, yt-dlp implementation, on-disk cache keyed by video ID,
cookie-file support, graceful user-facing errors on extraction failure.
*Done when:* `/play <youtube url>` works and a replay is served from cache.

**Phase 4 — Queue + full command surface**
Real queue semantics, skip/pause/resume, `/scene` presets, persistence across restart.

**Phase 5 — Web UI**
Express + WebSocket on the VPS, shared-password auth, live queue view, transport and
per-layer volume controls. Frontend is a static bundle — see "Web UI hosting" below.

**Phase 6 — Deploy**
VPS provisioning, domain + Caddy TLS, systemd unit, log rotation, cache eviction policy.

## Web UI hosting

The queue lives in the bot process on the VPS: in-memory, tied to a live voice
connection. It cannot move to a serverless function. So the frontend is static and all
live data comes from the VPS directly.

**Do not route the WebSocket through Vercel.** Vercel's native WebSocket support
(public beta, June 2026) inherits the function duration limit, pins connections to one
instance, and has no cross-instance broadcast. A D&D session outlives that by hours.

```
Browser ──── static assets ────→ VPS (Caddy → Express static)   [Option A]
        └─── WSS live queue ───→ VPS (Express + ws)
```

**Option A (chosen): VPS serves everything.** One origin, no CORS, one deploy target.

**Option B: Vercel serves the frontend**, browser still opens WSS directly to the VPS.
Buys CDN + git-push deploys; costs a second deploy target, CORS config, and
cross-origin cookie rules. The VPS still needs a public domain and TLS either way, so
Vercel removes no server here. Revisit only if deploy ergonomics start to hurt.

## Auth design

Single shared password, for a handful of trusted people.

1. Password is checked **server-side on the VPS**. It never ships in frontend JS —
   anything the browser can verify, a visitor can read.
2. On success the server sets a signed, `HttpOnly`, `Secure`, `SameSite=Lax` session
   cookie (HMAC or JWT).
3. The WebSocket upgrade validates that cookie before subscribing to state.
4. Login attempts are rate-limited per IP.
5. HTTPS is mandatory — a password over plain HTTP is a password in cleartext.
6. Password lives in `.env` on the VPS, hashed at rest, never committed.

## Known risks

**1. YouTube bot detection on a datacenter IP — the top risk.**
yt-dlp on a VPS hits "Sign in to confirm you're not a bot" far more than on a
residential connection, and per the yt-dlp issue tracker, YouTube patches
counter-measures within days-to-weeks of each fix. Mitigations, all in the plan above:
aggressive on-disk caching (a D&D table replays the same ambience constantly, so the
cache absorbs most traffic), a mountable cookie file, and a `Resolver` interface that
can be swapped or put behind a proxy without touching the audio pipeline.
Accepted, not solved — expect to maintain this.

**2. ffmpeg process leaks.** One process per layer, and layers churn. Needs explicit
lifecycle management and kill-on-error, or the VPS will slowly accumulate zombies.

**3. Web UI exposure.** The UI is deliberately public, so the shared password is the
only thing between a stranger and playback control in your Discord server. Worst case
is someone blasting audio at your table — annoying, not catastrophic — but it means the
password must be long, rate-limited, and rotatable without a redeploy (read from
`.env`, not baked into the bundle).

**4. `npm audit` reports 9 findings (8 high, 1 critical) that cannot be fixed.**
All trace to a single root: `@discordjs/node-pre-gyp` (via `@discordjs/opus`), which
pulls vulnerable `tar` and `rimraf`. That package runs only at **install time** to
fetch the prebuilt binary; at runtime the bot loads a compiled `.node` file and never
requires `tar`. `tar` has no fix available. Accepted deliberately — but it means
**don't gate CI on `npm audit`** without an exception. Swapping `@discordjs/opus` for
`opusscript` (pure JS) eliminates all nine at a CPU cost, if that trade ever looks
better.

**5. Cache disk growth.** Cheap VPS disks are small. Needs an LRU eviction policy with
a size cap from Phase 3 onward, not bolted on later.

## Resolved

- **Sounds:** start empty; `sounds/` is populated as you go.
- **Persistence:** none for now. Queue is in-memory and resets with the process.
  A database is a later addition — keep `state/` free of process-lifetime assumptions
  so it can be added without a rewrite.
- **Scope:** single guild. Commands are registered guild-scoped (instant propagation,
  unlike global commands which take up to an hour), and session state is a single
  object rather than a per-guild map.
- **Web UI:** Option A — the VPS serves the frontend, API, and WebSocket.
