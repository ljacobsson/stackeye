#!/usr/bin/env node
/*
 * Renders demo/demo.html's overlay layer onto public/stackeye.mp4 and appends
 * its animated closing screen.
 *
 *   node demo/render.mjs              # render public/stackeye-demo.mp4
 *   node demo/render.mjs --preview    # serve the preview player and open it
 *   node demo/render.mjs --out path/to/file.mp4
 *   node demo/render.mjs --keep       # keep the intermediate PNGs
 *   node demo/render.mjs --no-outro   # captions only, no closing screen
 *   node demo/render.mjs --outro-only # just the closing screen (fast to iterate)
 *
 * How it works: a local static server serves the repo, headless Chrome loads
 * demo.html?render=<i> once and is asked to show one cue at a time, and each
 * cue is captured as a transparent 1920x1080 PNG. The closing screen is
 * captured the same way from demo.html?render=outro, one opaque PNG per frame,
 * by asking the page for an arbitrary point on its timeline. ffmpeg then fades
 * each caption over the source video and cross-fades into the closing frames.
 * Because the captures come from the same HTML the browser preview uses, the
 * mp4 matches the preview.
 *
 * Requires: google-chrome (or chromium), ffmpeg and ffprobe on PATH. No npm deps.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SOURCE = join(ROOT, 'public', 'stackeye.mp4');
const FADE = 0.3; // seconds, taken from inside each cue's window
const FPS = 25;
const OUTRO_XFADE = 0.8; // seconds of fade-through-black into the closing screen

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const OUT = resolve(option('out', join(ROOT, 'public', 'stackeye-demo.mp4')));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function serve(root) {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(root)) return res.writeHead(403).end();
      createReadStream(file)
        .on('open', () => res.writeHead(200, {
          'content-type': MIME[extname(file)] || 'application/octet-stream',
          'cache-control': 'no-store',
        }))
        .on('error', () => res.writeHead(404).end('not found'))
        .pipe(res);
    });
    server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port }));
  });
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const bin of candidates) {
    const ok = await new Promise((done) => {
      const p = spawn(bin, ['--version'], { stdio: 'ignore' });
      p.on('error', () => done(false));
      p.on('exit', (code) => done(code === 0));
    });
    if (ok) return bin;
  }
  throw new Error('No Chrome/Chromium found. Set CHROME_PATH to its binary.');
}

/* --- minimal CDP client over node's built-in WebSocket --- */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error(`cannot connect to ${wsUrl}`));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    msg.error ? waiter.fail(new Error(msg.error.message)) : waiter.ok(msg.result);
  };
  return {
    send(method, params = {}) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((ok, fail) => pending.set(id, { ok, fail }));
    },
    async evaluate(expression) {
      const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    },
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* chrome not up yet */ }
    await sleep(100);
  }
  throw new Error('Chrome did not expose a debuggable page');
}

/* Waits for the page to expose `hook` with its fonts and images ready. */
async function ready(client, hook) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ok = await client.evaluate(
      `!!window.${hook} && document.fonts.status === "loaded"` +
      ` && [...document.images].every((i) => i.complete && i.naturalWidth > 0)`,
    ).catch(() => false);
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`page never exposed window.${hook}`);
}

async function shoot(client, file) {
  await client.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true, optimizeForSpeed: false,
  });
  await writeFile(file, Buffer.from(shot.data, 'base64'));
}

async function capture(url, dir, { wantCues, wantOutro }) {
  const chrome = await findChrome();
  const profile = join(tmpdir(), `stackeye-demo-${process.pid}`);
  const port = 9333 + (process.pid % 500);
  const proc = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1920,1080',
    `${url}?render=${wantCues ? '0' : 'outro'}`,
  ], { stdio: 'ignore' });

  try {
    const client = await cdp(await pageTarget(port));
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
    });
    await client.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });

    const captions = [];
    if (wantCues) {
      await ready(client, '__showCue');
      const cues = await client.evaluate('JSON.stringify(window.__cues)').then(JSON.parse);
      for (const [i, cue] of cues.entries()) {
        await client.evaluate(`window.__showCue(${i})`);
        const file = join(dir, `cue-${String(i).padStart(2, '0')}.png`);
        await shoot(client, file);
        captions.push({ ...cue, file });
        process.stdout.write(`\r  captured ${i + 1}/${cues.length} captions`);
      }
      process.stdout.write('\n');
      if (wantOutro) await client.send('Page.navigate', { url: `${url}?render=outro` });
    }

    let outro = null;
    if (wantOutro) {
      await ready(client, '__outroAt');
      const duration = await client.evaluate('window.__outro.duration');
      const frames = Math.round(duration * FPS);
      for (let i = 0; i < frames; i += 1) {
        await client.evaluate(`window.__outroAt(${(i / FPS).toFixed(4)})`);
        await shoot(client, join(dir, `outro-${String(i).padStart(4, '0')}.png`));
        process.stdout.write(`\r  captured ${i + 1}/${frames} closing frames`);
      }
      process.stdout.write('\n');
      outro = { pattern: join(dir, 'outro-%04d.png'), duration, frames };
    }

    client.close();
    return { captions, outro };
  } finally {
    const exited = new Promise((done) => proc.on('exit', done));
    proc.kill();
    await Promise.race([exited, sleep(3000)]);
    await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

const ENCODE = [
  '-an',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
  '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-movflags', '+faststart',
];

function buildFfmpegArgs(cues, source, out, outro, sourceDuration) {
  const argv = ['-y', '-i', source];
  const chain = [];

  for (const cue of cues) {
    const duration = +(cue.end - cue.t).toFixed(3);
    argv.push('-loop', '1', '-framerate', String(FPS), '-t', String(duration), '-i', cue.file);
  }
  if (outro) argv.push('-framerate', String(FPS), '-start_number', '0', '-i', outro.pattern);

  chain.push('[0:v]format=rgba[bg]');
  cues.forEach((cue, i) => {
    const duration = +(cue.end - cue.t).toFixed(3);
    const fade = Math.min(FADE, duration / 2.5);
    chain.push(
      `[${i + 1}:v]format=rgba,` +
      `fade=t=in:st=0:d=${fade}:alpha=1,` +
      `fade=t=out:st=${(duration - fade).toFixed(3)}:d=${fade}:alpha=1,` +
      `tpad=start_duration=${cue.t}:start_mode=add:color=0x00000000,setsar=1[ov${i}]`,
    );
  });

  let last = 'bg';
  cues.forEach((_, i) => {
    const next = i === cues.length - 1 ? 'composited' : `mix${i}`;
    chain.push(`[${last}][ov${i}]overlay=0:0:eof_action=pass:shortest=0:format=auto[${next}]`);
    last = next;
  });
  if (outro) {
    /* Fade the annotated footage through black into the closing screen. */
    const offset = +(sourceDuration - OUTRO_XFADE).toFixed(3);
    chain.push('[composited]fps=25,setsar=1[main]');
    chain.push(`[${cues.length + 1}:v]format=rgba,fps=25,setsar=1[end]`);
    chain.push(`[main][end]xfade=transition=fadeblack:duration=${OUTRO_XFADE}:offset=${offset}[full]`);
    chain.push('[full]format=yuv420p[vout]');
  } else {
    chain.push('[composited]format=yuv420p[vout]');
  }

  argv.push('-filter_complex', chain.join(';'), '-map', '[vout]', ...ENCODE, out);
  return argv;
}

function buildOutroOnlyArgs(outro, out) {
  return ['-y', '-framerate', String(FPS), '-start_number', '0', '-i', outro.pattern, ...ENCODE, out];
}

function run(bin, argv) {
  return new Promise((ok, fail) => {
    const p = spawn(bin, argv, { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', fail);
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${bin} exited ${code}`))));
  });
}

function probeDuration(file) {
  return new Promise((ok, fail) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', file,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (chunk) => { out += chunk; });
    p.on('error', fail);
    p.on('exit', () => {
      const seconds = Number.parseFloat(out);
      if (Number.isFinite(seconds)) ok(seconds);
      else fail(new Error(`ffprobe could not read the duration of ${file}`));
    });
  });
}

/* ------------------------------- main ------------------------------- */
const { server, port } = await serve(ROOT);
const url = `http://127.0.0.1:${port}/demo/demo.html`;

if (flag('preview')) {
  console.log(`\n  Preview:  ${url}`);
  console.log('  Edit demo/overlays.js and refresh. Ctrl-C to stop.\n');
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' })
    .on('error', () => {});
} else {
  const wantCues = !flag('outro-only');
  const wantOutro = !flag('no-outro');
  if (!wantCues && !wantOutro) throw new Error('--outro-only and --no-outro cancel each other out');
  const work = join(tmpdir(), `stackeye-overlays-${process.pid}`);
  await mkdir(work, { recursive: true });
  try {
    if (wantCues) await stat(SOURCE);
    console.log(`\n  Source:   ${wantCues ? SOURCE : 'closing screen only'}`);
    const { captions, outro } = await capture(url, work, { wantCues, wantOutro });

    const ffmpegArgs = wantCues
      ? buildFfmpegArgs(captions, SOURCE, OUT, outro, await probeDuration(SOURCE))
      : buildOutroOnlyArgs(outro, OUT);
    const what = [
      wantCues ? `${captions.length} captions` : null,
      outro ? `a ${outro.duration}s closing screen` : null,
    ].filter(Boolean).join(' and ');
    console.log(`  Encoding ${what} -> ${OUT}\n`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-stats', ...ffmpegArgs]);
    const { size } = await stat(OUT);
    console.log(`\n  Done:     ${OUT} (${(size / 1e6).toFixed(1)} MB)\n`);
  } finally {
    if (!flag('keep')) await rm(work, { recursive: true, force: true });
    else console.log(`  Overlay PNGs kept in ${work}`);
    server.close();
  }
}
