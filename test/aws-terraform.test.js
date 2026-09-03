import assert from 'node:assert/strict';
import test from 'node:test';
import { AwsData } from '../src/aws.js';

test('initializes Terraform resources without querying CloudFormation', async () => {
  const deployedResources = [{ logicalId: 'aws_lambda_function.worker', physicalId: 'worker-prod', type: 'AWS::Lambda::Function', status: 'MANAGED' }];
  const aws = new AwsData({ region: 'eu-north-1', stackName: 'production', templateResources: [], deployedResources });
  aws.sts = { send: async () => ({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/test' }) };
  aws.cf = { send: async () => { throw new Error('CloudFormation must not be queried'); } };
  const context = await aws.initialize();
  assert.equal(context.stack.name, 'production');
  assert.equal(context.stack.status, 'TERRAFORM MANAGED');
  assert.deepEqual(context.resources, deployedResources.map((resource) => ({ ...resource, updatedAt: undefined })));
});
