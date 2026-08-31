import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { parse as parseToml } from 'smol-toml';

const candidates = ['template.yaml', 'template.yml', 'sam.yaml', 'sam.yml'];

export async function discover({ cwd, template, stack, region, configEnv, chooseConfig }) {
  const located = template ? { templatePath: path.resolve(cwd, template) } : await findTemplate(cwd, stack);
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
    architecture: architecture(document.Resources)
  };
}

function architecture(resources) {
  const drawable = new Set(['AWS::Lambda::Function','AWS::DynamoDB::Table','AWS::S3::Bucket','AWS::DSQL::Cluster','AWS::Cognito::UserPool','AWS::SQS::Queue','AWS::SNS::Topic','AWS::Events::Rule','AWS::ApiGateway::RestApi','AWS::ApiGatewayV2::Api']);
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
  for (const [functionId, resource] of Object.entries(resources)) {
    if (!['AWS::Serverless::Function', 'AWS::Lambda::Function'].includes(resource.Type)) continue;
    for (const [eventId, event] of Object.entries(resource.Properties?.Events || {})) {
      const props = event?.Properties || {}; const type = String(event?.Type || 'Event');
      const field = { SQS: 'Queue', SNS: 'Topic', S3: 'Bucket', DynamoDB: 'Stream', Api: 'RestApiId', HttpApi: 'ApiId', Cognito: 'UserPool' }[type];
      const resolved = field && ref(props[field]);
      const source = resolved && known.has(resolved) ? resolved : addNode(`${functionId}-${eventId}`, eventType(type));
      edges.push({ source, target: functionId, label: eventLabel(type) });
    }
    // SAM policies and environment variables commonly contain !Ref / !GetAtt
    // values. Keep only meaningful application data dependencies, not every
    // CloudFormation implementation detail.
    const refs = new Set(); collectRefs(resource.Properties, refs);
    for (const target of refs) {
      const targetType = normalizeType(resources[target]?.Type);
      if (target !== functionId && known.has(target) && ['AWS::DynamoDB::Table','AWS::S3::Bucket','AWS::DSQL::Cluster','AWS::SQS::Queue','AWS::SNS::Topic'].includes(targetType)) edges.push({ source: functionId, target, label: 'uses' });
    }
  }
  // CDK synthesizes native CloudFormation resources rather than SAM Events.
  // Reconstruct the common trigger relationships from those generated resources.
  const refsOf = (value) => { const refs = new Set(); collectRefs(value, refs); return [...refs].filter((id) => known.has(id)); };
  const firstOfType = (value, types) => refsOf(value).find((id) => types.includes(known.get(id)?.type));
  for (const [id, resource] of Object.entries(resources)) {
    const type = normalizeType(resource.Type), props = resource.Properties || {};
    if (type === 'AWS::Lambda::EventSourceMapping') {
      const fn = firstOfType(props.FunctionName, ['AWS::Lambda::Function']);
      const source = firstOfType(props.EventSourceArn, ['AWS::DynamoDB::Table','AWS::SQS::Queue']);
      if (fn && source) edges.push({ source, target: fn, label: known.get(source).type === 'AWS::DynamoDB::Table' ? 'stream event' : 'invokes' });
    }
    if (type === 'AWS::Events::Rule') {
      for (const target of props.Targets || []) {
        const fn = firstOfType(target.Arn, ['AWS::Lambda::Function']);
        if (fn) edges.push({ source: id, target: fn, label: props.ScheduleExpression ? 'schedule' : 'event rule' });
      }
    }
    if (type === 'AWS::S3::Bucket') {
      for (const notification of props.NotificationConfiguration?.LambdaConfigurations || []) {
        const fn = firstOfType(notification.Function, ['AWS::Lambda::Function']);
        if (fn) edges.push({ source: id, target: fn, label: 'object event' });
      }
    }
    if (type === 'AWS::SNS::Subscription' && String(props.Protocol || '').toLowerCase() === 'lambda') {
      const topic = firstOfType(props.TopicArn, ['AWS::SNS::Topic']), fn = firstOfType(props.Endpoint, ['AWS::Lambda::Function']);
      if (topic && fn) edges.push({ source: topic, target: fn, label: 'notifies' });
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
function normalizeType(type) { return ({ 'AWS::Serverless::Function':'AWS::Lambda::Function', 'AWS::Serverless::Api':'AWS::ApiGateway::RestApi', 'AWS::Serverless::HttpApi':'AWS::ApiGatewayV2::Api', 'AWS::Serverless::SimpleTable':'AWS::DynamoDB::Table' }[type] || type); }
function collectRefs(value, output) { if (typeof value === 'string') { const id = value.match(/^([A-Za-z][A-Za-z0-9]+)/)?.[1]; if (id) output.add(id); } else if (Array.isArray(value)) value.forEach((item) => collectRefs(item, output)); else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectRefs(item, output)); }
function eventType(type) { return ({ Schedule:'AWS::Events::Rule', EventBridgeRule:'AWS::Events::Rule', Api:'AWS::ApiGateway::RestApi', HttpApi:'AWS::ApiGatewayV2::Api', Cognito:'AWS::Cognito::UserPool', CloudWatchEvent:'AWS::Events::Rule' }[type] || 'AWS::Events::Rule'); }
function eventLabel(type) { return ({ SQS:'invokes', SNS:'notifies', S3:'object event', DynamoDB:'stream event', Api:'HTTP request', HttpApi:'HTTP request', Cognito:'Cognito trigger', Schedule:'schedule', EventBridgeRule:'event rule', CloudWatchEvent:'event rule' }[type] || type); }
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
