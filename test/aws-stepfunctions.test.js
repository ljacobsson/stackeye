import assert from 'node:assert/strict';
import test from 'node:test';
import { AwsData } from '../src/aws.js';

test('tests only the selected deployed Step Functions state', async () => {
  const aws = Object.create(AwsData.prototype);
  aws.resources = [{ logicalId: 'Workflow', physicalId: 'arn:aws:states:eu-north-1:123:stateMachine:workflow', type: 'AWS::StepFunctions::StateMachine' }];
  const calls = [];
  aws.stepFunctions = { send: async (command) => {
    const operation = command.constructor.name.replace(/Command$/, ''); calls.push({ operation, input: command.input });
    if (operation === 'DescribeStateMachine') return {
      roleArn: 'arn:aws:iam::123:role/workflow',
      definition: JSON.stringify({ StartAt: 'First', States: { First: { Type: 'Pass', Next: 'Second' }, Second: { Type: 'Succeed' } } })
    };
    return { output: '{"ok":true}' };
  } };

  const result = await aws.testState({ resourceName: 'Workflow', stateName: 'First', input: '{"id":42}', inspectionLevel: 'TRACE' });
  assert.equal(result.output, '{"ok":true}');
  assert.deepEqual(calls[1], { operation: 'TestState', input: {
    definition: '{"Type":"Pass","Next":"Second"}', input: '{"id":42}', inspectionLevel: 'TRACE', roleArn: 'arn:aws:iam::123:role/workflow'
  } });
});

test('rejects unknown states and malformed test input before calling TestState', async () => {
  const aws = Object.create(AwsData.prototype);
  aws.resources = [{ logicalId: 'Workflow', physicalId: 'workflow-arn', type: 'AWS::StepFunctions::StateMachine' }];
  aws.stepFunctions = { send: async (command) => command.constructor.name === 'DescribeStateMachineCommand'
    ? { roleArn: 'role-arn', definition: '{"States":{"Only":{"Type":"Succeed"}}}' }
    : assert.fail('TestState should not have been called') };
  await assert.rejects(() => aws.testState({ resourceName: 'Workflow', stateName: 'Missing', input: '{}' }), /was not found/);
  await assert.rejects(() => aws.testState({ resourceName: 'Workflow', stateName: 'Only', input: '{' }), /valid JSON/);
});
