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
const FFMPEG_THREADS = '2'; // Railway containers report far more CPUs than they
// actually get; leaving FFmpeg to auto-detect (e.g. 60 threads) causes huge
// memory overhead and the process gets OOM-killed mid-render.

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

// Escape text for FFmpeg's drawtext filter argument.
// IMPORTANT: we call ffmpeg directly via execFile (no shell involved), so
// FFmpeg's filtergraph parser sees this string exactly as written — no
// shell-level escaping tricks apply here (the '\'' bash trick does NOT
// work and corrupts the filter). We escape special chars with a single
// backslash and do NOT wrap the value in quotes.
function escapeDrawtext(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

// Escape a file path for use inside a single-quoted filtergraph value.
// Paths we generate ourselves never contain apostrophes, but this keeps
// things safe if that ever changes (e.g. a workDir name derived from
// user input in the future).
function escapePath(p) {
  return String(p).replace(/\\/g, '\\\\').replace(/'/g, "'\\\\''");
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
      if (sizeMB > 0 && sizeMB <= MAX_FILE_SIZE_MB) return sizeMB;
      if (sizeMB === 0) {
        lastErr = new Error('FFmpeg exited without error but produced an empty (0 byte) file — check filter_complex syntax and input validity');
        continue;
      }
      lastErr = new Error(`Output still ${sizeMB}MB after CRF ${crf}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Render failed at all CRF levels');
}

app.post('/render', async (req, res) => {
  const jobId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const workDir = path.join(OUTPUT_DIR, 'tmp-' + jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const { mode, media_url, audio_url, music, product_name, price, tagline, language } = req.body;

    if (!mode || !media_url) {
      return res.status(400).json({ error: 'mode and media_url are required' });
    }

    const mediaPath = path.join(workDir, 'media_input');
    await downloadFile(media_url, mediaPath);

    const musicPath = music && fs.existsSync(path.join(MUSIC_DIR, music))
      ? path.join(MUSIC_DIR, music) : null;
    if (music && !musicPath) console.warn(`Music file not found: ${music} — rendering without audio track.`);
    const fontPath = fontForLanguage(language);
    const outputPath = path.join(OUTPUT_DIR, `reel-${jobId}.mp4`);

    // Write overlay text to temp files and use drawtext's `textfile=` option
    // instead of `text=`. This sidesteps ALL filtergraph escaping headaches
    // (apostrophes, colons, commas, quotes) since the file's raw content is
    // read verbatim — only the file PATH needs escaping, and we control that
    // path so it never contains special characters.
    const productTextPath = path.join(workDir, 'product_name.txt');
    const priceTextPath = path.join(workDir, 'price.txt');
    const taglineTextPath = path.join(workDir, 'tagline.txt');
    fs.writeFileSync(productTextPath, String(product_name || ''));
    fs.writeFileSync(priceTextPath, String(price || ''));
    fs.writeFileSync(taglineTextPath, String(tagline || ''));
    const escapedProductPath = escapePath(productTextPath);
    const escapedPricePath = escapePath(priceTextPath);
    const escapedTaglinePath = escapePath(taglineTextPath);

    // If no font is available yet, skip the overlay instead of failing the render.
    // No boxcolor/box=1 anymore — border + shadow keep text readable without
    // the flat grey rectangle. enable='gte(t,N)' makes each line appear at
    // its own timestamp per the Trello timing spec (name 2s, price 5s,
    // tagline 8s) and then stay visible until the end.
    const drawtextFilter = fontPath
      ? `drawtext=fontfile='${fontPath}':textfile='${escapedProductPath}':fontcolor=white:fontsize=64:` +
        `x=(w-text_w)/2:y=h-420:borderw=3:bordercolor=black@0.85:shadowcolor=black@0.6:shadowx=2:shadowy=2:` +
        `enable='gte(t,2)',` +
        `drawtext=fontfile='${fontPath}':textfile='${escapedPricePath}':fontcolor=white:fontsize=56:` +
        `x=(w-text_w)/2:y=h-320:borderw=3:bordercolor=black@0.85:shadowcolor=black@0.6:shadowx=2:shadowy=2:` +
        `enable='gte(t,5)',` +
        `drawtext=fontfile='${fontPath}':textfile='${escapedTaglinePath}':fontcolor=white:fontsize=40:` +
        `x=(w-text_w)/2:y=h-220:borderw=2:bordercolor=black@0.75:shadowcolor=black@0.5:shadowx=2:shadowy=2:` +
        `enable='gte(t,8)'`
      : null;
    // Helper to append a filter to a filter-chain label only if it exists
    const withOverlay = (baseFilter) => drawtextFilter ? `${baseFilter},${drawtextFilter}` : baseFilter;

    let inputArgsBuilder;

    if (mode === '1') {
      // Mode 1: single photo, real Ken Burns effect — zoom in gradually
      // while panning left-to-right. Note: an earlier version of this used
      // zoompan directly on the raw photo resolution and got OOM-killed on
      // Railway. Two things fix that here: (1) we pre-scale to a moderate
      // 1620x2880 working size instead of the original (often much larger)
      // photo resolution before zoompan touches it, and (2) -threads is
      // pinned to 2 (see FFMPEG_THREADS) so libx264 doesn't over-allocate.
      // If this still OOMs on the 1GB free-tier container, first thing to
      // try is lowering the pre-scale size further (e.g. 1215x2160) before
      // falling back to a crop-only pan.
      const totalFrames = TARGET_DURATION * 25; // 375 frames at 25fps
      inputArgsBuilder = (crf, out) => {
        const args = ['-y', '-loop', '1', '-framerate', '25', '-i', mediaPath];
        if (musicPath) args.push('-i', musicPath);
        args.push(
          '-filter_complex',
          `${withOverlay(
            `[0:v]scale=1620:2880:force_original_aspect_ratio=increase,crop=1620:2880,` +
            `zoompan=z='min(zoom+0.0008,1.2)':` +
            `x='(iw-iw/zoom)*(on/${totalFrames - 1})':` +
            `y='(ih-ih/zoom)/2':` +
            `d=${totalFrames}:s=1080x1920:fps=25,` +
            `fade=t=in:st=0:d=1`
          )}[v]`,
          '-map', '[v]'
        );
        const outputArgs = ['-t', String(TARGET_DURATION), '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-threads', FFMPEG_THREADS, '-pix_fmt', 'yuv420p'];
        if (musicPath) {
          args.push('-map', '1:a', '-shortest');
          outputArgs.push('-c:a', 'aac', '-b:a', '128k');
        }
        args.push(...outputArgs, out);
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
        const outputArgs = ['-t', String(TARGET_DURATION), '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-threads', FFMPEG_THREADS, '-pix_fmt', 'yuv420p'];
        if (musicPath) {
          args.push('-map', '0:a?', '-map', '1:a', '-filter_complex:a', 'amix=inputs=2:duration=first:dropout_transition=2[a]', '-map', '[a]');
          outputArgs.push('-c:a', 'aac', '-b:a', '128k');
        }
        args.push(...outputArgs, out);
        return args;
      };
    } else {
      // Mode 2 (slideshow) — needs multiple photo URLs (media_url can be a comma-separated
      // list once the n8n side is upgraded to capture MediaUrl0..MediaUrl4).
      // Falls back to treating it like Mode 1 with a single photo for now.
      inputArgsBuilder = (crf, out) => {
        const args = ['-y', '-loop', '1', '-framerate', '25', '-i', mediaPath];
        if (musicPath) args.push('-i', musicPath);
        args.push(
          '-filter_complex',
          `${withOverlay(`[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fade=t=in:st=0:d=1`)}[v]`,
          '-map', '[v]'
        );
        const outputArgs = ['-t', String(TARGET_DURATION), '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-threads', FFMPEG_THREADS, '-pix_fmt', 'yuv420p'];
        if (musicPath) {
          args.push('-map', '1:a', '-shortest');
          outputArgs.push('-c:a', 'aac', '-b:a', '128k');
        }
        args.push(...outputArgs, out);
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
