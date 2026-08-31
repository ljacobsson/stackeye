import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discover } from '../src/discovery.js';

async function cdkProject(stacks) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackeye-cdk-'));
  const out = path.join(root, 'cdk.out');
  await fs.mkdir(out);
  const artifacts = {};
  for (const [id, template] of Object.entries(stacks)) {
    const templateFile = `${id}.template.json`;
    artifacts[id] = { type: 'aws:cloudformation:stack', environment: 'aws://123456789012/eu-north-1', properties: { templateFile } };
    await fs.writeFile(path.join(out, templateFile), JSON.stringify(template));
  }
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify({ version: '36.0.0', artifacts }));
  return root;
}

test('discovers a CDK cloud assembly and native EventBridge target', async (t) => {
  const cwd = await cdkProject({ AppStack: { Resources: {
    Worker: { Type: 'AWS::Lambda::Function', Properties: {} },
    Schedule: { Type: 'AWS::Events::Rule', Properties: { ScheduleExpression: 'rate(5 minutes)', Targets: [{ Arn: { 'Fn::GetAtt': ['Worker', 'Arn'] }, Id: 'Worker' }] } }
  } } });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const found = await discover({ cwd });
  assert.equal(found.framework, 'cdk');
  assert.equal(found.stackName, 'AppStack');
  assert.equal(found.region, 'eu-north-1');
  assert.ok(found.architecture.edges.some((edge) => edge.source === 'Schedule' && edge.target === 'Worker' && edge.label === 'schedule'));
});

test('requires and honors stack selection for multi-stack CDK assemblies', async (t) => {
  const template = { Resources: { Bucket: { Type: 'AWS::S3::Bucket' } } };
  const cwd = await cdkProject({ FirstStack: template, SecondStack: template });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await assert.rejects(() => discover({ cwd }), /multiple stacks/);
  const found = await discover({ cwd, stack: 'SecondStack' });
  assert.equal(found.stackName, 'SecondStack');
  assert.match(found.templatePath, /SecondStack\.template\.json$/);
});
