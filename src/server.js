import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { discover } from './discovery.js';
import { AwsData } from './aws.js';
import { PayloadStore } from './payloads.js';
import { BedrockAssistant } from './bedrock.js';
import { previewOffice } from './office.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

export async function start(options) {
  const initialWorkspace = await createWorkspace(options);
  const workspaces = new Map([[initialWorkspace.id, initialWorkspace]]);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/workspaces' && req.method === 'GET') return json(res, workspaceList(workspaces));
      if (url.pathname === '/api/workspaces' && req.method === 'POST') {
        if (req.headers['x-stackeye-request'] !== '1') return json(res, { error: 'Invalid local request' }, 403);
        const requested = await createWorkspace(await readJson(req));
        const existing = workspaces.get(requested.id); workspaces.set(requested.id, existing || requested);
        return json(res, { id: requested.id, reused: Boolean(existing) });
      }
      const workspace = workspaces.get(url.searchParams.get('workspace')) || initialWorkspace;
      const { aws, payloads, assistant, context } = workspace;
      if (url.pathname === '/api/context') return json(res, { ...context, workspaceId: workspace.id, workspaces: workspaceList(workspaces) });
      if (url.pathname === '/api/metrics') return json(res, await aws.metrics(Number(url.searchParams.get('minutes') || 60), Number(url.searchParams.get('period') || 60)));
      if (url.pathname === '/api/metrics/catalog') return json(res, { metrics: await aws.metricCatalog(url.searchParams.get('refresh') === '1') });
      if (url.pathname === '/api/bedrock/models') return json(res, assistant.listModels());
      if (url.pathname === '/api/logs') return json(res, await aws.logEvents(Object.fromEntries(url.searchParams)));
      if (url.pathname === '/api/lambda/event-sources') return json(res, await aws.eventSourceMappings(Object.fromEntries(url.searchParams)));
      if (url.pathname === '/api/resource') return json(res, await aws.readResource(Object.fromEntries(url.searchParams)));
      if (url.pathname === '/api/cognito/users') return json(res, await aws.searchCognitoUsers(Object.fromEntries(url.searchParams)));
      if (url.pathname === '/api/payloads' && req.method === 'GET') return json(res, await payloads.all());
      if (url.pathname === '/api/s3/list') return json(res, await aws.listBucket(Object.fromEntries(url.searchParams)));
      if (url.pathname === '/api/s3/search') return json(res, await aws.searchBucket(Object.fromEntries(url.searchParams)));
      if (url.pathname === '/api/s3/object' || url.pathname === '/api/s3/office') {
        const input = Object.fromEntries(url.searchParams); if (!input.key) throw new Error('An object key is required');
        const object = await aws.getBucketObject(input);
        if (url.pathname.endsWith('/office')) return json(res, { text: previewOffice(object.buffer, path.extname(input.key).toLowerCase()), ...objectMetadata(object) });
        return sendObject(res, url, object, input.key);
      }
      if (url.pathname === '/api/s3/archive/list') return json(res, await aws.listArchive(archiveInput(url)));
      if (url.pathname === '/api/s3/archive/object' || url.pathname === '/api/s3/archive/office') {
        const input = archiveInput(url); if (!input.entryPath) throw new Error('An archive entry path is required');
        const entry = await aws.getArchiveEntry(input);
        if (url.pathname.endsWith('/office')) return json(res, { text: previewOffice(entry.buffer, path.extname(input.entryPath).toLowerCase()), ...objectMetadata(entry) });
        return sendObject(res, url, entry, input.entryPath);
      }
      if (url.pathname.startsWith('/api/') && req.method === 'POST') {
        if (req.headers['x-stackeye-request'] !== '1') return json(res, { error: 'Invalid local request' }, 403);
        const body = await readJson(req);
        if (url.pathname === '/api/payloads/save') return json(res, await payloads.save(body));
        if (url.pathname === '/api/bedrock/converse') return json(res, await assistant.converse(body, aws));
        if (url.pathname === '/api/payloads/delete') return json(res, await payloads.remove(body));
        if (url.pathname === '/api/lambda/invoke') return json(res, await aws.invoke(body));
        if (url.pathname === '/api/lambda/force-cold-start') return json(res, await aws.forceColdStart(body));
        if (url.pathname === '/api/dynamodb/describe') return json(res, await aws.describeTable(body));
        if (url.pathname === '/api/dynamodb/scan') return json(res, simplifyDynamo(await aws.scanTable(body)));
        if (url.pathname === '/api/dynamodb/query') return json(res, simplifyDynamo(await aws.queryTable(body)));
        if (url.pathname === '/api/dynamodb/update') return json(res, simplifyDynamo(await aws.updateTableItem(body)));
        if (url.pathname === '/api/dsql/schema') return json(res, await aws.dsqlSchema(body));
        if (url.pathname === '/api/dsql/query') return json(res, await aws.dsqlQuery(body));
        if (url.pathname === '/api/api-gateway/invoke') return json(res, await aws.invokeApi(body));
        if (url.pathname === '/api/eventbridge/test-pattern') return json(res, await aws.testEventPattern(body));
        if (url.pathname === '/api/step-functions/test-state') return json(res, await aws.testState(body));
        if (url.pathname === '/api/metrics/query') return json(res, { series: await aws.browseMetrics(body) });
      }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'worms.js', 'style.css', 'dashboard.css', 'metrics.css', 'worms.css', 'workbench.css', 'query.css', 's3.css', 'dsql.css', 'dsql-erd.css', 'step-functions.css', 'icons.css', 'resource-nav.css', 'architecture.css', 'architecture-routing.css', 'architecture-focus.css', 'workspaces.css', 'assistant.css', 'brand.css', 'stackeye-logo.png', 'favicon.png'].includes(name) && !/^icons\/[a-z0-9-]+\.svg$/.test(name)) return json(res, { error: 'Not found' }, 404);
      const body = await fs.readFile(path.join(root, 'public', name));
      res.writeHead(200, { 'content-type': mime[path.extname(name)], 'cache-control': 'no-store' }); res.end(body);
    } catch (error) { json(res, { error: error.message }, error.name === 'ResourceNotFoundException' ? 404 : 500); }
  });
  try { await new Promise((resolve, reject) => server.listen(options.port, '127.0.0.1', resolve).once('error', reject)); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const joined = await registerWithRunningServer(options.port, { ...options, configEnv: initialWorkspace.context.configEnv });
    if (!joined) throw error;
    const address = `http://127.0.0.1:${options.port}/?workspace=${encodeURIComponent(joined.id)}`;
    console.log(`\n  stackeye  ${initialWorkspace.context.stack.name}\n  Reused local server · ${address}\n`);
    if (options.open) openBrowser(address);
    return;
  }
  const address = `http://127.0.0.1:${options.port}`;
  console.log(`\n  stackeye  ${initialWorkspace.context.stack.name}\n  ${address}\n  ${initialWorkspace.context.region || 'default AWS region'}${initialWorkspace.context.profile ? ` · profile ${initialWorkspace.context.profile}` : ''}${initialWorkspace.context.configEnv ? ` · config ${initialWorkspace.context.configEnv}` : ''} · ${initialWorkspace.context.resources.length} resources\n`);
  if (options.open) openBrowser(address);
  const stop = () => server.close(() => process.exit(0)); process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

function json(res, value, status = 200) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value, jsonReplacer)); }
async function createWorkspace(options) {
  const found = await discover(options);
  const profile = options.profile || found.profile;
  const aws = new AwsData({ region: found.region, profile, stackName: found.stackName, templateResources: found.resources, deployedResources: found.deployedResources, dsqlUser: options.dsqlUser });
  let snapshot;
  try { snapshot = await aws.initialize(); }
  catch (error) {
    const loginHint = profile && isAuthenticationError(error) ? ` Run “aws sso login --profile ${profile}” and try again.` : '';
    throw new Error(`Could not load stack “${found.stackName}”${found.region ? ` in ${found.region}` : ''}${profile ? ` using profile “${profile}”` : ''}: ${error.message}.${loginHint}`);
  }
  const id = workspaceId(found, profile);
  return { id, aws, payloads: new PayloadStore(options.cwd), assistant: new BedrockAssistant({ region: found.region, profile }), context: { ...snapshot, region: found.region, profile, configEnv: found.configEnv, framework: found.framework, templatePath: found.templatePath, architecture: found.architecture } };
}
function workspaceId(found, profile) { return `${found.stackName}|${found.region || ''}|${profile || ''}`; }
function workspaceList(workspaces) { return [...workspaces.values()].map(({ id, context }) => ({ id, name: context.stack.name, region: context.region, profile: context.profile, status: context.stack.status })); }
async function registerWithRunningServer(port, options) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stackeye-request': '1' }, body: JSON.stringify({ cwd: options.cwd, template: options.template, terraformState: options.terraformState, pulumiState: options.pulumiState, stack: options.stack, region: options.region, profile: options.profile, configEnv: options.configEnv, dsqlUser: options.dsqlUser }), signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : undefined;
  } catch { return undefined; }
}
function jsonReplacer(_key, value) {
  if (value instanceof Set) return [...value];
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}
async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) throw new Error('Request body is too large'); }
  try { return JSON.parse(body || '{}'); } catch { throw new Error('Request body must be valid JSON'); }
}
function simplifyDynamo(result) { return { items: result.Items || [], attributes: result.Attributes, count: result.Count, scannedCount: result.ScannedCount, lastEvaluatedKey: result.LastEvaluatedKey }; }
function objectMetadata(object) { return { contentType: object.contentType, length: object.length, modified: object.modified, etag: object.etag }; }
// Nested archives arrive as repeated `archive` params, which Object.fromEntries would collapse to the last hop.
function archiveInput(url) { return { ...Object.fromEntries(url.searchParams), trail: url.searchParams.getAll('archive') }; }
function sendObject(res, url, object, name) {
  const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
  res.writeHead(200, { 'content-type': object.contentType, 'content-length': object.buffer.length, 'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(path.basename(name))}`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
  res.end(object.buffer);
}
function isAuthenticationError(error) {
  const message = String(error?.message || error);
  return /token|credentials|sso|login|unauthorized|expired/i.test(message);
}
function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(command, args, { windowsHide: true }, () => {});
}
