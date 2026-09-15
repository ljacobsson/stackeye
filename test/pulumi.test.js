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

test('keeps Pulumi triggers that live in a resource of their own', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'stackeye-pulumi-triggers-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const urn = (type, name) => `urn:pulumi:production::example::${type}::${name}`;
  const tableUrn = urn('aws:dynamodb/table:Table', 'jobs'), functionUrn = urn('aws:lambda/function:Function', 'worker'), topicUrn = urn('aws:sns/topic:Topic', 'alerts');
  await fs.writeFile(path.join(cwd, 'export.json'), JSON.stringify({ deployment: { resources: [
    { urn: tableUrn, type: 'aws:dynamodb/table:Table', id: 'jobs-prod', outputs: { name: 'jobs-prod' } },
    { urn: functionUrn, type: 'aws:lambda/function:Function', id: 'worker-prod', outputs: { functionName: 'worker-prod' } },
    { urn: topicUrn, type: 'aws:sns/topic:Topic', id: 'alerts-prod', outputs: { arn: 'arn:aws:sns:eu-north-1:1:alerts-prod' } },
    { urn: urn('aws:lambda/eventSourceMapping:EventSourceMapping', 'stream'), type: 'aws:lambda/eventSourceMapping:EventSourceMapping', id: 'mapping',
      propertyDependencies: { eventSourceArn: [tableUrn], functionName: [functionUrn] } },
    { urn: urn('aws:sns/topicSubscription:TopicSubscription', 'alerts'), type: 'aws:sns/topicSubscription:TopicSubscription', id: 'subscription',
      propertyDependencies: { topic: [topicUrn], endpoint: [functionUrn] } }
  ] } }));
  const { edges } = (await discover({ cwd, pulumiState: 'export.json' })).architecture;
  assert.ok(edges.some((edge) => edge.source === 'jobs' && edge.target === 'worker' && edge.label === 'stream event'));
  assert.ok(edges.some((edge) => edge.source === 'alerts' && edge.target === 'worker' && edge.label === 'notifies'));
});
