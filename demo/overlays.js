/*
 * StackEye annotated demo — overlay script.
 *
 * This is the single source of truth for the demo video captions. Both the
 * preview player (demo/demo.html) and the mp4 renderer (demo/render.mjs) read
 * this file, so whatever you see in the browser is what gets rendered.
 *
 * Each cue:
 *   t       start time in seconds
 *   end     end time in seconds
 *   pos     card corner: 'bl' | 'br' | 'tl' | 'tr'
 *   accent  'blue' | 'cyan' | 'violet' | 'amber' | 'red'
 *   kicker  small uppercase label
 *   title   headline
 *   body    one or two sentences. `backticks` render as inline code.
 *
 * A 0.3s fade in/out is taken from inside each cue's window.
 * Source footage is 65.56s at 25fps, 1920x1080.
 *
 * One card per scene, held long enough to read. The two scene transitions
 * (7.2-8.3 bucket zoom, 42.3-43.9 fade to black) are deliberately left bare.
 */

window.OVERLAYS = [
  {
    t: 0.5, end: 7.1, pos: 'bl', accent: 'blue',
    kicker: 'StackEye',
    title: 'Local observability for deployed stacks',
    body: 'Run `npx stackeye` in a SAM or CDK project. The architecture is inferred from your template — hover to highlight the call chain, click to open a resource.',
  },
  {
    t: 8.8, end: 13.2, pos: 'bl', accent: 'cyan',
    kicker: 'S3 explorer',
    title: 'Browse and preview the stack’s buckets',
    body: 'Search filenames across a whole bucket. PDFs, images, text, code and Office files preview locally.',
  },
  {
    t: 13.8, end: 22.8, pos: 'bl', accent: 'violet',
    kicker: 'Assistant',
    title: 'Ask about what’s on screen',
    body: 'The Bedrock assistant reads the current page — here the open PDF, attached straight from S3. Your account, your model.',
  },
  {
    t: 23.8, end: 31.8, pos: 'br', accent: 'amber',
    kicker: 'Metrics',
    title: 'Every metric in the stack, in one place',
    body: 'Browse by resource or by metric type, then add nine error series in one click.',
  },
  {
    t: 32.2, end: 35.2, pos: 'bl', accent: 'amber',
    kicker: 'Metrics',
    title: 'From spike to cause',
    body: 'Hover a datapoint, then open the logs behind that minute.',
  },
  {
    t: 36.0, end: 42.1, pos: 'bl', accent: 'red',
    kicker: 'Live logs',
    title: 'Tail without leaving the app',
    body: 'Any function in the stack, filtered server-side, landing on the first error in the window.',
  },
  {
    t: 44.6, end: 52.5, pos: 'bl', accent: 'cyan',
    kicker: 'Aurora DSQL',
    title: 'Read-only SQL editor',
    body: '51 tables discovered on the stack’s cluster. Every statement runs in a `READ ONLY` transaction that is always rolled back.',
  },
  {
    t: 52.8, end: 59.5, pos: 'bl', accent: 'violet',
    kicker: 'Assistant',
    title: 'Plain language in, SQL out',
    body: 'The assistant knows the schema and drafts the query. Nothing runs until you apply it.',
  },
  {
    t: 59.8, end: 65.2, pos: 'tr', accent: 'cyan',
    kicker: 'Aurora DSQL',
    title: 'Apply, then run it yourself',
    body: 'The draft lands in the editor so you can change it before it runs.',
  },
];
