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

test('discovers Lambda calls from execution-role permissions and environment variables', async (t) => {
  const cwd = await cdkProject({ AppStack: { Resources: {
    Caller: { Type: 'AWS::Lambda::Function', Properties: {
      Role: { 'Fn::GetAtt': ['CallerRole', 'Arn'] },
      Environment: { Variables: { TABLE_NAME: { Ref: 'Table' }, WORKER_ARN: { 'Fn::GetAtt': ['Worker', 'Arn'] } } }
    } },
    Worker: { Type: 'AWS::Lambda::Function', Properties: {} },
    Table: { Type: 'AWS::DynamoDB::Table', Properties: {} },
    CallerRole: { Type: 'AWS::IAM::Role', Properties: { Policies: [{ PolicyDocument: { Statement: [
      { Action: 'lambda:InvokeFunction', Resource: { 'Fn::GetAtt': ['Worker', 'Arn'] } },
      { Action: ['dynamodb:GetItem'], Resource: { 'Fn::Sub': '${Table.Arn}/index/*' } }
    ] } }] } }
  } } });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const found = await discover({ cwd });
  assert.ok(found.architecture.edges.some((edge) => edge.source === 'Caller' && edge.target === 'Worker' && edge.label === 'invokes'));
  assert.ok(found.architecture.edges.some((edge) => edge.source === 'Caller' && edge.target === 'Table' && edge.label === 'uses'));
});

test('draws DynamoDB event source mappings toward the invoked Lambda', async (t) => {
  const cwd = await cdkProject({ AppStack: { Resources: {
    Worker: { Type: 'AWS::Lambda::Function', Properties: {} },
    Table: { Type: 'AWS::DynamoDB::Table', Properties: { StreamSpecification: { StreamViewType: 'NEW_IMAGE' } } },
    Mapping: { Type: 'AWS::Lambda::EventSourceMapping', Properties: {
      FunctionName: { Ref: 'Worker' }, EventSourceArn: { 'Fn::GetAtt': ['Table', 'StreamArn'] }
    } }
  } } });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const found = await discover({ cwd });
  assert.ok(found.architecture.edges.some((edge) => edge.source === 'Table' && edge.target === 'Worker' && edge.label === 'stream event'));
});

test('discovers SAM policy-template dependencies without reversing DynamoDB triggers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackeye-sam-'));
  await fs.writeFile(path.join(root, 'template.yaml'), `Transform: AWS::Serverless-2016-10-31
Resources:
  Table:
    Type: AWS::DynamoDB::Table
  Worker:
    Type: AWS::Serverless::Function
    Properties:
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref Table
      Events:
        Changes:
          Type: DynamoDB
          Properties:
            Stream: !GetAtt Table.StreamArn
`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const found = await discover({ cwd: root });
  assert.ok(found.architecture.edges.some((edge) => edge.source === 'Table' && edge.target === 'Worker' && edge.label === 'stream event'));
  assert.ok(found.architecture.edges.some((edge) => edge.source === 'Worker' && edge.target === 'Table' && edge.label === 'uses'));
});

test('discovers a SAM function sending to an SQS queue from env and policy references', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackeye-sam-sqs-'));
  await fs.writeFile(path.join(root, 'template.yaml'), `Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Environment:
      Variables:
        SHARED_QUEUE_URL: !Ref PimJobQueue
Resources:
  PimContext:
    Type: AWS::Serverless::Function
    Properties:
      Environment:
        Variables:
          PIM_JOB_QUEUE_URL: !Ref PimJobQueue
      Policies:
        - SQSSendMessagePolicy:
            QueueName: !GetAtt PimJobQueue.QueueName
  PimJobQueue:
    Type: AWS::SQS::Queue
    Properties:
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt PimJobDLQ.Arn
        maxReceiveCount: 5
  PimJobDLQ:
    Type: AWS::SQS::Queue
`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const found = await discover({ cwd: root });
  const links = found.architecture.edges.filter((edge) => edge.source === 'PimContext' && edge.target === 'PimJobQueue');
  assert.deepEqual(links, [{ source: 'PimContext', target: 'PimJobQueue', label: 'sends messages' }]);
  assert.ok(found.architecture.edges.some((edge) => edge.source === 'PimJobQueue' && edge.target === 'PimJobDLQ' && edge.label === 'dead letters'));
});

test('collapses SAM implicit API routes into one API Gateway node', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackeye-sam-api-'));
  await fs.writeFile(path.join(root, 'template.yaml'), `Transform: AWS::Serverless-2016-10-31
Resources:
  FirstFunction:
    Type: AWS::Serverless::Function
    Properties:
      Events:
        FirstRoute:
          Type: Api
          Properties: { Path: /first, Method: GET }
  SecondFunction:
    Type: AWS::Serverless::Function
    Properties:
      Events:
        SecondRoute:
          Type: Api
          Properties: { Path: /second, Method: POST }
`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const found = await discover({ cwd: root });
  const apis = found.architecture.nodes.filter((node) => node.type === 'AWS::ApiGateway::RestApi');
  assert.deepEqual(apis.map((node) => node.id), ['ServerlessRestApi']);
  assert.equal(found.architecture.edges.filter((edge) => edge.source === 'ServerlessRestApi').length, 2);
});

test('shows Step Functions invoking Lambdas from definitions and role permissions', async (t) => {
  const cwd = await cdkProject({ AppStack: { Resources: {
    StartJob: { Type: 'AWS::Lambda::Function', Properties: {} },
    FinishJob: { Type: 'AWS::Lambda::Function', Properties: {} },
    WorkflowRole: { Type: 'AWS::IAM::Role', Properties: { Policies: [{ PolicyDocument: { Statement: [{
      Action: 'lambda:InvokeFunction', Resource: { 'Fn::GetAtt': ['FinishJob', 'Arn'] }
    }] } }] } },
    Workflow: { Type: 'AWS::StepFunctions::StateMachine', Properties: {
      RoleArn: { 'Fn::GetAtt': ['WorkflowRole', 'Arn'] },
      DefinitionString: { 'Fn::Sub': ['{"StartAt":"Start","States":{"Start":{"Type":"Task","Resource":"${StartJob.Arn}","End":true}}}', {}] }
    } }
  } } });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const found = await discover({ cwd });
  assert.ok(found.architecture.nodes.some((node) => node.id === 'Workflow' && node.type === 'AWS::StepFunctions::StateMachine'));
  assert.ok(found.architecture.edges.some((edge) => edge.source === 'Workflow' && edge.target === 'StartJob' && edge.label === 'invokes'));
  assert.ok(found.architecture.edges.some((edge) => edge.source === 'Workflow' && edge.target === 'FinishJob' && edge.label === 'invokes'));
});
