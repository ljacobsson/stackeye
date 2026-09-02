/*
 * StackEye annotated demo — closing screen.
 *
 * The outro is a full 1920x1080 animated card that plays after the footage
 * ends. Like overlays.js this is the single source of truth: the preview player
 * and the mp4 renderer both animate from the same timeline function, so what
 * you see in the browser is what gets rendered.
 *
 * duration  seconds of outro appended to the video
 * badge     dashed pill after the headline; omit it to drop the pill
 * tiles     one per AWS service, `icon` is a file in public/icons/
 * chips     the three cross-cutting capabilities under the grid
 * trust     the credential-chain band above the footer
 *
 * Tiles fade in staggered, then a slow highlight sweeps across them. Adding or
 * removing a tile re-times the sweep automatically, but keep the count a
 * multiple of five so the grid stays even.
 */

window.OUTRO = {
  duration: 10,

  title: 'Ten AWS services, one local app',
  badge: 'more on the way',
  subtitle: 'Discovered from your SAM template or CDK cloud assembly. Nothing to wire up, nothing to deploy.',

  tiles: [
    { icon: 'lambda', name: 'Lambda', text: 'Metrics, log tails, and test invocations with saved payloads' },
    { icon: 'api-gateway', name: 'API Gateway', text: 'Deployed routes, request volume, 4XX/5XX, and latency' },
    { icon: 'dynamodb', name: 'DynamoDB', text: 'Schema-aware scan, query, and conditional update builders' },
    { icon: 'aurora', name: 'Aurora DSQL', text: 'Read-only SQL editor, schema browser, and ER diagrams' },
    { icon: 's3', name: 'S3', text: 'Folder browsing, bucket-wide search, and local previews' },
    { icon: 'step-functions', name: 'Step Functions', text: 'The deployed definition as a graph, plus single-state tests' },
    { icon: 'sqs', name: 'SQS', text: 'Queue attributes and a peek at the next ten messages' },
    { icon: 'sns', name: 'SNS', text: 'Topic attributes and every subscription' },
    { icon: 'eventbridge', name: 'EventBridge', text: 'Rule pattern, targets, and dry-run event matching' },
    { icon: 'cognito', name: 'Cognito', text: 'Search a user pool and inspect individual users' },
  ],

  chips: [
    { accent: 'amber', label: 'CloudWatch metrics', text: 'Every metric in the stack, chartable' },
    { accent: 'red', label: 'Live logs', text: 'Server-side filtered tailing' },
    { accent: 'violet', label: 'Bedrock assistant', text: 'Page-aware, in your own account' },
  ],

  trust: {
    label: 'Your credentials never leave your machine',
    text: 'Every call is signed with your own AWS profile, SSO session, or role from the standard credential chain. There is no account to create, no keys to paste, no third-party service in the path — and the server binds to localhost only.',
  },

  command: 'npx stackeye',
  link: 'github.com/ljacobsson/stackeye',
};
