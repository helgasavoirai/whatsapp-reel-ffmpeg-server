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
const FFMPEG_THREADS = '2';

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

function escapeDrawtext(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function escapePath(p) {
  return String(p).replace(/\\/g, '\\\\').replace(/'/g, "'\\\\''");
}

function getFileSizeMB(filePath) {
  const stats = fs.statSync(filePath);
  return +(stats.size / (1024 * 1024)).toFixed(2);
}

function encodeWithCrf(inputArgsBuilder, outputPath, crf) {
  return new Promise((resolve, reject) => {
    const args = inputArgsBuilder(crf, outputPath);
    console.log('FFMPEG ARGS:', JSON.stringify(args)); // debug: shows in Railway Deploy Logs
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
        lastErr = new Error('FFmpeg exited without error but produced an empty (0 byte) file');
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
    // mode can arrive as the STRING "1" or the NUMBER 1 (Google Sheets
    // auto-converts numeric-looking cells) — always normalize before branching.
    const modeStr = String(mode);
    console.log('RENDER REQUEST mode(raw)=', JSON.stringify(mode), 'modeStr=', modeStr);

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

    const productTextPath = path.join(workDir, 'product_name.txt');
    const priceTextPath = path.join(workDir, 'price.txt');
    const taglineTextPath = path.join(workDir, 'tagline.txt');
    fs.writeFileSync(productTextPath, String(product_name || ''));
    fs.writeFileSync(priceTextPath, String(price || ''));
    fs.writeFileSync(taglineTextPath, String(tagline || ''));
    const escapedProductPath = escapePath(productTextPath);
    const escapedPricePath = escapePath(priceTextPath);
    const escapedTaglinePath = escapePath(taglineTextPath);

    function animatedTextFilter(textfilePath, fontSize, baseY, appearAt, animDur, slideDist) {
      const yExpr = `h-${baseY}+${slideDist}*(1-min(max((t-${appearAt})/${animDur}\\,0)\\,1))`;
      const alphaExpr = `if(lt(t\\,${appearAt})\\,0\\,min((t-${appearAt})/${animDur}\\,1))`;
      return `drawtext=fontfile='${fontPath}':textfile='${textfilePath}':fontcolor=white:fontsize=${fontSize}:` +
        `x=(w-text_w)/2:y='${yExpr}':` +
        `borderw=3:bordercolor=black@0.85:shadowcolor=black@0.6:shadowx=2:shadowy=2:` +
        `alpha='${alphaExpr}'`;
    }

    const drawtextFilter = fontPath
      ? [
          animatedTextFilter(escapedProductPath, 64, 420, 2, 0.6, 25),
          animatedTextFilter(escapedPricePath, 56, 320, 5, 0.6, 25),
          animatedTextFilter(escapedTaglinePath, 40, 220, 8, 0.6, 20)
        ].join(',')
      : null;
    const withOverlay = (baseFilter) => drawtextFilter ? `${baseFilter},${drawtextFilter}` : baseFilter;

    let inputArgsBuilder;

    if (modeStr === '1') {
      console.log('BRANCH: Mode 1 (Ken Burns zoompan) selected');
      const totalFrames = TARGET_DURATION * 25;
      inputArgsBuilder = (crf, out) => {
        const args = ['-y', '-loop', '1', '-framerate', '25', '-i', mediaPath];
        if (musicPath) args.push('-i', musicPath);
        args.push(
          '-filter_complex',
          `${withOverlay(
            `[0:v]scale=1620:2880:force_original_aspect_ratio=increase,crop=1620:2880,` +
            `zoompan=z='min(zoom+0.0008\\,1.2)':` +
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
    } else if (modeStr === '3') {
      console.log('BRANCH: Mode 3 (video edit) selected');
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
      console.log('BRANCH: Mode 2/fallback (no zoompan) selected — modeStr was:', modeStr);
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
      fileSizeMB,
      modeUsed: modeStr,
      serverVersion: 'v2-debug'
    });
  } catch (err) {
    console.error('Render failed:', err.stack || err.message || err);
    fs.rmSync(workDir, { recursive: true, force: true });
    return res.status(500).json({ error: err.message || 'Render failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: 'v2-debug' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg render server listening on port ${PORT}`));
