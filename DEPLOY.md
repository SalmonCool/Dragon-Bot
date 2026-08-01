# Deploying to a VPS (Ubuntu 24.04)

Written for a DigitalOcean droplet, but nothing here is provider-specific except the
firewall note at the end.

**What you need first:** a droplet with your SSH key added, and a domain name pointing
an A record at the droplet's IP. The domain is what lets Caddy get a TLS certificate
automatically — without it you'd be sending the web UI password over plain HTTP.

Throughout, replace `dragon.example.com` with your domain and `203.0.113.10` with your
droplet's IP.

---

## 1. Harden the server

DigitalOcean droplets start as `root`. Create an unprivileged user for the bot — a
compromised Discord bot should not be a compromised server.

```bash
ssh root@203.0.113.10
```

```bash
adduser --disabled-password --gecos "" deploy && usermod -aG sudo deploy
```

Copy your SSH key over so you can log in as the new user:

```bash
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy/
```

Now confirm `ssh deploy@203.0.113.10` works **in a second terminal** before continuing.
Locking down SSH while your only working login is untested is how people lock
themselves out.

Once confirmed, disable password logins:

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && sudo systemctl restart ssh
```

Firewall — SSH, HTTP, HTTPS only:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable
```

**Do not open 8080.** The app binds `127.0.0.1` and Caddy reverse-proxies to it. If
8080 were reachable publicly, visitors could bypass HTTPS entirely and the login
password would cross the network in cleartext.

Automatic security updates:

```bash
sudo apt update && sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades
```

---

## 2. Install dependencies

Node 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs git
```

yt-dlp, as the standalone Linux binary — self-contained, and updatable independently
of this project, which matters because YouTube changes frequently:

```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp
```

Caddy, for automatic TLS:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list && sudo apt update && sudo apt install -y caddy
```

**You do not need to install ffmpeg.** It ships with the project via `ffmpeg-static`,
so the same pinned binary runs here as on your dev machine.

---

## 3. Deploy the application

The app lives in `/opt`, not a home directory, so the systemd hardening below can lock
down `/home` entirely.

```bash
sudo mkdir -p /opt/dragon-bot && sudo chown deploy:deploy /opt/dragon-bot
```

```bash
git clone https://github.com/SalmonCool/Dragon-Bot.git /opt/dragon-bot && cd /opt/dragon-bot && npm ci && npm run build
```

`npm ci` installs devDependencies too — TypeScript is needed for `npm run build`. Don't
use `--omit=dev` unless you build elsewhere.

---

## 4. Configure

```bash
cp /opt/dragon-bot/.env.example /opt/dragon-bot/.env && nano /opt/dragon-bot/.env
```

Fill in:

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | Your bot token |
| `DISCORD_CLIENT_ID` | `1532582636483121192` |
| `DISCORD_GUILD_ID` | `1230311132133330996` |
| `WEB_PASSWORD` | A long shared password — **not** the local placeholder |
| `WEB_SECRET` | Fresh random value, see below |
| `WEB_HOST` | `127.0.0.1` |
| `WEB_SECURE` | **`true`** — you're behind HTTPS now |
| `YTDLP_COOKIES` | Optional, see step 8 |
| `CACHE_MAX_GB` | `10` on a 25 GB droplet — see below |

Generate a fresh secret rather than reusing your local one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Lock the file down — it holds the bot token:

```bash
chmod 600 /opt/dragon-bot/.env
```

`WEB_SECURE=true` is not optional here. Without it the session cookie lacks the
`Secure` flag; with it set while on plain HTTP the browser drops the cookie and login
silently never works. It must match your actual transport.

---

## 5. Transfer the sound library

The audio is gitignored, so the clone gives you empty `tracks/` and `sfx/` folders.
Copy your library up **from your local machine** (not from the server):

```bash
scp -r sounds/tracks/* deploy@203.0.113.10:/opt/dragon-bot/sounds/tracks/
```

```bash
scp -r sounds/sfx/* deploy@203.0.113.10:/opt/dragon-bot/sounds/sfx/
```

Also copy the manifest, so `/storage clear` still knows which files were downloads and
which you added by hand:

```bash
scp sounds/.manifest.json deploy@203.0.113.10:/opt/dragon-bot/sounds/
```

Copying beats re-downloading on the server: it moves ~185 MB in a couple of minutes,
never contacts YouTube, and can't fail halfway through with a bot check.

---

## 6. Run it as a service

```bash
sudo nano /etc/systemd/system/dragon-bot.service
```

```ini
[Unit]
Description=Dragon Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/dragon-bot
ExecStart=/usr/bin/node dist/index.js
Environment=NODE_ENV=production

# Always come back. A voice bot that dies at 2am should not stay dead.
Restart=always
RestartSec=10

# Hardening: the process needs to write only to its own sounds/ directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/dragon-bot/sounds

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory` matters — the app resolves `sounds/` and `web/` relative to the
process working directory, so the service will not find them if this is wrong.

Register the slash commands once, then start:

```bash
cd /opt/dragon-bot && node dist/scripts/register-commands.js
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now dragon-bot && sudo systemctl status dragon-bot
```

Watch the logs:

```bash
journalctl -u dragon-bot -f
```

You want to see `Audio dependencies OK`, `yt-dlp ... available`, `Web UI listening on
127.0.0.1:8080`, and `Serving 1 guild(s)`.

---

## 6b. Check it works before setting up DNS

DigitalOcean gives you an IP, not a hostname, so there is no URL yet. You don't need
one to verify the deploy — the app binds loopback, so an SSH tunnel reaches it:

```bash
ssh -L 8080:127.0.0.1:8080 deploy@203.0.113.10
```

Leave that running, then open `http://localhost:8080` locally. The traffic goes over
the SSH connection, so nothing is exposed publicly. Keep `WEB_SECURE=false` for this,
since the browser end is plain HTTP.

Confirm the library loaded and the soundboards are populated, then continue.

## 7. Put Caddy in front

### Choosing a hostname

Caddy needs a hostname to obtain a certificate. Pick one:

| Option | URL | Notes |
|---|---|---|
| Your own domain | `dragon.yourdomain.com` | Best. Add an A record to the droplet IP |
| DuckDNS | `yourname.duckdns.org` | Free, ~2 minutes. Your IP is static, so no dynamic updating needed |
| sslip.io | `203-0-113-10.sslip.io` | No signup at all — the hostname *is* the IP |

Let's Encrypt now issues certificates for bare IPs, but they last only 160 hours and
need the `shortlived` ACME profile, which Caddy still has open issues around. Use a
hostname instead.

Whichever you pick, set `WEB_SECURE=true` in `.env` and restart the bot once HTTPS is
live.

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace the entire contents with:

```
dragon.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo systemctl reload caddy
```

That's the whole TLS setup. Caddy obtains and renews a Let's Encrypt certificate
automatically, and proxies WebSockets without extra configuration.

Your DNS A record must already point at the droplet before reloading — Caddy validates
the domain to get the certificate, and will retry noisily if it can't.

Visit `https://dragon.example.com` and log in.

---

## 8. Optional: YouTube cookies

If downloads fail with a bot-detection error — likely on a datacenter IP — export a
Netscape-format `cookies.txt` from a browser logged into YouTube, then:

```bash
scp cookies.txt deploy@203.0.113.10:/opt/dragon-bot/cookies.txt
```

```bash
chmod 600 /opt/dragon-bot/cookies.txt
```

Set `YTDLP_COOKIES=/opt/dragon-bot/cookies.txt` in `.env` and restart. Startup will
confirm with `yt-dlp ... available, using cookies.`

That file is live session credentials for a Google account. Use a throwaway account,
keep it `600`, and note it's already gitignored.

---

## Updating after a code change

```bash
cd /opt/dragon-bot && git pull && npm ci && npm run build && sudo systemctl restart dragon-bot
```

Only re-register commands when a command's name, description, or options changed:

```bash
cd /opt/dragon-bot && node dist/scripts/register-commands.js
```

Your sound library is untouched by deploys — it's state, not build output.

---

## Maintenance

Update yt-dlp periodically; YouTube breaks it regularly:

```bash
sudo yt-dlp -U
```

### Cache sizing

`CACHE_MAX_GB` caps downloaded audio. On a 25 GB droplet, budget roughly 8 GB for the
OS, `node_modules`, and headroom, which leaves `10` as a comfortable cap — about 100
long ambience tracks.

Only downloads count toward it and only downloads are evicted; anything you copied up
by hand in step 5 is exempt and will never be deleted. Files currently playing are
skipped. Set `0` to disable eviction if you would rather manage space yourself.

Check disk before a big session — long ambience tracks run ~100 MB each:

```bash
df -h / && du -sh /opt/dragon-bot/sounds
```

`/storage status` in Discord reports the same thing without SSH.

Cap the journal so logs can't fill the disk over months:

```bash
sudo journalctl --vacuum-size=200M
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `502 Bad Gateway` from Caddy | Bot isn't running — `journalctl -u dragon-bot -n 50` |
| Login page loads, password never works | `WEB_SECURE` doesn't match your transport |
| Web UI unreachable, no Caddy error | DNS A record not pointing at the droplet yet |
| `disallowed intents` at startup | A privileged intent got enabled in the Developer Portal; none are needed |
| Commands missing in Discord | `register-commands.js` not run since they changed |
| Bot online, no audio | Check `Connect` and `Speak` in that voice channel |
| Bot-detection errors on download | Add cookies (step 8), or sideload the file with `scp` |
| Service restarts in a loop | Almost always a bad `.env` — the log names the missing variable |
