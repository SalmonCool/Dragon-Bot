import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Single shared password, for a handful of trusted people.
 *
 * The password is only ever compared on the server. Nothing derived from it reaches
 * the browser except an opaque signed cookie — anything the client could verify, a
 * visitor could read.
 */

const COOKIE_NAME = 'dragon_session';

/** How long a login lasts. A D&D session is long; a week avoids re-logins mid-game. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Brute-force protection: attempts per IP within the window. */
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

const attempts = new Map<string, { count: number; resetAt: number }>();

export interface AuthConfig {
  password: string;
  secret: string;
}

/**
 * Constant-time comparison. A naive `===` leaks the length of the matching prefix
 * through timing, which is exactly how a shared password gets guessed.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Still compare something so the timing doesn't reveal the length.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Cookie value is `<expiresAt>.<nonce>.<hmac>` — stateless, no server store. */
export function issueToken(secret: string): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const nonce = randomBytes(9).toString('base64url');
  const payload = `${expiresAt}.${nonce}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyToken(token: string | undefined, secret: string): boolean {
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [expiresAt, nonce, signature] = parts as [string, string, string];
  const payload = `${expiresAt}.${nonce}`;

  if (!safeEqual(signature, sign(payload, secret))) return false;

  const expiry = Number(expiresAt);
  return Number.isFinite(expiry) && expiry > Date.now();
}

export function checkPassword(supplied: string, config: AuthConfig): boolean {
  return safeEqual(supplied, config.password);
}

/** Returns false when the caller has made too many recent failed attempts. */
export function allowAttempt(ip: string): boolean {
  const now = Date.now();
  const record = attempts.get(ip);

  if (!record || now > record.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return true;
  }

  record.count += 1;
  return record.count <= MAX_ATTEMPTS;
}

export function clearAttempts(ip: string): void {
  attempts.delete(ip);
}

export function cookieHeader(token: string, secure: boolean): string {
  const flags = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    // Only set Secure behind HTTPS; on plain-HTTP LAN testing it would be dropped.
    ...(secure ? ['Secure'] : []),
  ];
  return flags.join('; ');
}

export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Minimal cookie parser — avoids a dependency for one header. */
export function readToken(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=');
  }
  return undefined;
}
