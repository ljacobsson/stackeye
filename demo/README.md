# Annotated demo video

Turns `public/stackeye.mp4` (the raw screen recording) into
`public/stackeye-demo.mp4`: a caption card explaining each feature, then an
animated closing screen listing every supported service.

## Tweak the captions

All copy and timing lives in [`overlays.js`](overlays.js) — one object per card:

```js
{
  t: 23.5, end: 26.5, pos: 'br', accent: 'amber',
  kicker: 'Metrics',
  title: 'A catalog, not a fixed dashboard',
  body: '87 CloudWatch metrics, scoped to this stack only. …',
}
```

- `pos` — which corner the card sits in: `bl`, `br`, `tl`, `tr`. The corner
  margins are chosen so cards never clip the sidebar's AWS account footer, the
  floating assistant button, or the recorded browser toolbar.
- `accent` — `blue`, `cyan`, `violet`, `amber` or `red`.
- `body` — `` `backticks` `` render as an inline code chip.
- A 0.3s fade in and out is taken from inside each card's own window, so cards
  can sit back to back without overlapping.

## Tweak the closing screen

[`outro.js`](outro.js) holds the copy for the animated end card: the headline,
the "more on the way" pill, one tile per AWS service, the three capability
chips, the credential-chain band, and the footer. `icon` on a tile is a file in
[`../public/icons/`](../public/icons), and its AWS category colour becomes the
tile's glow. Keep the tile count a multiple of five so the grid stays even.

The whole animation is a pure function of time, which is what lets the renderer
ask the page for an arbitrary frame. Change `duration` and the reveal stagger
and the highlight sweep re-time themselves around it.

## Preview

```bash
npm run demo:preview
```

Serves the player and opens it. Space plays and pauses, arrow keys jump between
cards, and the list underneath the video seeks to any card. The closing screen
plays when the footage ends, or on demand from the Outro button. Edit
`overlays.js` or `outro.js` and refresh.

## Render

```bash
npm run demo:render                       # -> public/stackeye-demo.mp4
node demo/render.mjs --out /tmp/demo.mp4  # somewhere else
node demo/render.mjs --keep               # keep the PNGs for inspection
node demo/render.mjs --no-outro           # captions only
node demo/render.mjs --outro-only         # just the closing screen, ~1 min
```

Rendering drives headless Chrome over the DevTools protocol and captures from
the *same* `demo.html` the preview uses: each caption as a transparent
1920x1080 PNG, and the closing screen as one opaque PNG per frame. ffmpeg fades
the captions over the source video and cross-fades through black into the
closing frames. That is why the mp4 matches the preview — there is no second
implementation of the design.

A full render captures 25 stills per second of closing screen, so it takes a
minute or two. Use `--outro-only` while iterating on the end card.

Requires `google-chrome` (or `chromium`, or `CHROME_PATH`) plus `ffmpeg` and
`ffprobe` on PATH. No npm dependencies.

One caveat: the cards use whatever sans-serif the *rendering* machine resolves
from `Inter, "Liberation Sans", ui-sans-serif, …`. Install Inter to have the
captions match StackEye's own UI font exactly.
