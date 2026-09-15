import assert from 'node:assert/strict';
import test from 'node:test';
import { AwsData } from '../src/aws.js';

const PARAMETER = { logicalId: 'ApiKey', physicalId: '/demo/api-key', type: 'AWS::SSM::Parameter' };

function stub(sends) {
  const aws = Object.create(AwsData.prototype);
  aws.resources = [PARAMETER];
  aws.calls = [];
  aws.ssm = { send: async (command) => { aws.calls.push(command); return sends(command); } };
  return aws;
}

const parameter = (over = {}) => ({ Parameter: { Name: '/demo/api-key', Value: 'live', Type: 'String', Version: 3, DataType: 'text', ARN: 'arn:param', LastModifiedDate: new Date('2026-02-03T10:00:00Z'), ...over } });
const historyOf = (...versions) => ({ Parameters: versions });

test('reads a decrypted value and takes its metadata from the newest version', async () => {
  const aws = stub((command) => command.constructor.name === 'GetParameterCommand' ? parameter() : historyOf(
    { Version: 2, Description: 'stale', Tier: 'Standard', LastModifiedDate: new Date('2026-01-01') },
    { Version: 3, Description: 'Key for the public API', Tier: 'Advanced', AllowedPattern: '^\\w+$', LastModifiedUser: 'arn:aws:iam::1:user/dev', LastModifiedDate: new Date('2026-02-03') }
  ));
  const read = await aws.readParameter(PARAMETER);
  assert.equal(aws.calls[0].input.WithDecryption, true);
  assert.equal(read.kind, 'ssm');
  assert.equal(read.value, 'live');
  assert.equal(read.version, 3);
  assert.equal(read.description, 'Key for the public API');
  assert.equal(read.tier, 'Advanced');
  assert.equal(read.encrypted, false);
  assert.equal(read.decrypted, true);
  assert.deepEqual(read.history.map((entry) => entry.version), [3, 2]);
});

test('keeps the parameter when a SecureString cannot be decrypted', async () => {
  const aws = stub((command) => {
    if (command.constructor.name !== 'GetParameterCommand') return historyOf({ Version: 1, Tier: 'Standard' });
    if (command.input.WithDecryption) throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    return parameter({ Value: 'AQICAHc=', Type: 'SecureString', Version: 1 });
  });
  const read = await aws.readParameter(PARAMETER);
  assert.equal(read.encrypted, true);
  assert.equal(read.decrypted, false);
  assert.equal(read.value, 'AQICAHc=');
});

test('reports a read failure that is not about decryption', async () => {
  const aws = stub(() => { throw Object.assign(new Error('Parameter not found'), { name: 'ParameterNotFound' }); });
  await assert.rejects(() => aws.readParameter(PARAMETER), /Parameter not found/);
});

test('survives a parameter whose history is not readable', async () => {
  const aws = stub((command) => { if (command.constructor.name !== 'GetParameterCommand') throw new Error('no history for you'); return parameter(); });
  const read = await aws.readParameter(PARAMETER);
  assert.deepEqual(read.history, []);
  assert.equal(read.tier, 'Standard');
});

test('overwrites the deployed value and returns the version it wrote', async () => {
  const aws = stub((command) => command.constructor.name === 'GetParameterCommand' ? parameter({ Value: 'next', Version: 4 }) : historyOf({ Version: 4, Tier: 'Standard' }));
  const saved = await aws.putParameter({ resourceName: 'ApiKey', value: 'next' });
  const put = aws.calls.find((command) => command.constructor.name === 'PutParameterCommand');
  assert.deepEqual({ ...put.input }, { Name: '/demo/api-key', Value: 'next', Overwrite: true });
  assert.equal(saved.value, 'next');
  assert.equal(saved.version, 4);
});

test('refuses a write that is not a value, or a parameter outside the stack', async () => {
  const aws = stub(() => parameter());
  await assert.rejects(() => aws.putParameter({ resourceName: 'ApiKey', value: '' }), /empty parameter value/);
  await assert.rejects(() => aws.putParameter({ resourceName: 'ApiKey', value: { nested: true } }), /must be a string/);
  await assert.rejects(() => aws.putParameter({ resourceName: 'Invented', value: 'x' }), /Unknown Parameter resource/);
  assert.equal(aws.calls.length, 0, 'nothing may reach Systems Manager');
});
