const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
app.use(express.json({ limit: '5mb' }));

const OUTPUT_DIR = path.join(__dirname, 'output');
const MUSIC_DIR = path.join(__dirname, 'music');
const FONTS_DIR = path.join(__dirname, 'fonts');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use('/output', express.static(OUTPUT_DIR));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const MAX_FILE_SIZE_MB = 16;
const TARGET_DURATION = 15;

// --- Font selection per language (file names must exist in /fonts) ---
// Falls back to a common system font, and finally to `null` (meaning:
// skip the text overlay entirely) so rendering never hard-fails just
// because the font files haven't been uploaded yet.
const SYSTEM_FONT_FALLBACKS = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
];

function fontForLanguage(language) {
  const lang = (language || '').toLowerCase();
  let preferred;
  if (lang.includes('hindi')) preferred = path.join(FONTS_DIR, 'NotoSansDevanagari-Regular.ttf');
  else if (lang.includes('gujarati')) preferred = path.join(FONTS_DIR, 'NotoSansGujarati-Regular.ttf');
  else preferred = path.join(FONTS_DIR, 'NotoSans-Regular.ttf');

  if (fs.existsSync(preferred)) return preferred;
  for (const fallback of SYSTEM_FONT_FALLBACKS) {
    if (fs.existsSync(fallback)) {
      console.warn(`Font not found at ${preferred}, using system fallback ${fallback}`);
      return fallback;
    }
  }
  console.warn(`No usable font found for language "${language}" — text overlay will be skipped.`);
  return null;
}

// --- Download a file from a Twilio media URL (needs Basic Auth) ---
async function downloadFile(url, destPath) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    auth: TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
      ? { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN }
      : undefined
  });
  fs.writeFileSync(destPath, response.data);
  return destPath;
}

// Escape text for FFmpeg drawtext filter (value is wrapped in single quotes).
// Inside a single-quoted filtergraph value, a literal apostrophe must be
// written as '\'' (close quote, escaped quote, reopen quote) — a plain
// backslash-escape does NOT work here and corrupts the rest of the filter.
function escapeDrawtext(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''");
}

function getFileSizeMB(filePath) {
  const stats = fs.statSync(filePath);
  return +(stats.size / (1024 * 1024)).toFixed(2);
}

// Re-encode at a given CRF to hit the size target
function encodeWithCrf(inputArgsBuilder, outputPath, crf) {
  return new Promise((resolve, reject) => {
    const args = inputArgsBuilder(crf, outputPath);
    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(outputPath);
    });
  });
}

async function renderWithSizeFallback(inputArgsBuilder, outputPath) {
  const crfSteps = [23, 26, 28, 32];
  let lastErr;
  for (const crf of crfSteps) {
    try {
      await encodeWithCrf(inputArgsBuilder, outputPath, crf);
      const sizeMB = getFileSizeMB(outputPath);
      if (sizeMB <= MAX_FILE_SIZE_MB) return sizeMB;
      lastErr = new Error(`Output still ${sizeMB}MB after CRF ${crf}`);
    } catch (e) {
      lastErr = e;
    }
  }
  const sizeMB = fs.existsSync(outputPath) ? getFileSizeMB(outputPath) : null;
  if (sizeMB !== null) return sizeMB; // best effort, return whatever we got
  throw lastErr || new Error('Render failed at all CRF levels');
}

app.post('/render', async (req, res) => {
  const jobId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const workDir = path.join(OUTPUT_DIR, 'tmp-' + jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const { mode, media_url, audio_url, music, product_name, tagline, language } = req.body;

    if (!mode || !media_url) {
      return res.status(400).json({ error: 'mode and media_url are required' });
    }

    const mediaPath = path.join(workDir, 'media_input');
    await downloadFile(media_url, mediaPath);

    const musicPath = music && fs.existsSync(path.join(MUSIC_DIR, music))
      ? path.join(MUSIC_DIR, music) : null;
    if (music && !musicPath) console.warn(`Music file not found: ${music} — rendering without audio track.`);
    const fontPath = fontForLanguage(language);
    const productText = escapeDrawtext(product_name);
    const taglineText = escapeDrawtext(tagline);
    const outputPath = path.join(OUTPUT_DIR, `reel-${jobId}.mp4`);

    // If no font is available yet, skip the overlay instead of failing the render.
    const drawtextFilter = fontPath
      ? `drawtext=fontfile='${fontPath}':text='${productText}':fontcolor=white:fontsize=64:` +
        `x=(w-text_w)/2:y=h-320:box=1:boxcolor=black@0.5:boxborderw=20,` +
        `drawtext=fontfile='${fontPath}':text='${taglineText}':fontcolor=white:fontsize=40:` +
        `x=(w-text_w)/2:y=h-220:box=1:boxcolor=black@0.4:boxborderw=16`
      : null;
    // Helper to append a filter to a filter-chain label only if it exists
    const withOverlay = (baseFilter) => drawtextFilter ? `${baseFilter},${drawtextFilter}` : baseFilter;

    let inputArgsBuilder;

    if (mode === '1') {
      // Mode 1: single photo, slow Ken Burns zoom, 15s
      inputArgsBuilder = (crf, out) => {
        const args = ['-y', '-loop', '1', '-i', mediaPath];
        if (musicPath) args.push('-i', musicPath);
        args.push(
          '-filter_complex',
          `${withOverlay(`[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
          `zoompan=z='min(zoom+0.0015,1.3)':d=${TARGET_DURATION * 25}:s=1080x1920:fps=25`)}[v]`,
          '-map', '[v]'
        );
        if (musicPath) { args.push('-map', '1:a', '-shortest'); }
        args.push(
          '-t', String(TARGET_DURATION),
          '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf),
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k',
          out
        );
        return args;
      };
    } else if (mode === '3') {
      // Mode 3: input video, trim + color grade + overlay + mix music
      inputArgsBuilder = (crf, out) => {
        const args = ['-y', '-i', mediaPath];
        if (musicPath) args.push('-i', musicPath);
        args.push(
          '-filter_complex',
          `${withOverlay(`[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
          `eq=contrast=1.08:saturation=1.15`)}[v]`,
          '-map', '[v]'
        );
        if (musicPath) {
          args.push('-map', '0:a?', '-map', '1:a', '-filter_complex:a', 'amix=inputs=2:duration=first:dropout_transition=2[a]', '-map', '[a]');
        }
        args.push(
          '-t', String(TARGET_DURATION),
          '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf),
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k',
          out
        );
        return args;
      };
    } else {
      // Mode 2 (slideshow) — needs multiple photo URLs (media_url can be a comma-separated
      // list once the n8n side is upgraded to capture MediaUrl0..MediaUrl4).
      // Falls back to treating it like Mode 1 with a single photo for now.
      inputArgsBuilder = (crf, out) => {
        const args = ['-y', '-loop', '1', '-i', mediaPath];
        if (musicPath) args.push('-i', musicPath);
        args.push(
          '-filter_complex',
          `${withOverlay(`[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fade=t=in:st=0:d=1`)}[v]`,
          '-map', '[v]'
        );
        if (musicPath) { args.push('-map', '1:a', '-shortest'); }
        args.push(
          '-t', String(TARGET_DURATION),
          '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf),
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k',
          out
        );
        return args;
      };
    }

    const fileSizeMB = await renderWithSizeFallback(inputArgsBuilder, outputPath);

    const host = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `${req.protocol}://${req.get('host')}`;
    const finalVideoUrl = `${host}/output/${path.basename(outputPath)}`;

    fs.rmSync(workDir, { recursive: true, force: true });

    return res.json({
      finalVideoUrl,
      durationSeconds: TARGET_DURATION,
      fileSizeMB
    });
  } catch (err) {
    console.error('Render failed:', err.stack || err.message || err);
    fs.rmSync(workDir, { recursive: true, force: true });
    return res.status(500).json({ error: err.message || 'Render failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg render server listening on port ${PORT}`));
