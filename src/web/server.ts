import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { listSounds } from '../audio/library.js';
import type { LayerKind } from '../audio/layer.js';
import { session } from '../audio/session.js';
import { buildSnapshot } from '../state/snapshot.js';
import { ResolveError } from '../sources/youtube.js';
import { resolveForWeb } from './playback.js';
import {
  allowAttempt,
  checkPassword,
  clearAttempts,
  clearCookieHeader,
  cookieHeader,
  issueToken,
  readToken,
  verifyToken,
  type AuthConfig,
} from './auth.js';

export interface WebConfig extends AuthConfig {
  port: number;
  /** Interface to bind. Loopback in production, since Caddy fronts it. */
  host: string;
  /** Set when served behind HTTPS, so the session cookie gets the Secure flag. */
  secure: boolean;
}

const STATIC_DIR = path.resolve(process.cwd(), 'web');

export function startWebServer(config: WebConfig): Server {
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  // Behind a reverse proxy (Caddy, Cloudflare Tunnel), req.ip must come from
  // X-Forwarded-For or every client shares the proxy's address and rate limiting
  // becomes useless.
  //
  // Trust exactly one hop, not `true`. Trusting all hops takes the leftmost XFF
  // entry, which the client controls — so an attacker could send a fresh fake IP on
  // every request and never hit the login rate limit at all. One hop uses the value
  // your own proxy appended.
  app.set('trust proxy', 1);

  const requireAuth = (request: Request, response: Response, next: NextFunction): void => {
    if (verifyToken(readToken(request), config.secret)) {
      next();
      return;
    }
    response.status(401).json({ error: 'Not authenticated.' });
  };

  // --- auth ---------------------------------------------------------------

  app.post('/api/login', (request, response) => {
    const ip = request.ip ?? 'unknown';

    if (!allowAttempt(ip)) {
      response.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }

    const supplied = String((request.body as { password?: unknown })?.password ?? '');

    if (!checkPassword(supplied, config)) {
      response.status(401).json({ error: 'Incorrect password.' });
      return;
    }

    clearAttempts(ip);
    response.setHeader('Set-Cookie', cookieHeader(issueToken(config.secret), config.secure));
    response.json({ ok: true });
  });

  app.post('/api/logout', (_request, response) => {
    response.setHeader('Set-Cookie', clearCookieHeader());
    response.json({ ok: true });
  });

  app.get('/api/session', (request, response) => {
    response.json({ authenticated: verifyToken(readToken(request), config.secret) });
  });

  // --- state --------------------------------------------------------------

  app.get('/api/state', requireAuth, (_request, response) => {
    response.json(buildSnapshot());
  });

  app.get('/api/library', requireAuth, async (request, response) => {
    const category = request.query.category === 'sfx' ? 'sfx' : 'tracks';
    const sounds = await listSounds(category);
    response.json(
      sounds.map((sound) => ({ name: sound.name, title: sound.title })),
    );
  });

  // --- controls -----------------------------------------------------------

  /**
   * Every control needs the bot to already be in a voice channel. The web UI has no
   * "caller" whose channel it could join, so summoning stays a Discord-side action.
   */
  const requireVoice = (response: Response): boolean => {
    if (session.attached) return true;
    response.status(409).json({ error: 'The bot is not in a voice channel. Use /summon.' });
    return false;
  };

  app.post('/api/play', requireAuth, async (request, response) => {
    if (!requireVoice(response)) return;

    const body = request.body as { name?: string; loop?: boolean };
    if (!body.name) {
      response.status(400).json({ error: 'Missing track name.' });
      return;
    }

    try {
      const sound = await resolveForWeb('tracks', body.name);
      const position = session.enqueue({
        name: sound.name,
        title: sound.title,
        path: sound.path,
        loop: Boolean(body.loop),
      });
      response.json({ ok: true, position });
    } catch (error) {
      response
        .status(error instanceof ResolveError ? 400 : 500)
        .json({ error: error instanceof ResolveError ? error.message : 'Playback failed.' });
    }
  });

  app.post('/api/ambience', requireAuth, async (request, response) => {
    if (!requireVoice(response)) return;

    const body = request.body as { name?: string; stop?: boolean };

    if (body.stop) {
      session.stopAmbience();
      response.json({ ok: true });
      return;
    }

    if (!body.name) {
      response.status(400).json({ error: 'Missing sound name.' });
      return;
    }

    try {
      const sound = await resolveForWeb('tracks', body.name);
      session.playAmbience(sound.path, sound.title);
      response.json({ ok: true });
    } catch (error) {
      response
        .status(error instanceof ResolveError ? 400 : 500)
        .json({ error: error instanceof ResolveError ? error.message : 'Playback failed.' });
    }
  });

  app.post('/api/sfx', requireAuth, async (request, response) => {
    if (!requireVoice(response)) return;

    const body = request.body as { name?: string };
    if (!body.name) {
      response.status(400).json({ error: 'Missing sound name.' });
      return;
    }

    try {
      const sound = await resolveForWeb('sfx', body.name);
      session.playSfx(sound.path, sound.title);
      response.json({ ok: true });
    } catch (error) {
      response
        .status(error instanceof ResolveError ? 400 : 500)
        .json({ error: error instanceof ResolveError ? error.message : 'Playback failed.' });
    }
  });

  app.post('/api/skip', requireAuth, (_request, response) => {
    const skipped = session.skip();
    response.json({ ok: true, skipped: skipped?.title ?? null });
  });

  app.post('/api/stop', requireAuth, (request, response) => {
    const layer = (request.body as { layer?: string }).layer ?? 'all';

    if (layer === 'music') session.stopMusic();
    else if (layer === 'ambience') session.stopAmbience();
    else if (layer === 'sfx') session.stopSfx();
    else {
      session.stopMusic();
      session.stopAmbience();
      session.stopSfx();
    }

    response.json({ ok: true });
  });

  app.post('/api/volume', requireAuth, (request, response) => {
    const body = request.body as { layer?: string; level?: number };
    const layer = body.layer as LayerKind | undefined;
    const level = Number(body.level);

    if (!layer || !['music', 'ambience', 'sfx'].includes(layer)) {
      response.status(400).json({ error: 'Unknown layer.' });
      return;
    }
    if (!Number.isFinite(level) || level < 0 || level > 100) {
      response.status(400).json({ error: 'Level must be 0-100.' });
      return;
    }

    session.setGain(layer, level / 100);
    response.json({ ok: true });
  });

  // --- static + websocket -------------------------------------------------

  app.use(express.static(STATIC_DIR));

  const server = createServer(app);

  // noServer so the upgrade can be rejected before the socket is accepted —
  // an unauthenticated client should never get a live WebSocket at all.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (!verifyToken(readToken(request), config.secret)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  const broadcast = (): void => {
    const payload = JSON.stringify(buildSnapshot());
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  };

  wss.on('connection', (ws: WebSocket) => {
    // Send current state immediately so the UI isn't blank until something changes.
    ws.send(JSON.stringify(buildSnapshot()));
  });

  session.on('change', broadcast);

  server.listen(config.port, config.host, () => {
    console.log(`Web UI listening on ${config.host}:${config.port}`);
  });

  return server;
}
