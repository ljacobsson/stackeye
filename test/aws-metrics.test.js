import assert from 'node:assert/strict';
import test from 'node:test';
import { AwsData } from '../src/aws.js';

test('metric catalog retains only identities attached to stack resources', async () => {
  const aws = Object.create(AwsData.prototype);
  aws.resources = [{ logicalId: 'Worker', physicalId: 'deployed-worker', type: 'AWS::Lambda::Function' }];
  aws.cw = { send: async (command) => {
    assert.equal(command.input.Namespace, 'AWS/Lambda');
    return { Metrics: [
      { Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [{ Name: 'FunctionName', Value: 'deployed-worker' }] },
      { Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [{ Name: 'FunctionName', Value: 'deployed-worker' }, { Name: 'Resource', Value: 'deployed-worker:live' }] },
      { Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value: 'some-other-function' }] }
    ] };
  } };
  const rows = await aws.metricCatalog();
  assert.deepEqual(rows.map((row) => [row.resource, row.metric]), [['Worker', 'Invocations']]);
});

test('metric queries reject identities outside the stack catalog', async () => {
  const aws = Object.create(AwsData.prototype);
  aws.metricCatalog = async () => [{ id: 'allowed', resource: 'Worker', namespace: 'AWS/Lambda', metric: 'Invocations', dimensions: [] }];
  await assert.rejects(() => aws.browseMetrics({ ids: ['invented'] }), /current stack/);
  await assert.rejects(() => aws.browseMetrics({ ids: ['allowed'], stat: 'NotAStatistic' }), /Unsupported/);
});

test('log drill-down constrains CloudWatch Logs to the selected metric period', async () => {
  const aws = Object.create(AwsData.prototype);
  aws.resources = [{ logicalId: 'Worker', physicalId: 'deployed-worker', type: 'AWS::Lambda::Function' }];
  aws.logs = { send: async (command) => {
    assert.equal(command.input.logGroupName, '/aws/lambda/deployed-worker');
    assert.equal(command.input.startTime, 1_000);
    assert.equal(command.input.endTime, 61_000);
    return { events: [] };
  } };
  await aws.logEvents({ functionName: 'Worker', startTime: '1000', endTime: '61000' });
});

test('bounded log drill-down reads every FilterLogEvents page across streams', async () => {
  const aws = Object.create(AwsData.prototype); let calls = 0;
  aws.resources = [{ logicalId: 'Worker', physicalId: 'deployed-worker', type: 'AWS::Lambda::Function' }];
  aws.logs = { send: async (command) => {
    calls += 1;
    if (command.input.filterPattern) {
      assert.match(command.input.filterPattern, /ERROR/);
      return { events: [{ eventId: 'failure', timestamp: 3, message: '[ERROR] failed', logStreamName: 'stream-c' }] };
    }
    if (!command.input.nextToken) return { events: [{ eventId: 'one', timestamp: 1, message: 'ERROR one', logStreamName: 'stream-a' }], nextToken: 'page-2' };
    assert.equal(command.input.nextToken, 'page-2');
    return { events: [{ eventId: 'two', timestamp: 2, message: 'ERROR two', logStreamName: 'stream-b' }] };
  } };
  const result = await aws.logEvents({ functionName: 'Worker', startTime: '1000', endTime: '61000' });
  assert.equal(calls, 3);
  assert.deepEqual(result.events.map((event) => event.stream), ['stream-a', 'stream-b', 'stream-c']);
});
