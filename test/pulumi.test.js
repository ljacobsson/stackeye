import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discover } from '../src/discovery.js';

test('discovers classic and AWS Native resources from a Pulumi stack export', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'stackeye-pulumi-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, 'Pulumi.yaml'), 'name: example\nruntime: nodejs\n');
  const tableUrn = 'urn:pulumi:production::example::aws:dynamodb/table:Table::jobs';
  const functionUrn = 'urn:pulumi:production::example::aws:lambda/function:Function::worker';
  await fs.writeFile(path.join(cwd, 'export.json'), JSON.stringify({ deployment: { resources: [
    { urn: 'urn:pulumi:production::example::pulumi:pulumi:Stack::example-production', type: 'pulumi:pulumi:Stack' },
    { urn: 'urn:pulumi:production::example::pulumi:providers:aws::default', type: 'pulumi:providers:aws', outputs: { region: 'eu-north-1' } },
    { urn: tableUrn, type: 'aws:dynamodb/table:Table', id: 'jobs-prod', outputs: { name: 'jobs-prod' } },
    { urn: functionUrn, type: 'aws:lambda/function:Function', id: 'worker-prod', outputs: { functionName: 'worker-prod' }, propertyDependencies: { environment: [tableUrn] } },
    { urn: 'urn:pulumi:production::example::aws-native:s3:Bucket::assets', type: 'aws-native:s3:Bucket', id: 'assets-id', outputs: { bucketName: 'company-assets' } }
  ] } }));
  const found = await discover({ cwd, pulumiState: 'export.json' });
  assert.equal(found.framework, 'pulumi');
  assert.equal(found.stackName, 'production');
  assert.equal(found.region, 'eu-north-1');
  assert.deepEqual(found.deployedResources.map(({ logicalId, physicalId, type }) => ({ logicalId, physicalId, type })), [
    { logicalId: 'jobs', physicalId: 'jobs-prod', type: 'AWS::DynamoDB::Table' },
    { logicalId: 'worker', physicalId: 'worker-prod', type: 'AWS::Lambda::Function' },
    { logicalId: 'assets', physicalId: 'company-assets', type: 'AWS::S3::Bucket' }
  ]);
  assert.ok(found.architecture.edges.some((edge) => edge.source === 'worker' && edge.target === 'jobs'));
});

test('reports an invalid explicit Pulumi export clearly', async () => {
  await assert.rejects(() => discover({ cwd: '/tmp', pulumiState: 'missing-stackeye-export.json' }), /Pulumi stack export not found or invalid/);
});
