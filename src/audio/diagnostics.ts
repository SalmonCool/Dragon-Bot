import { generateDependencyReport } from '@discordjs/voice';
import { cookieStatus, ytdlpVersion } from '../sources/youtube.js';

/**
 * The voice stack fails in confusing ways when a native dependency is missing —
 * usually as silence rather than an error. Checking once at startup turns that into
 * a message that names the actual problem.
 */
export async function checkAudioDependencies(): Promise<void> {
  checkVoiceStack();
  await checkYtDlp();
}

/**
 * yt-dlp is checked separately because it is optional: local sounds work fine
 * without it, only YouTube URLs need it.
 */
async function checkYtDlp(): Promise<void> {
  const version = await ytdlpVersion();

  if (version) {
    const cookies = await cookieStatus();

    if (!cookies.configured) {
      console.log(`yt-dlp ${version} available (no cookies configured).`);
    } else if (cookies.readable) {
      console.log(`yt-dlp ${version} available, using cookies.`);
    } else {
      // Configured but unreadable is worse than unconfigured: yt-dlp ignores it and
      // the failure resurfaces later as a confusing bot-detection error.
      console.warn(`yt-dlp ${version} available, but YTDLP_COOKIES points at a file`);
      console.warn(`  that cannot be read: ${cookies.path}`);
    }
    return;
  }

  console.warn('! yt-dlp not found — YouTube URLs will fail. Local sounds still work.');
  console.warn('  Windows: winget install yt-dlp');
  console.warn('  Or: pip install -U yt-dlp   /   set YTDLP_PATH in .env');
}

function checkVoiceStack(): void {
  const report = generateDependencyReport();

  const hasFfmpeg = !/FFmpeg\s*\n- not found/.test(report);
  const hasOpus = /- @discordjs\/opus: \d|- opusscript: \d/.test(report);
  const hasEncryption = /aes-256-gcm: yes/.test(report) || /- sodium.*: \d/.test(report);

  if (hasFfmpeg && hasOpus && hasEncryption) {
    console.log('Audio dependencies OK (opus, encryption, ffmpeg).');
    return;
  }

  console.warn('\n--- Audio dependency problem ---');
  if (!hasOpus) console.warn('! No Opus encoder. Run: npm install @discordjs/opus');
  if (!hasEncryption) console.warn('! No encryption support. Run: npm install libsodium-wrappers');
  if (!hasFfmpeg) {
    console.warn('! ffmpeg not found on PATH. Playback of mp3/wav/etc will fail.');
    console.warn('  Windows: winget install Gyan.FFmpeg   (then restart the terminal)');
    console.warn('  Debian/Ubuntu: sudo apt install ffmpeg');
  }
  console.warn('--------------------------------\n');
}
