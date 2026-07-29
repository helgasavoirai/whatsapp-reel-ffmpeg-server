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

// Per the Trello FFmpeg command references, product_name and price use the
// BOLD weight, tagline stays Regular. Falls back to the regular font (same
// script) if the bold file hasn't been uploaded to /fonts yet, so overlays
// never break — they'll just render non-bold until the bold files are added.
function boldFontForLanguage(language) {
  const lang = (language || '').toLowerCase();
  let preferred;
  if (lang.includes('hindi')) preferred = path.join(FONTS_DIR, 'NotoSansDevanagari-Bold.ttf');
  else if (lang.includes('gujarati')) preferred = path.join(FONTS_DIR, 'NotoSansGujarati-Bold.ttf');
  else preferred = path.join(FONTS_DIR, 'NotoSans-Bold.ttf');

  if (fs.existsSync(preferred)) return preferred;
  console.warn(`Bold font not found at ${preferred}, falling back to Regular weight`);
  return fontForLanguage(language);
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

function escapePath(p) {
  return String(p).replace(/\\/g, '\\\\').replace(/'/g, "'\\\\''");
}

function getFileSizeMB(filePath) {
  const stats = fs.statSync(filePath);
  return +(stats.size / (1024 * 1024)).toFixed(2);
}

// ---------------------------------------------------------------------
// Text wrapping for drawtext overlays.
//
// ffmpeg's drawtext filter does NOT word-wrap on its own — a textfile is
// rendered as literally as many lines as it contains. x=(w-text_w)/2 only
// centers the (single, full-width) line; if that line is wider than the
// frame, the math still "centers" it but half of it falls off each side.
// That's exactly why long taglines were getting cut off left/right.
//
// Fix: measure (approximately) how many characters fit per line for a
// given font size and target width, wrap onto multiple lines, and shrink
// the font size a step at a time if it still doesn't fit within a max
// number of lines. This is an estimate (no real glyph metrics available
// server-side without adding a font-measuring lib), but a conservative
// average-char-width ratio keeps text safely inside the frame in practice.
// ---------------------------------------------------------------------
const AVG_CHAR_WIDTH_RATIO = 0.55;

function wrapTextToWidth(text, fontSize, maxWidthPx) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const avgCharWidth = fontSize * AVG_CHAR_WIDTH_RATIO;
  const maxCharsPerLine = Math.max(1, Math.floor(maxWidthPx / avgCharWidth));

  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

// If wrapping still produces more lines than maxLines (font too big for
// the text length / frame width), shrink fontSize step by step until it
// fits, down to minFontSize. Keeps very long taglines from either running
// off-screen OR growing into a huge unreadable block of text.
function fitTextBlock(text, initialFontSize, maxWidthPx, maxLines, minFontSize = 24) {
  let fontSize = initialFontSize;
  let wrapped = wrapTextToWidth(text, fontSize, maxWidthPx);
  while (wrapped.split('\n').length > maxLines && fontSize > minFontSize) {
    fontSize -= 4;
    wrapped = wrapTextToWidth(text, fontSize, maxWidthPx);
  }
  return { text: wrapped, fontSize };
}

function encodeWithCrf(inputArgsBuilder, outputPath, crf) {
  return new Promise((resolve, reject) => {
    const args = inputArgsBuilder(crf, outputPath);
    console.log('FFMPEG ARGS:', JSON.stringify(args));
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
    const modeStr = String(mode);
    console.log('RENDER REQUEST mode(raw)=', JSON.stringify(mode), 'modeStr=', modeStr);

    if (!mode || !media_url) {
      return res.status(400).json({ error: 'mode and media_url are required' });
    }

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
    // NOTE: tagline.txt is intentionally NOT written with the raw tagline
    // here anymore — buildTextOverlay() below rewraps it per-mode (each
    // mode has a different frame width) and overwrites this file right
    // before it's referenced by the drawtext filter.
    fs.writeFileSync(taglineTextPath, String(tagline || ''));
    const escapedProductPath = escapePath(productTextPath);
    const escapedPricePath = escapePath(priceTextPath);
    const escapedTaglinePath = escapePath(taglineTextPath);

    const boldFontPath = boldFontForLanguage(language);

    // One drawtext line, animated (fade + slight slide) into its resting
    // position starting at appearAt. yFinalExpr is a raw ffmpeg expression
    // for the resting y (no quotes needed, e.g. '200' or '(h/2)-40').
    function animatedTextFilter(textfilePath, fontFileToUse, fontColor, fontSize, yFinalExpr, appearAt, animDur, slideDist) {
      const yExpr = `(${yFinalExpr})+${slideDist}*(1-min(max((t-${appearAt})/${animDur}\\,0)\\,1))`;
      const alphaExpr = `if(lt(t\\,${appearAt})\\,0\\,min((t-${appearAt})/${animDur}\\,1))`;
      return `drawtext=fontfile='${fontFileToUse}':textfile='${textfilePath}':fontcolor=${fontColor}:fontsize=${fontSize}:` +
        `x=(w-text_w)/2:y='${yExpr}':text_align=center:line_spacing=6:` +
        `borderw=3:bordercolor=black@0.85:shadowcolor=black@0.6:shadowx=2:shadowy=2:` +
        `alpha='${alphaExpr}'`;
    }

    // Per the Trello FFmpeg command references (Mode 1 & Mode 2 cards):
    // product name near the top (bold, white), price front-and-center in
    // the middle (bold, YELLOW, largest), tagline near the bottom
    // (regular weight, white, smallest). Timing differs per mode per the
    // architecture card (Step 6A/6B/6C), so this is built fresh for
    // whichever mode ends up rendering.
    //
    // videoWidth is required now so the tagline can be wrapped/sized
    // against the ACTUAL output frame width (1620 for Mode 1, 1080 for
    // Mode 2/3/fallback) instead of overflowing it.
    function buildTextOverlay(nameAppearAt, priceAppearAt, taglineAppearAt, videoWidth) {
      if (!boldFontPath) return null;

      const TAGLINE_BASE_FONT_SIZE = 40;
      const TAGLINE_MAX_LINES = 3;
      const TAGLINE_BOTTOM_MARGIN = 160; // px from bottom edge to the bottom line of text
      const safeWidthPx = videoWidth * 0.85; // ~7.5% margin on each side

      const fitted = fitTextBlock(String(tagline || ''), TAGLINE_BASE_FONT_SIZE, safeWidthPx, TAGLINE_MAX_LINES);
      fs.writeFileSync(taglineTextPath, fitted.text);

      const lineCount = fitted.text.split('\n').length;
      const lineHeight = fitted.fontSize * 1.3;
      // Anchor moves UP as the tagline wraps onto more lines, so the
      // bottom-most line always sits ~TAGLINE_BOTTOM_MARGIN px from the
      // bottom edge instead of the whole block sinking off-screen.
      const taglineY = `h-${TAGLINE_BOTTOM_MARGIN}-${(lineCount - 1) * lineHeight}`;

      return [
        animatedTextFilter(escapedProductPath, boldFontPath, 'white', 60, '200', nameAppearAt, 0.6, 25),
        animatedTextFilter(escapedPricePath, boldFontPath, 'yellow', 80, '(h/2)', priceAppearAt, 0.6, 25),
        animatedTextFilter(escapedTaglinePath, fontPath, 'white', fitted.fontSize, taglineY, taglineAppearAt, 0.6, 20)
      ].join(',');
    }

    const withOverlayUsing = (baseFilter, textOverlay) => textOverlay ? `${baseFilter},${textOverlay}` : baseFilter;

    // Music fade in/out (1s each), applied identically across Mode 1, 2, and 3.
    // inputIndex is the ffmpeg input number of the music track for that mode.
    function audioFadeFilter(inputIndex) {
      const fadeOutStart = Math.max(TARGET_DURATION - 1, 0);
      return `[${inputIndex}:a]afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart}:d=1[a]`;
    }

    let inputArgsBuilder;
    let actualOutputDuration = TARGET_DURATION; // Mode 3 overrides this (13s, or shorter if the trader's video is shorter)

    if (modeStr === '1') {
      console.log('BRANCH: Mode 1 (Ken Burns zoompan) selected');
      const mediaPath = path.join(workDir, 'media_input');
      await downloadFile(media_url, mediaPath);
      const totalFrames = TARGET_DURATION * 25;
      inputArgsBuilder = (crf, out) => {
        const args = ['-y', '-loop', '1', '-framerate', '25', '-i', mediaPath];
        if (musicPath) args.push('-i', musicPath);
        const videoFilter = `${withOverlayUsing(
          `[0:v]scale=1620:2880:force_original_aspect_ratio=increase,crop=1620:2880,` +
          `zoompan=z='min(zoom+0.0008\\,1.2)':` +
          `x='(iw-iw/zoom)*(on/${totalFrames - 1})':` +
          `y='(ih-ih/zoom)/2':` +
          `d=${totalFrames}:s=1080x1920:fps=25,` +
          `fade=t=in:st=0:d=1`,
          buildTextOverlay(2, 5, 8, 1620)
        )}[v]`;
        const filterChain = musicPath
          ? `${videoFilter};${audioFadeFilter(1)}`
          : videoFilter;
        args.push('-filter_complex', filterChain, '-map', '[v]');
        const outputArgs = ['-t', String(TARGET_DURATION), '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-threads', FFMPEG_THREADS, '-pix_fmt', 'yuv420p'];
        if (musicPath) {
          args.push('-map', '[a]', '-shortest');
          outputArgs.push('-c:a', 'aac', '-b:a', '128k');
        }
        args.push(...outputArgs, out);
        return args;
      };
    } else if (modeStr === '3') {
      console.log('BRANCH: Mode 3 (video edit) selected');
      const mediaPath = path.join(workDir, 'media_input');
      await downloadFile(media_url, mediaPath);

      // Trello spec: output is 13s, but if the trader's video is SHORTER
      // than 13s, use its actual length instead of forcing -t 13 (which
      // would just leave it at its natural shorter length anyway, but this
      // makes the reported duration accurate and keeps text/audio timing
      // sane for very short clips).
      const MODE3_MAX_DURATION = 13;
      let mode3Duration = MODE3_MAX_DURATION;
      try {
        const probedDuration = await new Promise((resolve, reject) => {
          execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mediaPath], (err, stdout) => {
            if (err) return reject(err);
            const d = parseFloat(stdout);
            resolve(isNaN(d) ? null : d);
          });
        });
        if (probedDuration && probedDuration < MODE3_MAX_DURATION) mode3Duration = probedDuration;
      } catch (e) {
        console.warn('ffprobe duration check failed, defaulting to 13s cap:', e.message);
      }
      actualOutputDuration = mode3Duration;

      // WhatsApp/Twilio videos are sometimes silent (no audio track at all -
      // this is a known WhatsApp quirk, not just an edge case). Referencing
      // [0:a] in the filter_complex when there's no audio stream 0 crashes
      // ffmpeg outright, so probe for an audio stream first and fall back
      // to music-only (same treatment as Mode 1/2) when the video is silent.
      let videoHasAudio = false;
      try {
        const audioProbe = await new Promise((resolve, reject) => {
          execFile('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', mediaPath], (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout.trim());
          });
        });
        videoHasAudio = audioProbe.length > 0;
      } catch (e) {
        console.warn('ffprobe audio-stream check failed, assuming no audio track:', e.message);
      }
      console.log('Mode 3: video has audio track =', videoHasAudio);

      inputArgsBuilder = (crf, out) => {
        const args = ['-y', '-i', mediaPath];
        if (musicPath) args.push('-i', musicPath);
        // Per Trello spec: saturation 1.3, contrast 1.1, brightness 0.05
        const videoFilter = `${withOverlayUsing(`[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
          `eq=saturation=1.3:contrast=1.1:brightness=0.05`, buildTextOverlay(2, 6, 10, 1080))}[v]`;
        let filterChain = videoFilter;
        if (musicPath && videoHasAudio) {
          // Per Trello spec: original video audio at 30% volume, music at 70%.
          filterChain = `${videoFilter};[0:a]volume=0.3[a0];[1:a]volume=0.7,afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(mode3Duration - 1, 0)}:d=1[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[a]`;
        } else if (musicPath && !videoHasAudio) {
          // Silent video: just use the music track (faded), nothing to mix.
          filterChain = `${videoFilter};${audioFadeFilter(1)}`;
        }
        args.push('-filter_complex', filterChain, '-map', '[v]');
        const outputArgs = ['-t', String(mode3Duration), '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-threads', FFMPEG_THREADS, '-pix_fmt', 'yuv420p'];
        if (musicPath) {
          args.push('-map', '[a]');
          outputArgs.push('-c:a', 'aac', '-b:a', '128k');
        }
        args.push(...outputArgs, out);
        return args;
      };
    } else if (modeStr === '2') {
      console.log('BRANCH: Mode 2 (slideshow) selected');
      // media_url is a comma-separated list of 3-5 photo URLs (built by the
      // n8n Auto Detection node from Twilio's MediaUrl0..MediaUrl4).
      const photoUrls = String(media_url).split(',').map(u => u.trim()).filter(Boolean);
      const n = Math.max(photoUrls.length, 1);
      console.log(`Mode 2: ${n} photos received`);

      const xfadeDur = 0.5; // per Trello spec: 0.5s cross-fade
      // For a chain of N xfade stages, each stage's output duration is
      // (offset + duration of the incoming clip). With offset_k = k*holdDur,
      // the FINAL total works out to n*holdDur + xfadeDur -- only one
      // transition's worth gets added overall, not (n-1) of them. The old
      // formula subtracted xfadeDur*(n-1) up front, which under-shot the
      // target duration more and more as photo count grew (5 photos ->
      // ~13.5s instead of 15s). Solving n*holdDur + xfadeDur = TARGET_DURATION:
      const holdDur = n > 1 ? (TARGET_DURATION - xfadeDur) / n : TARGET_DURATION;
      const clipDur = n > 1 ? holdDur + xfadeDur : TARGET_DURATION;

      const photoPaths = [];
      for (let i = 0; i < n; i++) {
        const p = path.join(workDir, `photo_${i}.jpg`);
        await downloadFile(photoUrls[i], p);
        photoPaths.push(p);
      }

      inputArgsBuilder = (crf, out) => {
        const args = ['-y'];
        for (const p of photoPaths) {
          args.push('-loop', '1', '-t', String(clipDur), '-i', p);
        }
        if (musicPath) args.push('-i', musicPath);

        const filterParts = [];
        for (let i = 0; i < n; i++) {
          filterParts.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v${i}]`);
        }

        let prevLabel = 'v0';
        if (n > 1) {
          for (let i = 1; i < n; i++) {
            const offset = i * holdDur;
            const outLabel = `vx${i}`;
            filterParts.push(`[${prevLabel}][v${i}]xfade=transition=fade:duration=${xfadeDur}:offset=${offset.toFixed(3)}[${outLabel}]`);
            prevLabel = outLabel;
          }
        }

        const mode2TextOverlay = buildTextOverlay(0, 5, 10, 1080);
        if (mode2TextOverlay) {
          filterParts.push(`[${prevLabel}]${mode2TextOverlay}[v]`);
        } else {
          filterParts.push(`[${prevLabel}]null[v]`);
        }

        if (musicPath) filterParts.push(audioFadeFilter(n));
        args.push('-filter_complex', filterParts.join(';'), '-map', '[v]');
        const outputArgs = ['-t', String(TARGET_DURATION), '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-threads', FFMPEG_THREADS, '-pix_fmt', 'yuv420p'];
        if (musicPath) {
          args.push('-map', '[a]', '-shortest');
          outputArgs.push('-c:a', 'aac', '-b:a', '128k');
        }
        args.push(...outputArgs, out);
        return args;
      };
    } else {
      console.log('BRANCH: unrecognized mode, using single-photo fallback — modeStr was:', modeStr);
      const mediaPath = path.join(workDir, 'media_input');
      await downloadFile(media_url, mediaPath);
      inputArgsBuilder = (crf, out) => {
        const args = ['-y', '-loop', '1', '-framerate', '25', '-i', mediaPath];
        if (musicPath) args.push('-i', musicPath);
        const videoFilter = `${withOverlayUsing(`[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fade=t=in:st=0:d=1`, buildTextOverlay(2, 5, 8, 1080))}[v]`;
        const filterChain = musicPath ? `${videoFilter};${audioFadeFilter(1)}` : videoFilter;
        args.push('-filter_complex', filterChain, '-map', '[v]');
        const outputArgs = ['-t', String(TARGET_DURATION), '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-threads', FFMPEG_THREADS, '-pix_fmt', 'yuv420p'];
        if (musicPath) {
          args.push('-map', '[a]', '-shortest');
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
      durationSeconds: actualOutputDuration,
      fileSizeMB,
      modeUsed: modeStr,
      serverVersion: 'v4-tagline-wrap-fix'
    });
  } catch (err) {
    console.error('Render failed:', err.stack || err.message || err);
    fs.rmSync(workDir, { recursive: true, force: true });
    return res.status(500).json({ error: err.message || 'Render failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: 'v4-tagline-wrap-fix' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg render server listening on port ${PORT}`));
