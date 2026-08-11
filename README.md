# Dragon Bot

A D&D-themed Discord bot for layered music, ambience and sound effects, with a web UI
for viewing and controlling the queue.

See [PLAN.md](PLAN.md) for the architecture and build phases. This README covers
getting Phase 0 running: **bot online, `/ping` responds.**

## Prerequisites

- **Node 22+** (already installed: v22.14.0)
- **ffmpeg** — not needed until Phase 1, but install it now:
  - Windows: `winget install Gyan.FFmpeg`
  - Debian/Ubuntu VPS: `sudo apt install ffmpeg`
- **yt-dlp** — not needed until Phase 3:
  - Windows: `winget install yt-dlp.yt-dlp`
  - Debian/Ubuntu VPS: `sudo apt install yt-dlp` (or the standalone binary, which
    updates far more often — YouTube changes break old versions quickly)

## 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**. Name it whatever you like.
2. Copy the **Application ID** from *General Information* → this is `DISCORD_CLIENT_ID`.
3. Open the **Bot** tab, click **Reset Token**, and copy it → this is `DISCORD_TOKEN`.
   The token is shown once. Treat it like a password; anyone with it controls the bot.
4. Leave all three **Privileged Gateway Intents** switched **off**. This bot uses
   slash commands, so it does not need Message Content, Server Members, or Presence.

## 2. Invite the bot to your server

Replace `YOUR_CLIENT_ID` and open the URL in a browser:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=3148800&scope=bot%20applications.commands
```

`permissions=3148800` grants View Channels, Send Messages, Connect and Speak — the
minimum for a music bot. `scope=bot applications.commands` is required for slash
commands to appear.

## 3. Get your server ID

In Discord: **User Settings → Advanced → Developer Mode** on, then right-click your
server icon → **Copy Server ID** → this is `DISCORD_GUILD_ID`.

## 4. Configure and run

```bash
npm install
```

Copy `.env.example` to `.env` and fill in the three values, then register the slash
commands with Discord. Run this once now, and again whenever a command's name,
description, or options change — but never automatically on startup, as that burns
the daily registration rate limit.

```bash
npm run register
```

Start the bot in watch mode:

```bash
npm run dev
```

You should see `Logged in as <name>#0000`. In your server, type `/ping` — the bot
replies privately with the gateway latency.

## Commands

Run `/help` in Discord for this list — it is generated from the command registry, so
it is always current.

| Command | What it does |
|---|---|
| `/help` | Lists every command, grouped |
| `/panel` | Posts the web control panel link (needs `WEB_URL`) |
| `/ping` | Health check — replies with gateway latency |
| `/summon` | Joins your current voice channel |
| `/dismiss` | Leaves, stopping all audio |
| `/play <track> [loop]` | Queue music. Plays once unless `loop` is set |
| `/queue` | Show the music queue |
| `/skip` | Skip the current track |
| `/stop [layer]` | Stop a layer (or all) **without** leaving the channel |
| `/ambience <sound>` | Looping ambient bed. Pass `stop` to clear it |
| `/sfx <sound>` | One-shot effect, layered over whatever is playing |
| `/volume <layer> <0-100>` | Per-layer volume (`ambience`, `sfx`, `music`) |
| `/nowplaying` | Lists every active layer and its volume |
| `/storage status` | Free disk space and per-folder usage |
| `/storage clear <folder>` | Delete **downloaded** files only — hand-added files kept |
| `/storage purge <folder>` | Delete **everything** in a folder. Requires confirmation |

`/play`, `/ambience`, and `/sfx` all accept either a library name or a YouTube URL.

## Sounds

```
sounds/
├─ tracks/   long-form: ambience beds and music (shared autocomplete)
└─ sfx/      short-form one-shots (separate autocomplete)
```

Subfolders are scanned recursively, so `sounds/tracks/forest/rain.mp3` is referred to
as `tracks/forest/rain`. Supported: mp3, ogg, opus, wav, flac, m4a, webm.

The two folders are kept separate so short effects don't crowd long tracks out of the
autocomplete list — Discord shows at most 25 suggestions. Ambience and music share
`tracks/` because the same long file is often useful as either.

All three layers play **simultaneously**. A bot may hold only one voice connection per
guild, so layers are mixed into a single stream rather than played by separate
players — see PLAN.md for why this isn't done with ffmpeg's `amix`.

## Deploying

See [DEPLOY.md](DEPLOY.md) for the full VPS setup — hardening, systemd, Caddy for
automatic TLS, and moving the sound library.

## Web UI

Opt-in: the server only starts when `WEB_PASSWORD` is set in `.env`. Without it the
bot runs normally and no port is opened.

```
WEB_PASSWORD=<a long shared password>
WEB_SECRET=<32+ random hex chars — signs session cookies>
WEB_PORT=8080
WEB_SECURE=false     # true only when served over HTTPS
```

Generate a secret with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then open `http://localhost:8080`. It shows live now-playing state for all three
layers, the music queue, volume sliders, and soundboards built from your library.

**How auth works.** The password is compared server-side with a constant-time
comparison; nothing derived from it reaches the browser. On success the server sets a
signed `HttpOnly` `SameSite=Lax` cookie, and the WebSocket upgrade is rejected outright
without it — an unauthenticated client never gets a live socket. Login attempts are
rate-limited per IP.

`WEB_SECURE=true` adds the `Secure` cookie flag. Set it only behind HTTPS; over plain
HTTP the browser drops a Secure cookie and you can never log in.

**The UI cannot summon the bot.** There is no "caller" whose voice channel it could
join, so `/summon` stays a Discord-side action. Controls return a clear error until the
bot is in a channel.

## YouTube

Requires `yt-dlp` on PATH (`winget install yt-dlp`, or `pip install -U yt-dlp`). Set
`YTDLP_PATH` in `.env` to point at a specific binary. It is deliberately *not* an npm
dependency: YouTube changes frequently and yt-dlp needs updating far more often than
this project does.

URLs are **downloaded to disk**, not streamed. YouTube's media URLs are signed and
expire within hours, so a looping ambience bed playing from a remote URL would die
mid-session. Playing from a local file makes looping reliable, and means replays never
touch YouTube again.

- Tracks longer than **3 hours** are rejected.
- **Live streams are rejected** — they can't be downloaded to a file.
- Downloads are recorded in `sounds/.manifest.json`, which is what lets
  `/storage clear` remove only bot-downloaded files and leave your own alone.

### Cache eviction

Downloads are capped by `CACHE_MAX_GB` (default 10, `0` disables). After each new
download, if the total exceeds the cap, least-recently-played downloads are deleted
until it fits.

Three rules make this safe to leave running:

- **Only downloads count and only downloads are deleted.** Sounds you added by hand
  are invisible to the cap — the bot manages its own footprint and nothing else.
- **Files currently playing are skipped**, even when they are the oldest. A looping
  ambience bed will not be deleted out from under a session.
- **A track's download counts as a use**, so a new arrival is never the first thing
  evicted by its own download.

Playing anything updates its last-used time, whether by name or by URL. `/storage
status` shows usage against the cap and warns past 80%.

## Spotify

`/play`, `/ambience`, and `/sfx` also accept Spotify **track** links, in any of these
forms:

```
https://open.spotify.com/track/0nD62ke95NJvAI8chsRjRg?si=...
https://open.spotify.com/intl-de/track/0nD62ke95NJvAI8chsRjRg
spotify:track:0nD62ke95NJvAI8chsRjRg
```

**The audio does not come from Spotify.** Spotify streams are DRM-protected and only
playable through their own client with a Premium session — nothing can download them.
A link is used purely to look up the artist and title, which is then searched on
YouTube and the top result downloaded. So what plays is a *match*, and may be a
different mix, a live take, or a cover. Check with `/nowplaying` if it matters.

Playlist, album, and podcast links are rejected with a message explaining why — only
individual tracks work.

No API credentials are needed. The title comes from Spotify's public oEmbed endpoint
and the artists from the embed page's inline JSON.

Resolved tracks record their Spotify id in the manifest, so pasting the same link
again is served straight from the library — no second search, and no chance of landing
on a different video than last time.

### Bot detection and cookies

`Sign in to confirm you're not a bot` means YouTube has flagged the request as
automated. It is uncommon from a home connection and common from a VPS, because
datacenter IP ranges are treated as suspect regardless of what you are actually doing.

The fix is a cookies file from a browser logged into YouTube:

1. Export cookies with a Netscape-format `cookies.txt` browser extension.
2. Copy it to the server, then restrict it: `chmod 600 cookies.txt`
3. Set `YTDLP_COOKIES=/path/to/cookies.txt` in `.env` and restart.

Startup reports which state you are in — no cookies, cookies in use, or configured but
unreadable. That last case is worth catching early: yt-dlp ignores a missing cookies
file silently, so it resurfaces much later as a confusing bot-detection error.

**The cookies file is live session credentials for your Google account.** It is
gitignored, and it should be readable only by the user running the bot. Prefer a
throwaway account over your main one.

Two things that reduce how often this matters at all:

- **Downloads happen once.** A track fetched today is served from disk forever, so a
  D&D table generates a handful of requests a week, not the sustained volume that
  actually burns an IP's reputation.
- **You can sideload.** Download on your home machine and copy the file into
  `sounds/tracks/`. The library is a plain directory scan, so it appears in
  autocomplete immediately — no YouTube contact from the server at all.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run with auto-reload on file changes |
| `npm run register` | Upload slash command definitions to Discord |
| `npm run typecheck` | Type-check without emitting |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build (used on the VPS) |

## Adding a command

1. Create `src/bot/commands/<name>.ts` exporting a `Command`.
2. Add it to the array in `src/bot/commands/index.ts`.
3. Run `npm run register`.

Both the runtime dispatcher and the register script read that one array, so they
cannot drift apart.

## Troubleshooting

**Commands don't appear in Discord.** Run `npm run register`. If it succeeds but they
still don't show, the bot was likely invited without the `applications.commands`
scope — re-invite it with the URL above.

**`Missing required environment variable`.** `.env` is missing or incomplete. Copy it
from `.env.example`.

**`Used disallowed intents`.** A privileged intent is requested in code but not
enabled in the portal. This bot needs none of them, so the fix is normally to remove
the intent rather than enable it.
