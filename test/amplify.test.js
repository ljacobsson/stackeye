import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverAmplifyHosting, normalizeGitHubRepository } from '../src/amplify.js';
import { AmplifyHosting } from '../src/amplify.js';

test('normalizes common GitHub remote and Amplify repository URLs', () => {
  assert.equal(normalizeGitHubRepository('git@github.com:OpenAI/stackeye.git'), 'openai/stackeye');
  assert.equal(normalizeGitHubRepository('ssh://git@github.com/OpenAI/stackeye.git'), 'openai/stackeye');
  assert.equal(normalizeGitHubRepository('https://github.com/OpenAI/stackeye'), 'openai/stackeye');
  assert.equal(normalizeGitHubRepository('https://gitlab.com/OpenAI/stackeye.git'), undefined);
});

test('finds the Amplify app connected to the project repo and reports the current branch build', async () => {
  const calls = [];
  const client = {
    listApps: async (input) => { calls.push(['listApps', input]); return { apps: [
      { appId: 'other', name: 'Other', repository: 'https://github.com/acme/other' },
      { appId: 'matched', name: 'Web', repository: 'https://github.com/Acme/Web.git' }
    ] }; },
    listBranches: async (input) => { calls.push(['listBranches', input]); return { branches: [
      { branchName: 'main', stage: 'PRODUCTION', updateTime: new Date('2026-01-01') },
      { branchName: 'feature/menu', stage: 'DEVELOPMENT', updateTime: new Date('2026-02-01') }
    ] }; },
    listJobs: async (input) => { calls.push(['listJobs', input]); return { jobSummaries: [
      { jobId: '1', status: 'SUCCEED', startTime: new Date('2026-02-01') },
      { jobId: '2', status: 'RUNNING', startTime: new Date('2026-02-02') }
    ] }; }
  };
  const hosting = await discoverAmplifyHosting({ client, region: 'eu-north-1', repository: 'git@github.com:acme/web.git', branch: 'feature/menu' });
  assert.equal(hosting.appId, 'matched');
  assert.equal(hosting.branch, 'feature/menu');
  assert.equal(hosting.status, 'RUNNING');
  assert.equal(hosting.url, 'https://eu-north-1.console.aws.amazon.com/amplify/apps/matched/branches/feature%2Fmenu/deployments');
  assert.equal(calls.at(-1)[1].maxResults, 10);
});

test('omits Amplify hosting when no app is connected to the GitHub repository', async () => {
  const client = { listApps: async () => ({ apps: [{ appId: 'other', repository: 'https://github.com/acme/other' }] }) };
  assert.equal(await discoverAmplifyHosting({ client, region: 'us-east-1', repository: 'https://github.com/acme/web.git', branch: 'main' }), undefined);
});

test('loads a selected deployment and its build steps', async () => {
  const client = {
    listJobs: async () => ({ jobSummaries: [
      { jobId: '2', status: 'SUCCEED', startTime: new Date('2026-02-02') },
      { jobId: '1', status: 'FAILED', startTime: new Date('2026-02-01') }
    ] }),
    getJob: async (input) => ({ job: { summary: { jobId: input.jobId, status: 'FAILED' }, steps: [{ stepName: 'BUILD', status: 'FAILED', statusReason: 'npm test failed' }] } })
  };
  const hosting = new AmplifyHosting({ cwd: '.', region: 'eu-north-1', client });
  const result = await hosting.deployments({ appId: 'app', branch: 'main', jobId: '1' });
  assert.equal(result.job.summary.jobId, '1');
  assert.deepEqual(result.logs, [{ stepName: 'BUILD', status: 'FAILED', statusReason: 'npm test failed', log: '' }]);
});
