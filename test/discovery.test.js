import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { discover } from '../src/discovery.js';

const execute = promisify(execFile);

test('allows a GitHub repository to continue as an Amplify-only project', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'stackeye-amplify-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await execute('git', ['init', cwd]);
  await execute('git', ['-C', cwd, 'remote', 'add', 'origin', 'git@github.com:acme/website.git']);
  const found = await discover({ cwd, profile: 'dev' });
  assert.equal(found.framework, 'amplify');
  assert.equal(found.stackName, path.basename(cwd));
  assert.deepEqual(found.deployedResources, []);
});

test('discovers supported AWS resources from Terraform state', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'stackeye-terraform-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, 'main.tf'), 'terraform {}');
  await fs.writeFile(path.join(cwd, 'terraform.tfstate'), JSON.stringify({ version: 4, lineage: 'test-workspace', resources: [
    { mode: 'managed', type: 'aws_lambda_function', name: 'worker', provider: 'provider[\"registry.terraform.io/hashicorp/aws\"]', instances: [{ attributes: { id: 'worker-prod', function_name: 'worker-prod' }, dependencies: ['aws_dynamodb_table.jobs'] }] },
    { mode: 'managed', type: 'aws_dynamodb_table', name: 'jobs', provider: 'provider[\"registry.terraform.io/hashicorp/aws\"]', instances: [{ attributes: { id: 'jobs-prod', name: 'jobs-prod' } }] },
    { mode: 'managed', type: 'random_id', name: 'suffix', provider: 'provider[\"registry.terraform.io/hashicorp/random\"]', instances: [{ attributes: { id: 'abc' } }] }
  ] }));
  const found = await discover({ cwd });
  assert.equal(found.framework, 'terraform');
  assert.equal(found.stackName, 'test-workspace');
  assert.deepEqual(found.deployedResources.map(({ logicalId, physicalId, type }) => ({ logicalId, physicalId, type })), [
    { logicalId: 'aws_lambda_function.worker', physicalId: 'worker-prod', type: 'AWS::Lambda::Function' },
    { logicalId: 'aws_dynamodb_table.jobs', physicalId: 'jobs-prod', type: 'AWS::DynamoDB::Table' }
  ]);
  assert.ok(found.architecture.edges.some((edge) => edge.source === 'aws_lambda_function.worker' && edge.target === 'aws_dynamodb_table.jobs'));
});

test('honors an explicit Terraform state path', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'stackeye-terraform-state-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, 'state'));
  await fs.writeFile(path.join(cwd, 'state', 'prod.tfstate'), JSON.stringify({ version: 4, resources: [
    { mode: 'managed', type: 'aws_s3_bucket', name: 'assets', provider: 'provider[\"registry.terraform.io/hashicorp/aws\"]', instances: [{ attributes: { id: 'company-assets' } }] }
  ] }));
  const found = await discover({ cwd, terraformState: 'state/prod.tfstate', stack: 'production' });
  assert.equal(found.stackName, 'production');
  assert.equal(found.deployedResources[0].physicalId, 'company-assets');
});

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

test('connects one Lambda to another when only the environment names it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackeye-sam-fanout-'));
  await fs.writeFile(path.join(root, 'template.yaml'), `Transform: AWS::Serverless-2016-10-31
Resources:
  Caller:
    Type: AWS::Serverless::Function
    Properties:
      Environment:
        Variables:
          WORKER: !Ref Worker
          FLOW: !Ref Flow
  Worker:
    Type: AWS::Serverless::Function
  Flow:
    Type: AWS::Serverless::StateMachine
    Properties:
      Definition:
        StartAt: Work
        States:
          Work:
            Type: Task
            Resource: !GetAtt Worker.Arn
            End: true
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref Table
  Table:
    Type: AWS::Serverless::SimpleTable
`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { edges } = (await discover({ cwd: root })).architecture;
  assert.ok(edges.some((edge) => edge.source === 'Caller' && edge.target === 'Worker' && edge.label === 'invokes'));
  assert.ok(edges.some((edge) => edge.source === 'Caller' && edge.target === 'Flow' && edge.label === 'starts execution'));
  assert.ok(edges.some((edge) => edge.source === 'Flow' && edge.target === 'Worker' && edge.label === 'invokes'));
  assert.ok(edges.some((edge) => edge.source === 'Flow' && edge.target === 'Table' && edge.label === 'uses'));
});

test('reads SAM connectors, dead letters and invoke destinations as outgoing traffic', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackeye-sam-connector-'));
  await fs.writeFile(path.join(root, 'template.yaml'), `Transform: AWS::Serverless-2016-10-31
Resources:
  Producer:
    Type: AWS::Serverless::Function
    Connectors:
      ToWorker:
        Properties:
          Destination:
            Id: Worker
          Permissions: [Write]
    Properties:
      DeadLetterQueue:
        Type: SQS
        TargetArn: !GetAtt Failures.Arn
      EventInvokeConfig:
        DestinationConfig:
          OnFailure:
            Type: SQS
            Destination: !GetAtt Failures.Arn
  Worker:
    Type: AWS::Serverless::Function
  Link:
    Type: AWS::Serverless::Connector
    Properties:
      Source:
        Id: Worker
      Destination:
        Id: Work
      Permissions: [Write]
  Work:
    Type: AWS::SQS::Queue
  Failures:
    Type: AWS::SQS::Queue
`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { edges } = (await discover({ cwd: root })).architecture;
  assert.ok(edges.some((edge) => edge.source === 'Producer' && edge.target === 'Worker' && edge.label === 'invokes'));
  assert.ok(edges.some((edge) => edge.source === 'Worker' && edge.target === 'Work' && edge.label === 'sends messages'));
  assert.ok(edges.some((edge) => edge.source === 'Producer' && edge.target === 'Failures' && edge.label === 'dead letters'));
  assert.ok(edges.some((edge) => edge.source === 'Producer' && edge.target === 'Failures' && edge.label === 'on failure'));
});

test('reads permissions granted through a managed policy and ignores denies', async (t) => {
  const cwd = await cdkProject({ AppStack: { Resources: {
    Worker: { Type: 'AWS::Lambda::Function', Properties: { Role: { 'Fn::GetAtt': ['WorkerRole', 'Arn'] } } },
    WorkerRole: { Type: 'AWS::IAM::Role', Properties: { ManagedPolicyArns: [{ Ref: 'WorkerPolicy' }] } },
    WorkerPolicy: { Type: 'AWS::IAM::ManagedPolicy', Properties: { PolicyDocument: { Statement: [
      { Effect: 'Allow', Action: ['sqs:SendMessage'], Resource: { 'Fn::GetAtt': ['Queue', 'Arn'] } },
      { Effect: 'Deny', Action: ['dynamodb:*'], Resource: { 'Fn::GetAtt': ['Table', 'Arn'] } }
    ] } } },
    Queue: { Type: 'AWS::SQS::Queue', Properties: {} },
    Table: { Type: 'AWS::DynamoDB::Table', Properties: {} }
  } } });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const { edges } = (await discover({ cwd })).architecture;
  assert.ok(edges.some((edge) => edge.source === 'Worker' && edge.target === 'Queue' && edge.label === 'sends messages'));
  assert.ok(!edges.some((edge) => edge.source === 'Worker' && edge.target === 'Table'));
});

test('routes a custom event bus through its rule and reads a Lambda permission as its trigger', async (t) => {
  const cwd = await cdkProject({ AppStack: { Resources: {
    Bus: { Type: 'AWS::Events::EventBus', Properties: { Name: 'app' } },
    Rule: { Type: 'AWS::Events::Rule', Properties: { EventBusName: { Ref: 'Bus' }, Targets: [{ Arn: { 'Fn::GetAtt': ['Worker', 'Arn'] } }] } },
    Worker: { Type: 'AWS::Lambda::Function', Properties: {} },
    Uploads: { Type: 'AWS::S3::Bucket', Properties: {} },
    UploadPermission: { Type: 'AWS::Lambda::Permission', Properties: {
      FunctionName: { Ref: 'Worker' }, Action: 'lambda:InvokeFunction', Principal: 's3.amazonaws.com', SourceArn: { 'Fn::GetAtt': ['Uploads', 'Arn'] }
    } }
  } } });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const { nodes, edges } = (await discover({ cwd })).architecture;
  assert.ok(nodes.some((node) => node.id === 'Bus' && node.type === 'AWS::Events::EventBus'));
  assert.ok(edges.some((edge) => edge.source === 'Bus' && edge.target === 'Rule' && edge.label === 'event bus'));
  assert.ok(edges.some((edge) => edge.source === 'Rule' && edge.target === 'Worker' && edge.label === 'event rule'));
  assert.ok(edges.some((edge) => edge.source === 'Uploads' && edge.target === 'Worker' && edge.label === 'object event'));
});

test('keeps Terraform triggers that live in a resource of their own', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'stackeye-terraform-triggers-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const managed = (type, name, attributes) => ({ mode: 'managed', type, name, provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [{ attributes }] });
  await fs.writeFile(path.join(cwd, 'main.tf'), 'terraform {}');
  await fs.writeFile(path.join(cwd, 'terraform.tfstate'), JSON.stringify({ version: 4, lineage: 'triggers', resources: [
    managed('aws_lambda_function', 'worker', { id: 'worker-prod', function_name: 'worker-prod', arn: 'arn:aws:lambda:eu-north-1:1:function:worker-prod' }),
    managed('aws_dynamodb_table', 'jobs', { id: 'jobs-prod', name: 'jobs-prod', arn: 'arn:aws:dynamodb:eu-north-1:1:table/jobs-prod' }),
    managed('aws_s3_bucket', 'uploads', { id: 'uploads-prod', bucket: 'uploads-prod', arn: 'arn:aws:s3:::uploads-prod' }),
    managed('aws_lambda_event_source_mapping', 'stream', { id: 'mapping', function_name: 'worker-prod', event_source_arn: 'arn:aws:dynamodb:eu-north-1:1:table/jobs-prod/stream/2026-01-01T00:00:00.000' }),
    managed('aws_lambda_permission', 'uploads', { id: 'permission', function_name: 'worker-prod', source_arn: 'arn:aws:s3:::uploads-prod' })
  ] }));
  const { edges } = (await discover({ cwd })).architecture;
  assert.ok(edges.some((edge) => edge.source === 'aws_dynamodb_table.jobs' && edge.target === 'aws_lambda_function.worker' && edge.label === 'stream event'));
  assert.ok(edges.some((edge) => edge.source === 'aws_s3_bucket.uploads' && edge.target === 'aws_lambda_function.worker' && edge.label === 'object event'));
});
