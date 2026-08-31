#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`stackeye — local observability for one SAM or CDK stack

Usage: stackeye [options]
  --template <path>  SAM or CloudFormation template (auto-detected by default)
  --stack <name>     Deployed CloudFormation stack name
  --region <region>  AWS region
  --profile <name>   AWS shared-credentials profile
  --config <name>    samconfig.toml environment (SAM projects)
  --dsql-user <role> Aurora DSQL database role (default: admin)
  --port <number>    Local port (default: 4111)
  --no-open          Do not open a browser
  -h, --help         Show this help`);
  process.exit(0);
}

const { start } = await import('../src/server.js');

const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
async function chooseConfig(names) {
  if (!process.stdin.isTTY) throw new Error(`samconfig.toml has multiple environments (${names.join(', ')}). Pass --config <name>.`);
  console.log('\n  Multiple SAM configurations found:\n');
  names.forEach((name, index) => console.log(`    ${index + 1}) ${name}`));
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`\n  Select configuration [1-${names.length}]: `);
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || !names[index]) throw new Error('Invalid configuration selection');
    return names[index];
  } finally { terminal.close(); }
}

start({
  cwd: process.cwd(), template: value('--template'), stack: value('--stack'),
  region: value('--region'), profile: value('--profile'),
  configEnv: value('--config') || value('--config-env'), chooseConfig, dsqlUser: value('--dsql-user'),
  port: Number(value('--port') || process.env.PORT || 4111), open: !args.includes('--no-open')
}).catch((error) => { console.error(`\n  stackeye: ${error.message}\n`); process.exitCode = 1; });
