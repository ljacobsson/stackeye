import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { discoverTerraform } from './terraform.js';
import { discoverPulumi } from './pulumi.js';
import { findGitHubProject } from './amplify.js';
import { triggerLabel, eventSourceLabel } from './graph.js';

const candidates = ['template.yaml', 'template.yml', 'sam.yaml', 'sam.yml'];

export async function discover({ cwd, template, terraformState, pulumiState, stack, region, configEnv, chooseConfig }) {
  if (pulumiState || (!template && !terraformState && await hasPulumi(cwd))) {
    const found = await discoverPulumi(cwd, pulumiState, stack);
    return { templatePath: found.exportPath, stackName: found.stackName, region: region || found.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
      framework: 'pulumi', resources: found.resources.map(({ logicalId, type }) => ({ logicalId, type, properties: {} })), deployedResources: found.resources, architecture: found.architecture };
  }
  if (terraformState || (!template && await hasTerraform(cwd))) {
    const found = await discoverTerraform(cwd, terraformState);
    return { templatePath: found.statePath, stackName: stack || found.workspace, region: region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
      framework: 'terraform', resources: found.resources.map(({ logicalId, type }) => ({ logicalId, type, properties: {} })), deployedResources: found.resources, architecture: found.architecture };
  }
  let located;
  try { located = template ? { templatePath: path.resolve(cwd, template) } : await findTemplate(cwd, stack); }
  catch (error) {
    if (template) throw error;
    const github = await findGitHubProject(cwd);
    if (!github.repository) throw error;
    return {
      templatePath: cwd,
      stackName: stack || path.basename(cwd),
      region: region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
      framework: 'amplify',
      resources: [],
      deployedResources: [],
      architecture: { nodes: [], edges: [] }
    };
  }
  const templatePath = located.templatePath;
  let source;
  try { source = await fs.readFile(templatePath, 'utf8'); }
  catch { throw new Error(`CloudFormation template not found: ${templatePath}`); }
  // CloudFormation's short-form intrinsics (!Ref, !Sub, !GetAtt, !If, …) are
  // application-specific YAML tags. We only inspect resource metadata here,
  // so leave their values unevaluated and suppress unknown-tag warnings. Real
  // YAML syntax errors are still thrown by YAML.parse.
  const document = YAML.parse(source, { logLevel: 'silent' });
  if (!document?.Resources) throw new Error(`${path.basename(templatePath)} has no Resources section`);
  const transform = document.Transform;
  const isSam = String(transform || '').includes('Serverless');

  let config = {};
  try { config = parseToml(await fs.readFile(path.join(path.dirname(templatePath), 'samconfig.toml'), 'utf8')); } catch {}
  const environments = isSam ? Object.keys(config).filter((key) => key !== 'version' && config[key] && typeof config[key] === 'object') : [];
  let selectedConfig = configEnv;
  if (selectedConfig && !environments.includes(selectedConfig)) {
    throw new Error(`SAM configuration “${selectedConfig}” was not found. Available: ${environments.join(', ') || 'none'}`);
  }
  if (!selectedConfig && environments.length === 1) selectedConfig = environments[0];
  if (!selectedConfig && environments.length > 1) {
    if (!chooseConfig) throw new Error(`samconfig.toml has multiple environments (${environments.join(', ')}). Select one with --config <name>.`);
    selectedConfig = await chooseConfig(environments);
  }
  const selected = selectedConfig ? config[selectedConfig] : {};
  const parameters = { ...(selected?.global?.parameters || {}), ...(selected?.deploy?.parameters || {}) };
  return {
    templatePath,
    configEnv: selectedConfig,
    stackName: stack || located.stackName || parameters.stack_name || path.basename(path.dirname(templatePath)),
    region: region || located.region || parameters.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
    profile: parameters.profile,
    framework: isSam ? 'sam' : located.framework || 'cloudformation',
    resources: Object.entries(document.Resources).map(([logicalId, resource]) => ({
      logicalId, type: resource.Type, properties: resource.Properties || {}
    })),
    architecture: architecture(document.Resources, document.Globals)
  };
}

async function hasTerraform(cwd) {
  try { return (await fs.readdir(cwd)).some((name) => name.endsWith('.tf') || name === 'terraform.tfstate'); } catch { return false; }
}
async function hasPulumi(cwd) {
  try { return (await fs.readdir(cwd)).some((name) => /^Pulumi\.ya?ml$/i.test(name)); } catch { return false; }
}

function architecture(resources, globals = {}) {
  const drawable = new Set(['AWS::Lambda::Function','AWS::StepFunctions::StateMachine','AWS::DynamoDB::Table','AWS::S3::Bucket','AWS::DSQL::Cluster','AWS::Cognito::UserPool','AWS::SQS::Queue','AWS::SNS::Topic','AWS::Events::Rule','AWS::Events::EventBus','AWS::Kinesis::Stream','AWS::ApiGateway::RestApi','AWS::ApiGatewayV2::Api']);
  const nodes = Object.entries(resources).map(([id, resource]) => ({ id, type: normalizeType(resource.Type), synthetic: false })).filter((node) => drawable.has(node.type));
  const known = new Map(nodes.map((node) => [node.id, node])); const edges = [];
  const addNode = (id, type) => { if (!known.has(id)) { const node = { id, type, synthetic: true }; known.set(id, node); nodes.push(node); } return id; };
  const ref = (value) => {
    if (typeof value === 'string') return value.split(/[.:/]/)[0];
    if (!value || typeof value !== 'object') return undefined;
    if (typeof value.Ref === 'string') return value.Ref;
    const getAtt = value['Fn::GetAtt'];
    if (Array.isArray(getAtt)) return getAtt[0];
    if (typeof getAtt === 'string') return getAtt.split('.')[0];
    const sub = value['Fn::Sub']; const text = Array.isArray(sub) ? sub[0] : sub;
    return typeof text === 'string' ? text.match(/\$\{([A-Za-z][A-Za-z0-9]*)/)?.[1] : undefined;
  };
  const refsOf = (value) => { const refs = new Set(); collectRefs(value, refs); return [...refs].filter((id) => known.has(id)); };
  const firstOfType = (value, types) => refsOf(value).find((id) => types.includes(known.get(id)?.type));
  const addEdge = (source, target, label) => {
    if (!source || !target || source === target || !known.has(source) || !known.has(target)) return;
    const existing = edges.find((edge) => edge.source === source && edge.target === target);
    if (label === 'uses' && existing) return;
    if (label !== 'uses' && existing?.label === 'uses') edges.splice(edges.indexOf(existing), 1);
    edges.push({ source, target, label });
  };
  // A permission or reference that points at something callable describes a call.
  // Anything else it points at is data the caller reads or writes.
  const referenceLabel = (target) => ({ 'AWS::Lambda::Function': 'invokes', 'AWS::StepFunctions::StateMachine': 'starts execution' }[known.get(target)?.type] || 'uses');
  for (const [callerId, resource] of Object.entries(resources)) {
    const callerType = normalizeType(resource.Type);
    if (!['AWS::Lambda::Function', 'AWS::StepFunctions::StateMachine'].includes(callerType) || !known.has(callerId)) continue;
    const isFunction = callerType === 'AWS::Lambda::Function';
    const globalFunction = resource.Type === 'AWS::Serverless::Function' ? globals?.Function || {} : {};
    for (const [eventId, event] of Object.entries(resource.Properties?.Events || {})) {
      const props = event?.Properties || {}; const type = String(event?.Type || 'Event');
      const field = { SQS: 'Queue', SNS: 'Topic', S3: 'Bucket', DynamoDB: 'Stream', Kinesis: 'Stream', MSK: 'Stream', DocumentDB: 'Cluster', Api: 'RestApiId', HttpApi: 'ApiId', Cognito: 'UserPool' }[type];
      const resolved = field && ref(props[field]);
      const source = resolved && known.has(resolved) ? resolved : addNode(syntheticEventId(type, callerId, eventId), eventType(type));
      edges.push({ source, target: callerId, label: eventLabel(type) });
      // A rule on a custom bus is only reachable through that bus.
      const bus = firstOfType(props.EventBusName, ['AWS::Events::EventBus']);
      if (bus) addEdge(bus, source, 'event bus');
    }
    // Environment variables are the most common way application code receives
    // the name, URL, or ARN of a resource it calls at runtime.
    const environment = { ...(globalFunction.Environment?.Variables || {}), ...(resource.Properties?.Environment?.Variables || {}) };
    for (const target of refsOf(environment)) addEdge(callerId, target, referenceLabel(target));

    // Failure and completion destinations are outgoing traffic too.
    if (isFunction) {
      const deadLetter = { ...(globalFunction.DeadLetterQueue || {}), ...(resource.Properties?.DeadLetterQueue || {}) };
      for (const target of refsOf(deadLetter.TargetArn ?? resource.Properties?.DeadLetterConfig?.TargetArn)) addEdge(callerId, target, 'dead letters');
      const destinations = resource.Properties?.EventInvokeConfig?.DestinationConfig || {};
      for (const [outcome, destination] of Object.entries(destinations)) {
        for (const target of refsOf(destination?.Destination)) addEdge(callerId, target, invokeDestinationLabel(outcome, referenceLabel(target)));
      }
    }

    // SAM keeps inline policies on the function. Native CloudFormation normally
    // puts them on the function's execution role, through AWS::IAM::Policy or a
    // managed policy.
    for (const policy of rolePolicies(resource, resources, globalFunction.Policies)) {
      const statements = policyStatements(policy);
      for (const statement of statements) {
        for (const target of refsOf(statement.Resource)) addEdge(callerId, target, policyEdgeLabel(statement.Action, referenceLabel(target)));
      }
      // SAM policy templates (for example DynamoDBCrudPolicy) do not contain a
      // PolicyDocument, but their parameters still identify the target resource.
      if (!statements.length) for (const target of refsOf(policy)) addEdge(callerId, target, samPolicyEdgeLabel(policy, referenceLabel(target)));
    }
  }
  // SAM connectors declare an intent ("this resource writes to that one") that
  // the generated permissions would otherwise only imply.
  for (const [id, resource] of Object.entries(resources)) {
    const endpoint = (value) => ref(value?.Id ?? value);
    const connectors = resource.Type === 'AWS::Serverless::Connector'
      ? [{ source: endpoint(resource.Properties?.Source), destinations: asArray(resource.Properties?.Destination), permissions: resource.Properties?.Permissions }]
      : Object.values(resource.Connectors || {}).map((connector) => ({
        source: connector?.Properties?.Source ? endpoint(connector.Properties.Source) : id,
        destinations: asArray(connector?.Properties?.Destination), permissions: connector?.Properties?.Permissions
      }));
    for (const { source, destinations, permissions } of connectors) {
      for (const destination of destinations) {
        const target = endpoint(destination);
        if (target) addEdge(source, target, connectorLabel(known.get(target)?.type, referenceLabel(target), permissions));
      }
    }
  }
  // CDK synthesizes native CloudFormation resources rather than SAM Events.
  // Reconstruct the common trigger relationships from those generated resources.
  for (const [id, resource] of Object.entries(resources)) {
    const type = normalizeType(resource.Type), props = resource.Properties || {};
    if (type === 'AWS::Lambda::EventSourceMapping') {
      const fn = firstOfType(props.FunctionName, ['AWS::Lambda::Function']);
      const source = firstOfType(props.EventSourceArn, ['AWS::DynamoDB::Table','AWS::SQS::Queue','AWS::Kinesis::Stream']);
      if (fn && source) edges.push({ source, target: fn, label: eventSourceLabel(known.get(source).type) });
      for (const target of refsOf(props.DestinationConfig?.OnFailure?.Destination)) addEdge(fn, target, 'on failure');
    }
    // A permission is the only trace of the caller when the invoker is another
    // resource in the same template rather than a declared event source.
    if (type === 'AWS::Lambda::Permission') {
      const fn = firstOfType(props.FunctionName, ['AWS::Lambda::Function']);
      for (const source of refsOf(props.SourceArn)) addEdge(source, fn, triggerLabel(known.get(source)?.type));
    }
    if (type === 'AWS::Lambda::EventInvokeConfig') {
      const fn = firstOfType(props.FunctionName, ['AWS::Lambda::Function']);
      for (const [outcome, destination] of Object.entries(props.DestinationConfig || {})) {
        for (const target of refsOf(destination?.Destination)) addEdge(fn, target, invokeDestinationLabel(outcome, referenceLabel(target)));
      }
    }
    if (type === 'AWS::Events::Rule') {
      const bus = firstOfType(props.EventBusName, ['AWS::Events::EventBus']);
      if (bus) addEdge(bus, id, 'event bus');
      for (const target of props.Targets || []) {
        for (const targetId of refsOf(target.Arn)) addEdge(id, targetId, props.ScheduleExpression ? 'schedule' : 'event rule');
        for (const queue of refsOf(target.DeadLetterConfig?.Arn)) addEdge(id, queue, 'dead letters');
      }
    }
    if (type === 'AWS::S3::Bucket') {
      const notifications = props.NotificationConfiguration || {};
      for (const notification of notifications.LambdaConfigurations || []) {
        const fn = firstOfType(notification.Function, ['AWS::Lambda::Function']);
        if (fn) edges.push({ source: id, target: fn, label: 'object event' });
      }
      for (const notification of [...(notifications.QueueConfigurations || []), ...(notifications.TopicConfigurations || [])]) {
        for (const target of refsOf(notification.Queue ?? notification.Topic)) addEdge(id, target, 'object event');
      }
    }
    if (type === 'AWS::SNS::Topic') {
      for (const subscription of props.Subscription || []) {
        for (const target of refsOf(subscription.Endpoint)) addEdge(id, target, 'notifies');
      }
    }
    if (type === 'AWS::SQS::Queue') {
      const deadLetterQueue = firstOfType(props.RedrivePolicy?.deadLetterTargetArn, ['AWS::SQS::Queue']);
      if (deadLetterQueue) addEdge(id, deadLetterQueue, 'dead letters');
    }
    if (type === 'AWS::StepFunctions::StateMachine') {
      // A state machine names every resource its states touch, either inline in
      // the definition or through the substitutions applied to it.
      for (const target of refsOf([props.Definition, props.DefinitionString, props.DefinitionSubstitutions])) addEdge(id, target, referenceLabel(target));
    }
    if (type === 'AWS::SNS::Subscription') {
      const topic = firstOfType(props.TopicArn, ['AWS::SNS::Topic']);
      for (const endpoint of refsOf(props.Endpoint)) addEdge(topic, endpoint, 'notifies');
    }
    if (type === 'AWS::ApiGateway::Method') {
      const api = firstOfType(props.RestApiId, ['AWS::ApiGateway::RestApi']), fn = firstOfType(props.Integration?.Uri, ['AWS::Lambda::Function']);
      if (api && fn) edges.push({ source: api, target: fn, label: 'HTTP request' });
    }
    if (type === 'AWS::ApiGatewayV2::Integration') {
      const api = firstOfType(props.ApiId, ['AWS::ApiGatewayV2::Api']), fn = firstOfType(props.IntegrationUri, ['AWS::Lambda::Function']);
      if (api && fn) edges.push({ source: api, target: fn, label: 'HTTP request' });
    }
  }
  for (const [poolId, resource] of Object.entries(resources)) {
    if (normalizeType(resource.Type) !== 'AWS::Cognito::UserPool') continue;
    for (const [trigger, target] of Object.entries(resource.Properties?.LambdaConfig || {})) {
      const functionId = ref(target);
      if (functionId && known.has(functionId)) edges.push({ source: poolId, target: functionId, label: cognitoTriggerLabel(trigger) });
    }
  }
  for (const [apiId, resource] of Object.entries(resources)) {
    const type = normalizeType(resource.Type);
    if (!['AWS::ApiGateway::RestApi', 'AWS::ApiGatewayV2::Api'].includes(type)) continue;
    const refs = new Set(); collectRefs(resource.Properties?.Auth || resource.Properties, refs);
    for (const target of refs) if (normalizeType(resources[target]?.Type) === 'AWS::Cognito::UserPool' && known.has(target)) edges.push({ source: apiId, target, label: 'authorizes with' });
  }
  const uniqueEdges = [...new Map(edges.map((edge) => [`${edge.source}|${edge.target}|${edge.label}`, edge])).values()];
  return { nodes, edges: uniqueEdges };
}
function normalizeType(type) { return ({ 'AWS::Serverless::Function':'AWS::Lambda::Function', 'AWS::Serverless::StateMachine':'AWS::StepFunctions::StateMachine', 'AWS::Serverless::Api':'AWS::ApiGateway::RestApi', 'AWS::Serverless::HttpApi':'AWS::ApiGatewayV2::Api', 'AWS::Serverless::SimpleTable':'AWS::DynamoDB::Table' }[type] || type); }
function collectRefs(value, output) {
  if (typeof value === 'string') {
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(value)) output.add(value);
    const getAtt = value.match(/^([A-Za-z][A-Za-z0-9]*)\.[A-Za-z][A-Za-z0-9]*$/);
    if (getAtt) output.add(getAtt[1]);
    for (const match of value.matchAll(/\$\{([A-Za-z][A-Za-z0-9]*)(?:\.[^}]*)?\}/g)) output.add(match[1]);
  } else if (Array.isArray(value)) value.forEach((item) => collectRefs(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectRefs(item, output));
}
function rolePolicies(resource, resources, globalPolicies) {
  const policies = [...asArray(globalPolicies), ...asArray(resource.Properties?.Policies)];
  const roleIds = new Set(); collectRefs(resource.Properties?.Role || resource.Properties?.RoleArn, roleIds);
  const managedPolicyIds = new Set();
  for (const roleId of roleIds) {
    const role = resources[roleId];
    if (role?.Type !== 'AWS::IAM::Role') continue;
    policies.push(...asArray(role.Properties?.Policies));
    collectRefs(role.Properties?.ManagedPolicyArns, managedPolicyIds);
  }
  collectRefs(resource.Properties?.ManagedPolicyArns, managedPolicyIds);
  for (const [id, policy] of Object.entries(resources)) {
    if (policy.Type === 'AWS::IAM::ManagedPolicy') {
      const attachedRoles = new Set(); collectRefs(policy.Properties?.Roles, attachedRoles);
      if (managedPolicyIds.has(id) || [...roleIds].some((roleId) => attachedRoles.has(roleId))) policies.push(policy.Properties?.PolicyDocument);
      continue;
    }
    if (policy.Type !== 'AWS::IAM::Policy') continue;
    const attachedRoles = new Set(); collectRefs(policy.Properties?.Roles, attachedRoles);
    if ([...roleIds].some((roleId) => attachedRoles.has(roleId))) policies.push(policy.Properties?.PolicyDocument);
  }
  return policies;
}
function policyStatements(policy) {
  const document = policy?.PolicyDocument || policy;
  return asArray(document?.Statement).filter((statement) => String(statement?.Effect || 'Allow') === 'Allow');
}
function policyEdgeLabel(actions, fallback = 'uses') {
  const values = asArray(actions).map(String).map((action) => action.toLowerCase());
  if (values.some((action) => action === 'lambda:invokefunction' || action === 'lambda:*')) return 'invokes';
  if (values.some((action) => action.startsWith('states:startexecution'))) return 'starts execution';
  if (values.some((action) => action.startsWith('sns:publish'))) return 'publishes';
  if (values.some((action) => action.startsWith('sqs:sendmessage'))) return 'sends messages';
  if (values.some((action) => action.startsWith('events:putevents'))) return 'publishes';
  return fallback;
}
function samPolicyEdgeLabel(policy, fallback = 'uses') {
  const name = Object.keys(policy || {})[0]?.toLowerCase() || '';
  if (name.includes('sqssendmessage')) return 'sends messages';
  if (name.includes('snspublish')) return 'publishes';
  if (name.includes('lambdainvoke')) return 'invokes';
  if (name.includes('stepfunctionsexecution')) return 'starts execution';
  if (name.includes('eventbridgeputevents')) return 'publishes';
  return fallback;
}
function invokeDestinationLabel(outcome, fallback) {
  const suffix = outcome === 'OnSuccess' ? 'on success' : 'on failure';
  return fallback === 'uses' ? suffix : `${fallback} ${suffix}`;
}
function connectorLabel(targetType, fallback, permissions) {
  if (fallback !== 'uses') return fallback;
  const values = asArray(permissions).map(String);
  if (!values.includes('Write')) return 'uses';
  return ({ 'AWS::SQS::Queue':'sends messages', 'AWS::SNS::Topic':'publishes', 'AWS::Events::EventBus':'publishes' }[targetType] || (values.includes('Read') ? 'uses' : 'writes'));
}
function asArray(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function eventType(type) { return ({ Schedule:'AWS::Events::Rule', ScheduleV2:'AWS::Events::Rule', EventBridgeRule:'AWS::Events::Rule', Api:'AWS::ApiGateway::RestApi', HttpApi:'AWS::ApiGatewayV2::Api', Cognito:'AWS::Cognito::UserPool', CloudWatchEvent:'AWS::Events::Rule', SQS:'AWS::SQS::Queue', SNS:'AWS::SNS::Topic', S3:'AWS::S3::Bucket', DynamoDB:'AWS::DynamoDB::Table', Kinesis:'AWS::Kinesis::Stream' }[type] || 'AWS::Events::Rule'); }
function syntheticEventId(type, functionId, eventId) {
  if (type === 'Api') return 'ServerlessRestApi';
  if (type === 'HttpApi') return 'ServerlessHttpApi';
  return `${functionId}-${eventId}`;
}
function eventLabel(type) { return ({ SQS:'invokes', SNS:'notifies', S3:'object event', DynamoDB:'stream event', Kinesis:'stream event', MSK:'stream event', DocumentDB:'change event', Api:'HTTP request', HttpApi:'HTTP request', Cognito:'Cognito trigger', Schedule:'schedule', ScheduleV2:'schedule', EventBridgeRule:'event rule', CloudWatchEvent:'event rule' }[type] || type); }
function cognitoTriggerLabel(trigger) { return trigger.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(); }

async function findTemplate(cwd, requestedStack) {
  for (const name of candidates) {
    const target = path.join(cwd, name);
    try { await fs.access(target); return { templatePath: target, framework: 'sam' }; } catch {}
  }
  for (const assemblyDir of [path.join(cwd, 'cdk.out'), cwd]) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(assemblyDir, 'manifest.json'), 'utf8'));
      const stacks = Object.entries(manifest.artifacts || {}).filter(([, artifact]) => artifact.type === 'aws:cloudformation:stack' && artifact.properties?.templateFile);
      if (!stacks.length) continue;
      let selected;
      if (requestedStack) selected = stacks.find(([id, artifact]) => [id, artifact.displayName, artifact.properties?.stackName].includes(requestedStack));
      if (!selected && stacks.length === 1) selected = stacks[0];
      if (!selected) throw new Error(`CDK assembly contains multiple stacks (${stacks.map(([id]) => id).join(', ')}). Select one with --stack <name>.`);
      const [id, artifact] = selected, environment = String(artifact.environment || '').split('/');
      return { templatePath: path.resolve(assemblyDir, artifact.properties.templateFile), stackName: requestedStack || artifact.properties.stackName || artifact.displayName || id, region: environment[3], framework: 'cdk' };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
  }
  throw new Error(`No SAM template or CDK cloud assembly found in ${cwd}. Expected ${candidates.join(', ')} or cdk.out/manifest.json`);
}
