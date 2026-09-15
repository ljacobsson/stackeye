import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';

const execute = promisify(execFile);

export class AmplifyHosting {
  constructor({ cwd, region, profile, client }) {
    this.client = client || new AmplifyApi({ region, credentials: profile ? fromIni({ profile }) : fromNodeProviderChain() });
    this.cwd = cwd;
    this.region = region;
  }

  async discover() {
    const project = await findGitHubProject(this.cwd);
    if (!project.repository) return undefined;
    return discoverAmplifyHosting({ client: this.client, region: this.region, ...project });
  }

  async deployments({ appId, branch, jobId }) {
    if (!appId || !branch) return { jobs: [], job: undefined, logs: [] };
    const page = await this.client.listJobs({ appId, branchName: branch, maxResults: 20 });
    const jobs = (page.jobSummaries || []).sort((a, b) => dateValue(b.startTime) - dateValue(a.startTime));
    const selected = jobs.find((job) => job.jobId === jobId) || jobs[0];
    if (!selected) return { jobs, job: undefined, logs: [] };
    const result = await this.client.getJob({ appId, branchName: branch, jobId: selected.jobId });
    const job = result.job;
    const logs = await Promise.all((job?.steps || []).map(async (step) => ({
      stepName: step.stepName,
      status: step.status,
      statusReason: step.statusReason,
      log: step.logUrl ? await readBuildLog(step.logUrl) : ''
    })));
    return { jobs, job, logs };
  }
}

export async function discoverAmplifyHosting({ client, region, repository, branch }) {
  const expected = normalizeGitHubRepository(repository);
  if (!expected) return undefined;
  const apps = await allPages((input) => client.listApps(input), 'apps', {});
  const matching = apps.filter((app) => normalizeGitHubRepository(app.repository) === expected);
  if (!matching.length) return undefined;

  const candidates = await Promise.all(matching.map(async (app) => ({
    app,
    branches: await allPages((input) => client.listBranches(input), 'branches', { appId: app.appId })
  })));
  candidates.sort((a, b) => Number(Boolean(branch && b.branches.some((item) => item.branchName === branch))) - Number(Boolean(branch && a.branches.some((item) => item.branchName === branch))) || dateValue(b.app.updateTime) - dateValue(a.app.updateTime));
  const selected = candidates[0], selectedBranch = chooseBranch(selected.branches, branch);
  let job;
  if (selectedBranch) {
    const page = await client.listJobs({ appId: selected.app.appId, branchName: selectedBranch.branchName, maxResults: 10 });
    job = (page.jobSummaries || []).sort((a, b) => dateValue(b.startTime) - dateValue(a.startTime))[0];
  }
  return {
    appId: selected.app.appId,
    appName: selected.app.name,
    repository: selected.app.repository,
    branch: selectedBranch?.branchName,
    status: job?.status || 'NO BUILDS',
    updatedAt: job?.endTime || job?.startTime || selectedBranch?.updateTime || selected.app.updateTime,
    url: amplifyConsoleUrl(region, selected.app.appId, selectedBranch?.branchName)
  };
}

export function normalizeGitHubRepository(value) {
  const match = String(value || '').trim().match(/^(?:(?:https?|ssh):\/\/(?:git@)?|git@)?github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}

export async function findGitHubProject(cwd) {
  const read = async (args) => {
    try { return (await execute('git', args, { cwd })).stdout.trim(); } catch { return ''; }
  };
  let repository = await read(['config', '--get', 'remote.origin.url']);
  if (!normalizeGitHubRepository(repository)) {
    const remotes = await read(['remote', '-v']);
    repository = remotes.split('\n').map((line) => line.trim().split(/\s+/)[1]).find(normalizeGitHubRepository) || '';
  }
  return { repository, branch: await read(['branch', '--show-current']) };
}

async function allPages(request, key, input) {
  const found = []; let nextToken;
  do {
    const page = await request({ ...input, nextToken });
    found.push(...(page[key] || [])); nextToken = page.nextToken;
  } while (nextToken);
  return found;
}

class AmplifyApi {
  constructor({ region, credentials }) {
    this.region = region;
    this.signer = new SignatureV4({ credentials, region, service: 'amplify', sha256: NodeSha256 });
  }
  listApps(input) { return this.get('/apps', input); }
  listBranches({ appId, ...input }) { return this.get(`/apps/${encodeURIComponent(appId)}/branches`, input); }
  listJobs({ appId, branchName, ...input }) { return this.get(`/apps/${encodeURIComponent(appId)}/branches/${encodeURIComponent(branchName)}/jobs`, input); }
  getJob({ appId, branchName, jobId }) { return this.get(`/apps/${encodeURIComponent(appId)}/branches/${encodeURIComponent(branchName)}/jobs/${encodeURIComponent(jobId)}`, {}); }
  async get(pathname, query) {
    const values = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    const hostname = `amplify.${this.region}.amazonaws.com`, url = new URL(`https://${hostname}${pathname}`);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    const request = await this.signer.sign({ method: 'GET', protocol: 'https:', hostname, path: pathname, query: values, headers: { host: hostname } });
    const response = await fetch(url, { headers: request.headers });
    const body = await response.json();
    if (!response.ok) { const error = new Error(body.message || body.Message || `Amplify request failed (${response.status})`); error.name = body.__type?.split('#').pop() || 'AmplifyError'; throw error; }
    return body;
  }
}

class NodeSha256 {
  constructor(secret) { this.hash = secret == null ? createHash('sha256') : createHmac('sha256', secret); }
  update(data, encoding) { this.hash.update(data, encoding); }
  digest() { return Promise.resolve(this.hash.digest()); }
}

async function readBuildLog(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(?:^|\.)amazonaws\.com(?:\.cn)?$/i.test(url.hostname)) throw new Error('Amplify returned an unsupported log URL');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Log request failed (${response.status})`);
    const reader = response.body?.getReader();
    if (!reader) return (await response.text()).slice(0, 2_000_000);
    const chunks = []; let length = 0;
    while (length < 2_000_000) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk); length += chunk.length;
    }
    if (length >= 2_000_000) await reader.cancel();
    return Buffer.concat(chunks).subarray(0, 2_000_000).toString('utf8');
  } catch (error) { return `Could not load this step's log: ${error.message}`; }
}

function chooseBranch(branches, current) {
  return branches.find((branch) => current && branch.branchName === current)
    || branches.find((branch) => branch.stage === 'PRODUCTION')
    || [...branches].sort((a, b) => dateValue(b.updateTime) - dateValue(a.updateTime))[0];
}
function dateValue(value) { return value ? new Date(value).getTime() || 0 : 0; }
function amplifyConsoleUrl(region, appId, branch) {
  const base = `https://${region}.console.aws.amazon.com/amplify/apps/${encodeURIComponent(appId)}`;
  return branch ? `${base}/branches/${encodeURIComponent(branch)}/deployments` : `${base}/overview`;
}
