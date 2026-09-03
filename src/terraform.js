import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const types = {
  aws_lambda_function: ['AWS::Lambda::Function', (v) => v.function_name || v.arn || v.id],
  aws_dynamodb_table: ['AWS::DynamoDB::Table', (v) => v.name || v.id],
  aws_s3_bucket: ['AWS::S3::Bucket', (v) => v.bucket || v.id],
  aws_sqs_queue: ['AWS::SQS::Queue', (v) => v.url || v.id],
  aws_sns_topic: ['AWS::SNS::Topic', (v) => v.arn || v.id],
  aws_cloudwatch_event_rule: ['AWS::Events::Rule', (v) => v.name || v.id],
  aws_api_gateway_rest_api: ['AWS::ApiGateway::RestApi', (v) => v.id],
  aws_apigatewayv2_api: ['AWS::ApiGatewayV2::Api', (v) => v.id],
  aws_sfn_state_machine: ['AWS::StepFunctions::StateMachine', (v) => v.arn || v.id],
  aws_cognito_user_pool: ['AWS::Cognito::UserPool', (v) => v.id],
  aws_dsql_cluster: ['AWS::DSQL::Cluster', (v) => v.identifier || v.id]
};

export async function discoverTerraform(cwd, statePath) {
  const explicit = statePath && path.resolve(cwd, statePath);
  const local = explicit || path.join(cwd, 'terraform.tfstate');
  let document, sourcePath = local;
  try {
    document = JSON.parse(await fs.readFile(local, 'utf8'));
  } catch (error) {
    if (explicit) throw new Error(`Terraform state not found or invalid: ${local}`);
    try {
      const result = await execute('terraform', ['show', '-json'], { cwd, maxBuffer: 50 * 1024 * 1024 });
      document = JSON.parse(result.stdout); sourcePath = cwd;
    } catch (terraformError) {
      throw new Error(`Could not read Terraform state in ${cwd}: ${terraformError.message}`);
    }
  }
  const instances = document.values ? showResources(document.values.root_module) : stateResources(document.resources || []);
  const resources = instances.flatMap((resource) => {
    const spec = types[resource.type];
    if (!spec) return [];
    const physicalId = spec[1](resource.values || {});
    if (!physicalId) return [];
    return [{ logicalId: resource.address, physicalId: String(physicalId), type: spec[0], status: 'MANAGED', updatedAt: undefined }];
  });
  if (!resources.length) throw new Error('Terraform state contains no supported AWS resources');
  const drawable = new Set(resources.map((resource) => resource.logicalId));
  const edges = [];
  for (const resource of instances) for (const dependency of resource.dependencies || []) {
    const target = closestAddress(dependency, drawable);
    if (drawable.has(resource.address) && target && target !== resource.address) edges.push({ source: resource.address, target, label: 'uses' });
  }
  return {
    statePath: sourcePath, resources,
    architecture: { nodes: resources.map((resource) => ({ id: resource.logicalId, type: resource.type, synthetic: false })), edges: unique(edges) },
    workspace: document.terraform_version ? path.basename(cwd) : document.lineage || path.basename(cwd)
  };
}

function showResources(module, prefix = '') {
  if (!module) return [];
  const own = (module.resources || []).filter((resource) => resource.mode !== 'data').map((resource) => ({
    address: resource.address || `${prefix}${resource.type}.${resource.name}`, type: resource.type,
    values: resource.values || {}, dependencies: resource.depends_on || []
  }));
  return own.concat(...(module.child_modules || []).map((child) => showResources(child, `${child.address}.`)));
}

function stateResources(resources) {
  return resources.filter((resource) => resource.mode === 'managed' && resource.provider?.includes('hashicorp/aws')).flatMap((resource) =>
    (resource.instances || []).map((instance, index) => ({
      address: `${resource.module ? `${resource.module}.` : ''}${resource.type}.${resource.name}${resource.instances.length > 1 ? `[${instance.index_key ?? index}]` : ''}`,
      type: resource.type, values: instance.attributes || {}, dependencies: instance.dependencies || []
    })));
}

function closestAddress(address, known) {
  if (known.has(address)) return address;
  return [...known].find((candidate) => address === candidate || address.startsWith(`${candidate}.`) || address.startsWith(`${candidate}[`));
}
function unique(edges) { return [...new Map(edges.map((edge) => [`${edge.source}|${edge.target}|${edge.label}`, edge])).values()]; }
