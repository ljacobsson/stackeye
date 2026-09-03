import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const types = {
  'aws:lambda/function:Function': ['AWS::Lambda::Function', ['functionName', 'name', 'arn']],
  'aws-native:lambda:Function': ['AWS::Lambda::Function', ['functionName', 'arn']],
  'aws:dynamodb/table:Table': ['AWS::DynamoDB::Table', ['name', 'arn']],
  'aws-native:dynamodb:Table': ['AWS::DynamoDB::Table', ['tableName', 'arn']],
  'aws:s3/bucket:Bucket': ['AWS::S3::Bucket', ['bucket', 'arn']],
  'aws-native:s3:Bucket': ['AWS::S3::Bucket', ['bucketName', 'arn']],
  'aws:sqs/queue:Queue': ['AWS::SQS::Queue', ['url', 'arn', 'name']],
  'aws-native:sqs:Queue': ['AWS::SQS::Queue', ['queueUrl', 'arn']],
  'aws:sns/topic:Topic': ['AWS::SNS::Topic', ['arn', 'name']],
  'aws-native:sns:Topic': ['AWS::SNS::Topic', ['topicArn', 'arn']],
  'aws:cloudwatch/eventRule:EventRule': ['AWS::Events::Rule', ['name', 'arn']],
  'aws-native:events:Rule': ['AWS::Events::Rule', ['name', 'arn']],
  'aws:apigateway/restApi:RestApi': ['AWS::ApiGateway::RestApi', ['id']],
  'aws-native:apigateway:RestApi': ['AWS::ApiGateway::RestApi', ['restApiId', 'id']],
  'aws:apigatewayv2/api:Api': ['AWS::ApiGatewayV2::Api', ['id']],
  'aws-native:apigatewayv2:Api': ['AWS::ApiGatewayV2::Api', ['apiId', 'id']],
  'aws:sfn/stateMachine:StateMachine': ['AWS::StepFunctions::StateMachine', ['arn', 'name']],
  'aws-native:stepfunctions:StateMachine': ['AWS::StepFunctions::StateMachine', ['stateMachineArn', 'arn']],
  'aws:cognito/userPool:UserPool': ['AWS::Cognito::UserPool', ['id', 'arn']],
  'aws-native:cognito:UserPool': ['AWS::Cognito::UserPool', ['userPoolId', 'id']],
  'aws:dsql/cluster:Cluster': ['AWS::DSQL::Cluster', ['identifier', 'arn']],
  'aws-native:dsql:Cluster': ['AWS::DSQL::Cluster', ['identifier', 'arn']]
};

export async function discoverPulumi(cwd, exportPath, requestedStack) {
  let document, sourcePath;
  if (exportPath) {
    sourcePath = path.resolve(cwd, exportPath);
    try { document = JSON.parse(await fs.readFile(sourcePath, 'utf8')); }
    catch { throw new Error(`Pulumi stack export not found or invalid: ${sourcePath}`); }
  } else {
    sourcePath = cwd;
    try {
      const args = ['stack', 'export'];
      if (requestedStack) args.push('--stack', requestedStack);
      const result = await execute('pulumi', args, { cwd, maxBuffer: 50 * 1024 * 1024 });
      document = JSON.parse(result.stdout);
    } catch (error) { throw new Error(`Could not export the Pulumi stack in ${cwd}: ${error.message}`); }
  }
  const deployment = document.deployment || document;
  const all = deployment.resources || [];
  const mapped = new Map();
  for (const resource of all) {
    const spec = types[resource.type];
    if (!spec || resource.delete) continue;
    const physicalId = first(resource.outputs, spec[1]) || resource.id;
    if (!physicalId) continue;
    mapped.set(resource.urn, { logicalId: logicalName(resource.urn), physicalId: String(physicalId), type: spec[0], status: 'MANAGED', updatedAt: resource.modified });
  }
  const resources = [...mapped.values()];
  if (!resources.length) throw new Error('Pulumi stack contains no supported AWS resources');
  const edges = [];
  for (const resource of all) {
    const source = mapped.get(resource.urn)?.logicalId;
    if (!source) continue;
    for (const dependency of dependencies(resource)) {
      const target = mapped.get(dependency)?.logicalId;
      if (target && target !== source) edges.push({ source, target, label: 'uses' });
    }
  }
  const stackResource = all.find((resource) => resource.type === 'pulumi:pulumi:Stack');
  const provider = all.find((resource) => resource.type === 'pulumi:providers:aws');
  return {
    exportPath: sourcePath, stackName: requestedStack || stackFromUrn(stackResource?.urn) || path.basename(cwd),
    region: provider?.outputs?.region || provider?.inputs?.region,
    resources, architecture: { nodes: resources.map((resource) => ({ id: resource.logicalId, type: resource.type, synthetic: false })), edges: unique(edges) }
  };
}

function first(values = {}, names) { for (const name of names) if (typeof values?.[name] === 'string' && values[name]) return values[name]; }
function logicalName(urn = '') { return urn.split('::').at(-1) || urn; }
function stackFromUrn(urn = '') { return urn.match(/^urn:pulumi:([^:]+)::/)?.[1]; }
function dependencies(resource) {
  return [...(resource.dependencies || []), ...Object.values(resource.propertyDependencies || {}).flat()].filter((value) => typeof value === 'string');
}
function unique(edges) { return [...new Map(edges.map((edge) => [`${edge.source}|${edge.target}|${edge.label}`, edge])).values()]; }
