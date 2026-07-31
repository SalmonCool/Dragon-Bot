/**
 * Dragon Bot control panel.
 *
 * State is push-only: every change comes down the WebSocket as a full snapshot, and
 * the UI re-renders from it. Controls POST to the API and then say nothing — the
 * resulting snapshot is what updates the screen. That means two people with the page
 * open never disagree about what is playing.
 */

const $ = (id) => document.getElementById(id);

const loginView = $('login');
const appView = $('app');
const statusEl = $('status');
const toastEl = $('toast');

let socket = null;
let reconnectDelay = 1000;
let lastSnapshot = null;

// --- helpers --------------------------------------------------------------

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (response.status === 401) {
    showLogin();
    throw new Error('Not authenticated.');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

const post = (path, body) =>
  api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

let toastTimer;
function toast(message, bad = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('bad', bad);
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3500);
}

/** Wraps a control so a rejected request surfaces instead of failing silently. */
function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      toast(error.message, true);
    }
  };
}

// --- views ----------------------------------------------------------------

function showLogin() {
  loginView.classList.remove('hidden');
  appView.classList.add('hidden');
  if (socket) {
    socket.close();
    socket = null;
  }
}

function showApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
  connectSocket();
  void loadLibraries();
}

// --- websocket ------------------------------------------------------------

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
}

function connectSocket() {
  if (socket) return;

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}`);

  socket.addEventListener('open', () => {
    setStatus('live', 'live');
    reconnectDelay = 1000;
  });

  socket.addEventListener('message', (event) => {
    try {
      render(JSON.parse(event.data));
    } catch {
      /* ignore malformed frames */
    }
  });

  socket.addEventListener('close', () => {
    socket = null;
    setStatus('reconnecting…', 'down');
    // Back off so a server restart doesn't get hammered, capped so the page
    // recovers promptly once it returns.
    setTimeout(connectSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  });

  socket.addEventListener('error', () => socket?.close());
}

// --- rendering ------------------------------------------------------------

function render(snapshot) {
  lastSnapshot = snapshot;

  $('offline-banner').classList.toggle('hidden', snapshot.connected);
  if (snapshot.connected && snapshot.channel) {
    setStatus(`live · ${snapshot.channel}`, 'live');
  }

  // Music
  const current = snapshot.music.current;
  const musicEl = $('music-current');
  if (current) {
    musicEl.classList.remove('empty');
    musicEl.textContent = current.title;
    if (current.loop) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'loop';
      musicEl.append(badge);
    }
  } else {
    musicEl.classList.add('empty');
    musicEl.textContent = 'Nothing playing';
  }

  const queueEl = $('queue');
  queueEl.replaceChildren();
  $('queue-count').textContent = snapshot.music.queue.length
    ? `(${snapshot.music.queue.length})`
    : '';

  if (snapshot.music.queue.length === 0) {
    const note = document.createElement('li');
    note.className = 'empty-note';
    note.textContent = 'Empty';
    queueEl.append(note);
  } else {
    snapshot.music.queue.forEach((track, index) => {
      const item = document.createElement('li');
      const number = document.createElement('span');
      number.className = 'index';
      number.textContent = `${index + 1}.`;
      const title = document.createElement('span');
      title.textContent = track.title + (track.loop ? ' (loop)' : '');
      item.append(number, title);
      queueEl.append(item);
    });
  }

  // Ambience
  const ambienceEl = $('ambience-current');
  if (snapshot.ambience) {
    ambienceEl.classList.remove('empty');
    ambienceEl.textContent = snapshot.ambience.title;
  } else {
    ambienceEl.classList.add('empty');
    ambienceEl.textContent = 'No ambience';
  }

  // Effects
  $('sfx-active').textContent = snapshot.sfx.length
    ? `${snapshot.sfx.length} playing: ${snapshot.sfx.map((s) => s.title).join(', ')}`
    : '';

  // Levels — don't fight a slider the user is currently dragging.
  for (const layer of ['music', 'ambience', 'sfx']) {
    const slider = $(`vol-${layer}`);
    if (document.activeElement !== slider) {
      slider.value = snapshot.volumes[layer];
    }
    $(`vol-${layer}-value`).textContent = snapshot.volumes[layer];
  }
}

// --- library --------------------------------------------------------------

async function loadLibraries() {
  const [tracks, effects] = await Promise.all([
    api('/api/library?category=tracks'),
    api('/api/library?category=sfx'),
  ]);

  // Datalist powers autocomplete on both text inputs.
  const list = $('tracks-list');
  list.replaceChildren();
  for (const track of tracks) {
    const option = document.createElement('option');
    option.value = track.name;
    option.label = track.title;
    list.append(option);
  }

  buildBoard($('ambience-board'), tracks, (name) =>
    post('/api/ambience', { name }),
  );
  buildBoard($('sfx-board'), effects, (name) => post('/api/sfx', { name }));
}

function buildBoard(container, items, action) {
  container.replaceChildren();

  if (items.length === 0) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = 'Nothing here yet.';
    container.append(note);
    return;
  }

  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.title;
    button.title = item.title;
    button.addEventListener(
      'click',
      guard(async () => {
        await action(item.name);
      }),
    );
    container.append(button);
  }
}

// --- wiring ---------------------------------------------------------------

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = $('login-error');
  errorEl.textContent = '';

  try {
    await post('/api/login', { password: $('password').value });
    $('password').value = '';
    showApp();
  } catch (error) {
    errorEl.textContent = error.message;
  }
});

$('logout').addEventListener(
  'click',
  guard(async () => {
    await post('/api/logout');
    showLogin();
  }),
);

$('play').addEventListener(
  'click',
  guard(async () => {
    const input = $('play-input');
    const name = input.value.trim();
    if (!name) return;
    const result = await post('/api/play', { name, loop: $('play-loop').checked });
    input.value = '';
    toast(result.position === 0 ? 'Playing now.' : `Queued at ${result.position}.`);
  }),
);

$('ambience-set').addEventListener(
  'click',
  guard(async () => {
    const input = $('ambience-input');
    const name = input.value.trim();
    if (!name) return;
    await post('/api/ambience', { name });
    input.value = '';
  }),
);

$('ambience-stop').addEventListener('click', guard(() => post('/api/ambience', { stop: true })));
$('skip').addEventListener('click', guard(() => post('/api/skip')));
$('stop-music').addEventListener('click', guard(() => post('/api/stop', { layer: 'music' })));
$('stop-sfx').addEventListener('click', guard(() => post('/api/stop', { layer: 'sfx' })));
$('stop-all').addEventListener('click', guard(() => post('/api/stop', { layer: 'all' })));

for (const layer of ['music', 'ambience', 'sfx']) {
  const slider = $(`vol-${layer}`);

  slider.addEventListener('input', () => {
    $(`vol-${layer}-value`).textContent = slider.value;
  });

  // Commit on release rather than on every pixel of drag, so one gesture is one
  // request instead of a hundred.
  slider.addEventListener(
    'change',
    guard(() => post('/api/volume', { layer, level: Number(slider.value) })),
  );
}

// Enter submits the text inputs.
$('play-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('play').click();
});
$('ambience-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('ambience-set').click();
});

// --- boot -----------------------------------------------------------------

(async () => {
  try {
    const { authenticated } = await api('/api/session');
    if (authenticated) showApp();
    else showLogin();
  } catch {
    showLogin();
  }
})();
