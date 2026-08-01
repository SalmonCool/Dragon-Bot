import 'dotenv/config';

/**
 * Environment is validated at startup so a missing value fails immediately with a
 * readable message, rather than surfacing as an opaque Discord API error later.
 *
 * Validation is per-entry-point: the bot needs a token to log in, but only the
 * register script needs the guild ID. Requiring everything everywhere would block
 * the bot from starting over a value it never reads.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
        `Copy .env.example to .env and fill it in — see README.md.`,
    );
  }
  return value.trim();
}

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
} as const;

/**
 * Single-guild bot: commands are registered to this guild only, which propagates
 * instantly instead of the up-to-an-hour delay on global commands.
 *
 * Only the register script needs this, so it is resolved on demand.
 */
export function requireGuildId(): string {
  return required('DISCORD_GUILD_ID');
}

/**
 * Public URL of the web UI, for `/panel` to hand out.
 *
 * Cannot be derived at runtime: behind a reverse proxy the app only ever sees
 * `127.0.0.1:8080` and has no idea what hostname reached it.
 *
 * Read on each call rather than at module scope — see the note in sources/youtube.ts
 * about env being captured before dotenv has run.
 */
export function webPublicUrl(): string | undefined {
  const url = process.env.WEB_URL?.trim();
  if (!url) return undefined;
  // Trailing slashes make for ugly links when appended to.
  return url.replace(/\/+$/, '');
}

export interface WebSettings {
  port: number;
  host: string;
  password: string;
  secret: string;
  secure: boolean;
}

/**
 * The web UI is opt-in: without WEB_PASSWORD the server never starts.
 *
 * Failing closed matters here — a control surface for the bot should not appear on a
 * port just because someone deployed with a default config.
 */
export function webSettings(): WebSettings | undefined {
  const password = process.env.WEB_PASSWORD?.trim();
  if (!password) return undefined;

  const secret = process.env.WEB_SECRET?.trim();
  if (!secret || secret.length < 16) {
    throw new Error(
      'WEB_PASSWORD is set but WEB_SECRET is missing or too short (need 16+ chars).\n' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  return {
    port: Number(process.env.WEB_PORT ?? 8080),
    // Loopback by default. In production the app sits behind Caddy, and binding
    // 0.0.0.0 would expose the port directly on the public IP — reachable over
    // plain HTTP, bypassing TLS, with the password in cleartext. Override only
    // when you genuinely want LAN access (e.g. testing from a phone).
    host: process.env.WEB_HOST?.trim() || '127.0.0.1',
    password,
    secret,
    // Behind HTTPS (Caddy on the VPS) the cookie must be Secure; on plain-HTTP
    // local testing that flag would cause the browser to drop it entirely.
    secure: process.env.WEB_SECURE === 'true',
  };
}
