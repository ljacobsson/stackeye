import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { APIGatewayClient, GetRestApiCommand } from '@aws-sdk/client-api-gateway';
import { GetResourcesCommand, GetStagesCommand } from '@aws-sdk/client-api-gateway';
import { ApiGatewayV2Client, GetApiCommand, GetRoutesCommand, GetStagesCommand as GetV2StagesCommand } from '@aws-sdk/client-apigatewayv2';
import { CognitoIdentityProviderClient, DescribeUserPoolCommand, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SQSClient, GetQueueAttributesCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { SSMClient, GetParameterCommand, GetParameterHistoryCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SNSClient, GetTopicAttributesCommand, ListSubscriptionsByTopicCommand } from '@aws-sdk/client-sns';
import { EventBridgeClient, DescribeRuleCommand, ListTargetsByRuleCommand, TestEventPatternCommand } from '@aws-sdk/client-eventbridge';
import { LambdaClient, InvokeCommand, GetFunctionConfigurationCommand, UpdateFunctionConfigurationCommand, ListEventSourceMappingsCommand, GetEventSourceMappingCommand, waitUntilFunctionUpdated } from '@aws-sdk/client-lambda';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SFNClient, DescribeStateMachineCommand, TestStateCommand } from '@aws-sdk/client-sfn';
import { fromIni } from '@aws-sdk/credential-providers';
import { DsqlReader } from './dsql.js';
import { isArchiveKey, archiveEntries, archiveSummary, archiveLevel, searchArchive, readArchiveEntry, resolveArchive } from './archive.js';

const ARCHIVE_MAX_BYTES = 150_000_000, ARCHIVE_CACHE_SLOTS = 4, ARCHIVE_CACHE_BYTES = 250_000_000, ARCHIVE_SEARCH_LIMIT = 500;

export class AwsData {
  constructor({ region, profile, stackName, templateResources, deployedResources, framework, dsqlUser }) {
    const common = { region, ...(profile ? { credentials: fromIni({ profile }) } : {}) };
    this.cf = new CloudFormationClient(common); this.cw = new CloudWatchClient(common);
    this.logs = new CloudWatchLogsClient(common); this.sts = new STSClient(common); this.apiGateway = new APIGatewayClient(common);
    this.lambda = new LambdaClient(common); this.ddbRaw = new DynamoDBClient(common); this.ddb = DynamoDBDocumentClient.from(this.ddbRaw, { marshallOptions: { removeUndefinedValues: true } });
    this.s3 = new S3Client(common);
    this.cognito = new CognitoIdentityProviderClient(common); this.sqs = new SQSClient(common); this.sns = new SNSClient(common); this.events = new EventBridgeClient(common); this.apiGatewayV2 = new ApiGatewayV2Client(common); this.stepFunctions = new SFNClient(common);
    this.ssm = new SSMClient(common);
    this.dsql = new DsqlReader({ profile, user: dsqlUser });
    this.region = region; this.stackName = stackName; this.templateResources = templateResources; this.deployedResources = deployedResources;
    this.framework = framework;
  }

  async initialize() {
    const [identity, stack, deployedResources] = await Promise.all([
      this.sts.send(new GetCallerIdentityCommand({})),
      this.deployedResources ? undefined : this.cf.send(new DescribeStacksCommand({ StackName: this.stackName })),
      this.deployedResources || this.stackResources()
    ]);
    const found = stack?.Stacks?.[0];
    this.account = identity.Account;
    this.resources = deployedResources.map((r) => ({
      logicalId: r.logicalId || r.LogicalResourceId, physicalId: r.physicalId || r.PhysicalResourceId, type: r.type || r.ResourceType,
      status: r.status || r.ResourceStatus, updatedAt: r.updatedAt || r.Timestamp
    }));
    await this.enrichApiNames();
    return { account: identity.Account, arn: identity.Arn, stack: {
      name: found?.StackName || this.stackName, status: found?.StackStatus || this.managedStatus(), createdAt: found?.CreationTime,
      updatedAt: found?.LastUpdatedTime, outputs: found?.Outputs || [], tags: found?.Tags || []
    }, resources: this.resources };
  }

  // Stacks discovered from IaC state instead of CloudFormation have no stack
  // status of their own, so name the tool that manages them.
  managedStatus() { return `${(this.framework || 'terraform').toUpperCase()} MANAGED`; }

  functions() { return this.resources.filter((r) => r.type === 'AWS::Lambda::Function'); }
  tables() { return this.resources.filter((r) => r.type === 'AWS::DynamoDB::Table'); }
  apis() { return this.resources.filter((r) => r.type === 'AWS::ApiGateway::RestApi'); }
  buckets() { return this.resources.filter((r) => r.type === 'AWS::S3::Bucket'); }
  clusters() { return this.resources.filter((r) => r.type === 'AWS::DSQL::Cluster'); }

  async enrichApiNames() {
    await Promise.all(this.apis().map(async (api) => {
      try { api.metricName = (await this.apiGateway.send(new GetRestApiCommand({ restApiId: api.physicalId }))).name; }
      catch { api.metricName = api.physicalId; }
    }));
  }

  async stackResources() {
    const resources = []; let nextToken;
    do {
      const page = await this.cf.send(new ListStackResourcesCommand({ StackName: this.stackName, NextToken: nextToken }));
      resources.push(...(page.StackResourceSummaries || [])); nextToken = page.NextToken;
    } while (nextToken);
    return [...new Map(resources.map((resource) => [`${resource.LogicalResourceId}|${resource.PhysicalResourceId}`, resource])).values()];
  }

  async metrics(rangeMinutes = 60, period = 60) {
    const end = new Date(); const start = new Date(end.getTime() - rangeMinutes * 60000);
    const definitions = [];
    const add = (service, resources, namespace, dimensions, metricDefs) => resources.forEach((resource) => metricDefs.forEach(([metric, stat]) => definitions.push({ service, resource: resource.logicalId, metric, stat, namespace, dimensions: dimensions(resource) })));
    add('lambda', this.functions(), 'AWS/Lambda', (r) => [{ Name: 'FunctionName', Value: r.physicalId }], [
      ['Invocations','Sum'], ['Errors','Sum'], ['Throttles','Sum'], ['Duration','Average'],
      ['ConcurrentExecutions','Maximum'], ['AsyncEventAge','Maximum'], ['DeadLetterErrors','Sum']
    ]);
    add('dynamodb', this.tables(), 'AWS/DynamoDB', (r) => [{ Name: 'TableName', Value: r.physicalId }], [
      ['ConsumedReadCapacityUnits','Sum'], ['ConsumedWriteCapacityUnits','Sum'], ['ThrottledRequests','Sum'],
      ['SystemErrors','Sum'], ['UserErrors','Sum']
    ]);
    add('apigateway', this.apis(), 'AWS/ApiGateway', (r) => [{ Name: 'ApiName', Value: r.metricName }], [
      ['Count','Sum'], ['4XXError','Sum'], ['5XXError','Sum'], ['Latency','Average'], ['IntegrationLatency','Average']
    ]);
    const queries = definitions.map((d, index) => ({
      Id: `m${index}`, Label: d.metric,
      MetricStat: { Metric: { Namespace: d.namespace, MetricName: d.metric, Dimensions: d.dimensions }, Period: period, Stat: d.stat }, ReturnData: true
    }));
    if (!queries.length) return [];
    const result = await this.cw.send(new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: queries, ScanBy: 'TimestampAscending' }));
    return (result.MetricDataResults || []).map((row) => {
      const definition = definitions[Number(row.Id.slice(1))];
      return { service: definition.service, resource: definition.resource, metric: definition.metric, stat: definition.stat,
        timestamps: row.Timestamps || [], values: row.Values || [], status: row.StatusCode };
    });
  }

  async amplifyHostingMetrics(appId, rangeMinutes = 60, period = 60) {
    const end = new Date(), start = new Date(end.getTime() - Math.max(1, rangeMinutes) * 60_000);
    const definitions = [['Requests', 'Sum'], ['4xxErrors', 'Sum'], ['5xxErrors', 'Sum'], ['Latency', 'Average'], ['BytesDownloaded', 'Sum'], ['BytesUploaded', 'Sum'], ['TokensConsumed', 'Sum']];
    const result = await this.cw.send(new GetMetricDataCommand({
      StartTime: start, EndTime: end, ScanBy: 'TimestampAscending',
      MetricDataQueries: definitions.map(([metric, stat], index) => ({
        Id: `a${index}`, Label: metric, ReturnData: true,
        MetricStat: { Metric: { Namespace: 'AWS/AmplifyHosting', MetricName: metric, Dimensions: [{ Name: 'App', Value: appId }] }, Period: Math.max(60, Number(period) || 60), Stat: stat }
      }))
    }));
    return (result.MetricDataResults || []).map((row) => ({ metric: definitions[Number(row.Id.slice(1))][0], stat: definitions[Number(row.Id.slice(1))][1], timestamps: row.Timestamps || [], values: row.Values || [], status: row.StatusCode }));
  }

  metricResources() {
    const specs = {
      'AWS::Lambda::Function': ['AWS/Lambda', 'FunctionName', (r) => r.physicalId],
      'AWS::DynamoDB::Table': ['AWS/DynamoDB', 'TableName', (r) => r.physicalId],
      'AWS::ApiGateway::RestApi': ['AWS/ApiGateway', 'ApiName', (r) => r.metricName || r.physicalId],
      'AWS::ApiGatewayV2::Api': ['AWS/ApiGateway', 'ApiId', (r) => r.physicalId],
      'AWS::S3::Bucket': ['AWS/S3', 'BucketName', (r) => r.physicalId],
      'AWS::SQS::Queue': ['AWS/SQS', 'QueueName', (r) => String(r.physicalId).split('/').pop()],
      'AWS::SNS::Topic': ['AWS/SNS', 'TopicName', (r) => String(r.physicalId).split(':').pop()],
      'AWS::StepFunctions::StateMachine': ['AWS/States', 'StateMachineArn', (r) => r.physicalId],
      'AWS::Events::Rule': ['AWS/Events', 'RuleName', (r) => r.physicalId]
    };
    return this.resources.flatMap((resource) => {
      const spec = specs[resource.type];
      return spec ? [{ resource, namespace: spec[0], dimension: { Name: spec[1], Value: spec[2](resource) } }] : [];
    });
  }

  async metricCatalog(force = false) {
    if (!force && this.metricCatalogCache?.expires > Date.now()) return this.metricCatalogCache.rows;
    const rows = [];
    await Promise.all(this.metricResources().map(async ({ resource, namespace, dimension }) => {
      let nextToken;
      do {
        const page = await this.cw.send(new ListMetricsCommand({ Namespace: namespace, Dimensions: [dimension], NextToken: nextToken }));
        for (const metric of page.Metrics || []) {
          if (!metric.Dimensions?.some((item) => item.Name === dimension.Name && item.Value === dimension.Value)) continue;
          const dimensions = [...metric.Dimensions].sort((a, b) => a.Name.localeCompare(b.Name));
          const key = JSON.stringify([namespace, metric.MetricName, dimensions]);
          rows.push({ id: Buffer.from(key).toString('base64url'), resource: resource.logicalId, physicalId: resource.physicalId,
            resourceType: resource.type, namespace, metric: metric.MetricName, dimensions, scopeDimension: dimension.Name });
        }
        nextToken = page.NextToken;
      } while (nextToken);
    }));
    const identities = [...new Map(rows.map((row) => [row.id, row])).values()], groups = new Map();
    for (const row of identities) {
      const key = `${row.resource}\0${row.namespace}\0${row.metric}`, list = groups.get(key) || [];
      list.push(row); groups.set(key, list);
    }
    const unique = [...groups.values()].flatMap((variants) => {
      const canonical = variants.find((row) => row.dimensions.length === 1 && row.dimensions[0].Name === row.scopeDimension);
      return canonical ? [canonical] : variants;
    }).sort((a, b) => a.resource.localeCompare(b.resource) || a.metric.localeCompare(b.metric));
    this.metricCatalogCache = { rows: unique, expires: Date.now() + 60_000 };
    return unique;
  }

  async browseMetrics({ ids, minutes = 60, period = 60, stat = 'Average' }) {
    const allowedStats = new Set(['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount', 'p50', 'p90', 'p95', 'p99']);
    if (!allowedStats.has(stat)) throw new Error('Unsupported metric statistic');
    const catalog = await this.metricCatalog(), byId = new Map(catalog.map((row) => [row.id, row]));
    const selected = [...new Set(Array.isArray(ids) ? ids : [])].slice(0, 20).map((id) => byId.get(id));
    if (!selected.length || selected.some((row) => !row)) throw new Error('Select metrics from the current stack');
    const safeMinutes = Math.max(1, Math.min(Number(minutes) || 60, 43_200));
    const safePeriod = Math.max(1, Math.min(Number(period) || 60, 86_400));
    const end = new Date(), start = new Date(end.getTime() - safeMinutes * 60_000);
    const request = { StartTime: start, EndTime: end, ScanBy: 'TimestampAscending', MetricDataQueries: selected.map((row, index) => ({
      Id: `q${index}`, Label: `${row.resource} · ${row.metric}`,
      MetricStat: { Metric: { Namespace: row.namespace, MetricName: row.metric, Dimensions: row.dimensions }, Period: safePeriod, Stat: stat }, ReturnData: true
    })) };
    const merged = new Map(); let nextToken;
    do {
      const page = await this.cw.send(new GetMetricDataCommand({ ...request, NextToken: nextToken }));
      for (const series of page.MetricDataResults || []) {
        const row = merged.get(series.Id) || { Id: series.Id, Timestamps: [], Values: [], Messages: [] };
        row.Timestamps.push(...(series.Timestamps || [])); row.Values.push(...(series.Values || [])); row.Messages.push(...(series.Messages || [])); row.StatusCode = series.StatusCode;
        merged.set(series.Id, row);
      }
      nextToken = page.NextToken;
    } while (nextToken);
    return [...merged.values()].map((series) => ({ ...selected[Number(series.Id.slice(1))], stat, timestamps: series.Timestamps, values: series.Values, status: series.StatusCode, messages: series.Messages }));
  }

  async logEvents({ functionName, startTime, endTime, nextToken, filterPattern, all }) {
    const fn = this.functions().find((r) => r.logicalId === functionName || r.physicalId === functionName);
    if (!fn) throw new Error('Unknown Lambda function');
    const bounded = all === '1' || Boolean(endTime), scan = async (pattern, initialToken, maxEvents) => {
      const found = []; let token = initialToken || undefined, previousToken;
      do {
        const result = await this.logs.send(new FilterLogEventsCommand({
          logGroupName: `/aws/lambda/${fn.physicalId}`, startTime: Number(startTime) || Date.now() - 15 * 60000, endTime: Number(endTime) || undefined,
          nextToken: token, filterPattern: pattern || undefined, interleaved: true, limit: 500
        }));
        found.push(...(result.events || [])); previousToken = token; token = result.nextToken;
      } while (bounded && token && token !== previousToken && found.length < maxEvents);
      return { found, token, truncated: Boolean(token) && found.length >= maxEvents };
    };
    const context = await scan(filterPattern, nextToken, 10_000), events = [...context.found];
    // Sparse failures can be buried behind many megabytes of INFO events in a
    // broad FilterLogEvents traversal. For bounded graph drill-downs, make a
    // second all-stream pass for failures and merge them into their context.
    if (bounded && !filterPattern) {
      const failures = await scan('?ERROR ?Error ?error ?Exception ?exception ?FATAL ?Fatal ?fatal', undefined, 10_000);
      events.push(...failures.found);
    }
    const unique = [...new Map(events.map((event) => [event.eventId || `${event.timestamp}|${event.logStreamName}|${event.message}`, event])).values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return { events: unique.map((e) => ({ id: e.eventId, timestamp: e.timestamp, message: e.message, stream: e.logStreamName })), nextToken: context.token, truncated: context.truncated };
  }

  resource(type, name) {
    const found = this.resources.find((r) => r.type === type && (r.logicalId === name || r.physicalId === name));
    if (!found) throw new Error(`Unknown ${type.split('::').pop()} resource`);
    return found;
  }

  async invoke({ functionName, payload }) {
    const fn = this.resource('AWS::Lambda::Function', functionName);
    const input = JSON.parse(payload || '{}');
    const result = await this.lambda.send(new InvokeCommand({ FunctionName: fn.physicalId, InvocationType: 'RequestResponse', LogType: 'Tail', Payload: Buffer.from(JSON.stringify(input)) }));
    const output = result.Payload?.length ? Buffer.from(result.Payload).toString('utf8') : '';
    let parsed = output; try { parsed = JSON.parse(output); } catch {}
    return { statusCode: result.StatusCode, functionError: result.FunctionError, executedVersion: result.ExecutedVersion,
      logs: result.LogResult ? Buffer.from(result.LogResult, 'base64').toString('utf8') : '', payload: parsed };
  }

  async forceColdStart({ functionName }) {
    const fn = this.resource('AWS::Lambda::Function', functionName);
    const current = await this.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fn.physicalId }));
    const timestamp = new Date().toISOString();
    await this.lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: fn.physicalId, Environment: { Variables: { ...(current.Environment?.Variables || {}), COLD_STARTER: timestamp } } }));
    await waitUntilFunctionUpdated({ client: this.lambda, maxWaitTime: 90 }, { FunctionName: fn.physicalId });
    return { functionName: fn.logicalId, timestamp };
  }

  async eventSourceMappings({ functionName }) {
    const fn = this.resource('AWS::Lambda::Function', functionName); const mappings = [], warnings = []; let marker;
    // Do not pass FunctionName here. Lambda's filtered result can omit a mapping
    // when it targets an alias/version; fetch the account's mappings and compare
    // the unqualified function name ourselves instead.
    try {
      do {
        const page = await this.lambda.send(new ListEventSourceMappingsCommand({ Marker: marker, MaxItems: 100 }));
        mappings.push(...(page.EventSourceMappings || []).filter((mapping) => matchesFunction(mapping, fn.physicalId)));
        marker = page.NextMarker;
      } while (marker);
    } catch (error) {
      console.warn(`Could not list event source mappings for ${fn.physicalId}: ${error.message}`);
      warnings.push(`Lambda could not list mappings: ${error.message}`);
    }
    // CloudFormation provides an independent source of truth for mappings in
    // this stack. Merge it even when List succeeded, since it supplies a full
    // config object for mappings Lambda may return only as summaries.
    const deployed = this.resources.filter((resource) => resource.type === 'AWS::Lambda::EventSourceMapping');
    const inspected = await Promise.all(deployed.map(async (resource) => {
      try { return await this.lambda.send(new GetEventSourceMappingCommand({ UUID: resource.physicalId })); }
      catch (error) { warnings.push(`Could not read ${resource.logicalId}: ${error.message}`); return undefined; }
    }));
    mappings.push(...inspected.filter((mapping) => mapping && matchesFunction(mapping, fn.physicalId)));
    return {
      mappings: [...new Map(mappings.map((mapping) => [mapping.UUID, mapping])).values()].map(mappingSummary),
      stackMappingCount: deployed.length,
      warnings
    };
  }

  async describeTable({ tableName }) {
    const table = this.resource('AWS::DynamoDB::Table', tableName);
    const result = await this.ddbRaw.send(new DescribeTableCommand({ TableName: table.physicalId }));
    const t = result.Table;
    return { logicalId: table.logicalId, tableName: table.physicalId, status: t.TableStatus, itemCount: t.ItemCount, sizeBytes: t.TableSizeBytes,
      keySchema: t.KeySchema || [], attributes: t.AttributeDefinitions || [], indexes: (t.GlobalSecondaryIndexes || []).map((i) => ({ name: i.IndexName, keySchema: i.KeySchema, status: i.IndexStatus, itemCount: i.ItemCount })) };
  }

  async scanTable(input) {
    const table = this.resource('AWS::DynamoDB::Table', input.tableName);
    return this.ddb.send(new ScanCommand({ TableName: table.physicalId, Limit: clampLimit(input.limit), FilterExpression: optional(input.filterExpression),
      ExpressionAttributeNames: objectOrUndefined(input.expressionNames), ExpressionAttributeValues: objectOrUndefined(input.expressionValues) }));
  }

  async queryTable(input) {
    const table = this.resource('AWS::DynamoDB::Table', input.tableName);
    if (!input.keyConditionExpression?.trim()) throw new Error('A key condition expression is required');
    return this.ddb.send(new QueryCommand({ TableName: table.physicalId, IndexName: optional(input.indexName), KeyConditionExpression: input.keyConditionExpression,
      FilterExpression: optional(input.filterExpression), ExpressionAttributeNames: objectOrUndefined(input.expressionNames), ExpressionAttributeValues: objectOrUndefined(input.expressionValues),
      Limit: clampLimit(input.limit), ScanIndexForward: input.scanIndexForward !== false }));
  }

  async updateTableItem(input) {
    const table = this.resource('AWS::DynamoDB::Table', input.tableName);
    if (!input.key || typeof input.key !== 'object' || Array.isArray(input.key)) throw new Error('A key object is required');
    if (!input.updateExpression?.trim()) throw new Error('An update expression is required');
    return this.ddb.send(new UpdateCommand({ TableName: table.physicalId, Key: input.key, UpdateExpression: input.updateExpression,
      ConditionExpression: optional(input.conditionExpression), ExpressionAttributeNames: objectOrUndefined(input.expressionNames), ExpressionAttributeValues: objectOrUndefined(input.expressionValues), ReturnValues: 'ALL_NEW' }));
  }

  // Aurora DSQL has no API that returns a connection endpoint: it is derived from
  // the cluster identifier and its region, which is how the AWS SDK examples connect.
  async dsqlTarget(clusterName) {
    const cluster = this.resource('AWS::DSQL::Cluster', clusterName);
    const arn = cluster.physicalId.startsWith('arn:') ? cluster.physicalId.split(':') : null;
    const identifier = arn ? cluster.physicalId.split('/').pop() : cluster.physicalId;
    const region = arn?.[3] || this.region || await this.cf.config.region();
    if (!region) throw new Error('An AWS region is required to reach an Aurora DSQL cluster');
    return { logicalId: cluster.logicalId, identifier, region, host: `${identifier}.dsql.${region}.on.aws` };
  }

  async dsqlSchema({ clusterName }) {
    const target = await this.dsqlTarget(clusterName);
    return { ...target, ...(await this.dsql.schema(target)) };
  }

  async dsqlQuery({ clusterName, sql, limit }) {
    return this.dsql.query(await this.dsqlTarget(clusterName), { sql, limit });
  }

  bucket(name) { return this.resource('AWS::S3::Bucket', name); }

  async listBucket({ bucketName, prefix = '', continuationToken }) {
    const bucket = this.bucket(bucketName);
    const result = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket.physicalId, Prefix: prefix, Delimiter: '/', ContinuationToken: continuationToken, MaxKeys: 500 }));
    return { folders: (result.CommonPrefixes || []).map((p) => p.Prefix), files: (result.Contents || []).filter((o) => o.Key !== prefix).map(s3Object), nextToken: result.NextContinuationToken };
  }

  async searchBucket({ bucketName, query }) {
    const bucket = this.bucket(bucketName); const needle = String(query || '').toLowerCase();
    if (needle.length < 2) throw new Error('Enter at least two characters to search');
    let token; const files = [];
    do {
      const result = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket.physicalId, ContinuationToken: token, MaxKeys: 1000 }));
      files.push(...(result.Contents || []).filter((o) => o.Key.toLowerCase().includes(needle)).map(s3Object)); token = result.NextContinuationToken;
    } while (token && files.length < 250);
    return { files: files.slice(0, 250), truncated: Boolean(token) || files.length > 250 };
  }

  async getBucketObject({ bucketName, key, maxBytes = 25_000_000 }) {
    const bucket = this.bucket(bucketName);
    const head = await this.s3.send(new HeadObjectCommand({ Bucket: bucket.physicalId, Key: key }));
    if ((head.ContentLength || 0) > maxBytes) throw new Error(`File is too large to preview (${Math.ceil(head.ContentLength / 1_000_000)} MB)`);
    const result = await this.s3.send(new GetObjectCommand({ Bucket: bucket.physicalId, Key: key }));
    return { buffer: Buffer.from(await result.Body.transformToByteArray()), contentType: result.ContentType || contentTypeFor(key), length: head.ContentLength, modified: head.LastModified, etag: head.ETag };
  }

  // Zip browsing needs the whole object in memory, so keep the most recently opened archives
  // around: walking folders inside one archive would otherwise re-download it on every click.
  async archiveBuffer({ bucketName, key, trail = [], maxBytes = ARCHIVE_MAX_BYTES }) {
    const bucket = this.bucket(bucketName);
    if (!isArchiveKey(key)) throw new Error(`“${key}” is not a zip archive`);
    const head = await this.s3.send(new HeadObjectCommand({ Bucket: bucket.physicalId, Key: key }));
    if ((head.ContentLength || 0) > maxBytes) throw new Error(`This archive is too large to browse (${Math.ceil(head.ContentLength / 1_000_000)} MB)`);
    const outerKey = [bucket.physicalId, key, head.ETag].join(' ');
    let buffer = this.cachedArchive(outerKey);
    if (!buffer) {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: bucket.physicalId, Key: key }));
      buffer = this.rememberArchive(outerKey, Buffer.from(await result.Body.transformToByteArray()));
    }
    if (!trail.length) return buffer;
    const nestedKey = [outerKey, ...trail].join(' ');
    return this.cachedArchive(nestedKey) || this.rememberArchive(nestedKey, resolveArchive(buffer, trail));
  }

  cachedArchive(cacheKey) {
    const cache = (this.archiveCache ||= new Map()); const hit = cache.get(cacheKey);
    if (hit) { cache.delete(cacheKey); cache.set(cacheKey, hit); } // re-insert so the newest entry sorts last
    return hit;
  }

  rememberArchive(cacheKey, buffer) {
    const cache = (this.archiveCache ||= new Map());
    cache.set(cacheKey, buffer);
    let total = 0; for (const value of cache.values()) total += value.length;
    for (const oldest of [...cache.keys()]) {
      if (cache.size <= ARCHIVE_CACHE_SLOTS && total <= ARCHIVE_CACHE_BYTES) break;
      if (oldest === cacheKey) continue;
      total -= cache.get(oldest).length; cache.delete(oldest);
    }
    return buffer;
  }

  async listArchive({ bucketName, key, trail = [], prefix = '', query }) {
    const entries = archiveEntries(await this.archiveBuffer({ bucketName, key, trail }));
    const archive = { key, trail, ...archiveSummary(entries) };
    if (query) {
      const matches = searchArchive(entries, query);
      return { archive, prefix: '', query, folders: [], files: matches.slice(0, ARCHIVE_SEARCH_LIMIT), truncated: matches.length > ARCHIVE_SEARCH_LIMIT };
    }
    return { archive, prefix, ...archiveLevel(entries, prefix) };
  }

  async getArchiveEntry({ bucketName, key, trail = [], entryPath }) {
    const buffer = readArchiveEntry(await this.archiveBuffer({ bucketName, key, trail }), entryPath);
    return { buffer, contentType: contentTypeFor(entryPath), length: buffer.length };
  }

  async readResource({ type, resourceName }) {
    const resource = this.resource(type, resourceName);
    if (type === 'AWS::Cognito::UserPool') {
      const [pool, users] = await Promise.all([this.cognito.send(new DescribeUserPoolCommand({ UserPoolId: resource.physicalId })), this.cognito.send(new ListUsersCommand({ UserPoolId: resource.physicalId, Limit: 60 }))]);
      return { kind: 'cognito', pool: pool.UserPool, users: users.Users || [] };
    }
    if (type === 'AWS::SQS::Queue') {
      const attributes = await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: resource.physicalId, AttributeNames: ['All'] }));
      let messages = []; try { messages = (await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: resource.physicalId, MaxNumberOfMessages: 10, VisibilityTimeout: 0, WaitTimeSeconds: 0, AttributeNames: ['All'], MessageAttributeNames: ['All'] }))).Messages || []; } catch {}
      return { kind: 'sqs', attributes: attributes.Attributes || {}, messages };
    }
    if (type === 'AWS::SNS::Topic') {
      const [attributes, subscriptions] = await Promise.all([this.sns.send(new GetTopicAttributesCommand({ TopicArn: resource.physicalId })), this.sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: resource.physicalId }))]);
      return { kind: 'sns', attributes: attributes.Attributes || {}, subscriptions: subscriptions.Subscriptions || [] };
    }
    if (type === 'AWS::Events::Rule') {
      const { Name, EventBusName } = this.ruleReference(resource);
      const [rule, targets] = await Promise.all([this.events.send(new DescribeRuleCommand({ Name, EventBusName })), this.events.send(new ListTargetsByRuleCommand({ Rule: Name, EventBusName }))]);
      return { kind: 'eventbridge', rule, targets: targets.Targets || [] };
    }
    if (type === 'AWS::StepFunctions::StateMachine') {
      const machine = await this.stepFunctions.send(new DescribeStateMachineCommand({ stateMachineArn: resource.physicalId }));
      let definition; try { definition = JSON.parse(machine.definition); } catch { throw new Error('The deployed state-machine definition is not valid JSON'); }
      return { kind: 'state-machine', logicalId: resource.logicalId, stateMachineArn: resource.physicalId, name: machine.name, status: machine.status, type: machine.type, roleArn: machine.roleArn, creationDate: machine.creationDate, loggingConfiguration: machine.loggingConfiguration, tracingConfiguration: machine.tracingConfiguration, definition };
    }
    if (type === 'AWS::SSM::Parameter') return this.readParameter(resource);
    if (type === 'AWS::ApiGateway::RestApi' || type === 'AWS::ApiGatewayV2::Api') return this.apiDefinition({ type, resourceName });
    throw new Error('This resource does not have a reader yet');
  }

  // A SecureString needs kms:Decrypt, which a read-only session may not have. Losing the
  // value is better than losing the whole parameter, so the plaintext read is optional and
  // the pane says which of the two it got.
  async readParameter(resource) {
    const Name = resource.physicalId;
    let decrypted = true, parameter;
    try { parameter = (await this.ssm.send(new GetParameterCommand({ Name, WithDecryption: true }))).Parameter; }
    catch (error) {
      if (error.name !== 'AccessDeniedException') throw error;
      decrypted = false;
      parameter = (await this.ssm.send(new GetParameterCommand({ Name, WithDecryption: false }))).Parameter;
    }
    // Description, tier and allowed pattern are only reported per version, so the newest
    // history entry carries the metadata that GetParameter leaves out.
    let versions = [];
    try { versions = ((await this.ssm.send(new GetParameterHistoryCommand({ Name, WithDecryption: false, MaxResults: 20 }))).Parameters || []).sort((a, b) => (b.Version || 0) - (a.Version || 0)); } catch {}
    const current = versions[0] || {};
    return {
      kind: 'ssm', logicalId: resource.logicalId, name: Name, arn: parameter.ARN, value: parameter.Value ?? '',
      type: parameter.Type, dataType: parameter.DataType, version: parameter.Version, lastModified: parameter.LastModifiedDate,
      encrypted: parameter.Type === 'SecureString', decrypted, description: current.Description || '', tier: current.Tier || 'Standard',
      allowedPattern: current.AllowedPattern || '', keyId: current.KeyId || '', lastModifiedBy: current.LastModifiedUser || '',
      history: versions.map((entry) => ({ version: entry.Version, at: entry.LastModifiedDate, by: entry.LastModifiedUser, description: entry.Description || '' }))
    };
  }

  // Overwrite keeps the existing type, KMS key and tier, so an edit here can only ever
  // change the value of a parameter the template already declares.
  async putParameter({ resourceName, value }) {
    const resource = this.resource('AWS::SSM::Parameter', resourceName);
    if (typeof value !== 'string') throw new Error('A parameter value must be a string');
    if (!value.length) throw new Error('Systems Manager rejects an empty parameter value');
    await this.ssm.send(new PutParameterCommand({ Name: resource.physicalId, Value: value, Overwrite: true }));
    return this.readParameter(resource);
  }

  // CloudFormation reports a rule on a custom bus as "<bus>|<rule>". Neither name can
  // contain a pipe, so the separator is unambiguous.
  ruleReference(resource) {
    const parts = resource.physicalId.split('|');
    return parts.length > 1 ? { Name: parts.slice(1).join('|'), EventBusName: parts[0] } : { Name: resource.physicalId, EventBusName: 'default' };
  }

  // EventBridge rejects events that are missing envelope fields, so the tester fills the
  // gaps rather than bouncing a ValidationException back at whoever wrote the detail.
  eventEnvelope(event) {
    const defaults = {
      id: '00000000-1111-2222-3333-444444444444', account: this.account || '123456789012',
      source: 'stackeye.test', time: new Date().toISOString(), region: this.region || 'us-east-1',
      resources: [], 'detail-type': 'Test event', detail: {}
    };
    const added = Object.keys(defaults).filter((key) => event[key] === undefined);
    return { event: { version: '0', ...defaults, ...event }, added };
  }

  async testEventPattern({ resourceName, event }) {
    const resource = this.resource('AWS::Events::Rule', resourceName);
    const rule = await this.events.send(new DescribeRuleCommand(this.ruleReference(resource)));
    if (!rule.EventPattern) throw new Error('This rule runs on a schedule, so it has no event pattern to test');
    let parsed;
    try { parsed = typeof event === 'string' ? JSON.parse(event || '{}') : event; }
    catch { throw new Error('The test event must be valid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The test event must be a JSON object');
    const { event: complete, added } = this.eventEnvelope(parsed);
    const result = await this.events.send(new TestEventPatternCommand({ EventPattern: rule.EventPattern, Event: JSON.stringify(complete) }));
    return { matches: Boolean(result.Result), event: complete, added, pattern: rule.EventPattern };
  }

  async testState({ resourceName, stateName, input = '{}', inspectionLevel = 'INFO' }) {
    const resource = this.resource('AWS::StepFunctions::StateMachine', resourceName);
    const machine = await this.stepFunctions.send(new DescribeStateMachineCommand({ stateMachineArn: resource.physicalId }));
    let definition, parsedInput;
    try { definition = JSON.parse(machine.definition); } catch { throw new Error('The deployed state-machine definition is not valid JSON'); }
    const state = definition?.States?.[stateName];
    if (!state) throw new Error(`State “${stateName}” was not found in this deployed state machine`);
    try { parsedInput = typeof input === 'string' ? JSON.parse(input || '{}') : input; } catch { throw new Error('State input must be valid JSON'); }
    const level = ['INFO','DEBUG','TRACE'].includes(inspectionLevel) ? inspectionLevel : 'INFO';
    return this.stepFunctions.send(new TestStateCommand({ definition: JSON.stringify(state), input: JSON.stringify(parsedInput), inspectionLevel: level, roleArn: machine.roleArn }));
  }

  async searchCognitoUsers({ resourceName, value = '' }) {
    const resource = this.resource('AWS::Cognito::UserPool', resourceName);
    const needle = value.trim().toLocaleLowerCase(); let token; const users = []; let scanned = 0;
    do {
      const page = await this.cognito.send(new ListUsersCommand({ UserPoolId: resource.physicalId, Limit: 60, PaginationToken: token }));
      const pageUsers = page.Users || []; scanned += pageUsers.length;
      users.push(...pageUsers.filter((user) => !needle || [user.Username, ...(user.Attributes || []).map((a) => a.Value)].some((field) => String(field || '').toLocaleLowerCase().includes(needle))));
      token = page.PaginationToken;
    } while (token && users.length < 250 && scanned < 5_000);
    return { users: users.slice(0, 250), scanned, truncated: Boolean(token) || users.length > 250 };
  }

  async apiDefinition({ type, resourceName }) {
    const resource = this.resource(type, resourceName);
    if (type === 'AWS::ApiGateway::RestApi') {
      const [api, routes, stages] = await Promise.all([this.apiGateway.send(new GetRestApiCommand({ restApiId: resource.physicalId })), this.apiGateway.send(new GetResourcesCommand({ restApiId: resource.physicalId, embed: ['methods'], limit: 500 })), this.apiGateway.send(new GetStagesCommand({ restApiId: resource.physicalId }))]);
      return { kind: 'rest-api', logicalId: resource.logicalId, apiId: resource.physicalId, name: api.name, endpoint: `https://${resource.physicalId}.execute-api.${this.region}.amazonaws.com`, stages: (stages.item || []).map((s) => s.stageName), routes: (routes.items || []).flatMap((r) => Object.keys(r.resourceMethods || {}).map((method) => ({ method, path: r.path }))) };
    }
    const [api, routes, stages] = await Promise.all([this.apiGatewayV2.send(new GetApiCommand({ ApiId: resource.physicalId })), this.apiGatewayV2.send(new GetRoutesCommand({ ApiId: resource.physicalId, MaxResults: '500' })), this.apiGatewayV2.send(new GetV2StagesCommand({ ApiId: resource.physicalId, MaxResults: '500' }))]);
    return { kind: 'http-api', logicalId: resource.logicalId, apiId: resource.physicalId, name: api.Name, endpoint: api.ApiEndpoint, stages: (stages.Items || []).map((s) => s.StageName), routes: (routes.Items || []).map((r) => { const [method, ...path] = r.RouteKey.split(' '); return { method, path: path.join(' ') || '$default', routeKey: r.RouteKey }; }) };
  }

  async invokeApi({ type, resourceName, stage, method, path, routePath, query, headers, body }) {
    const definition = await this.apiDefinition({ type, resourceName });
    const route = definition.routes.find((r) => r.path === (routePath || path) && (r.method === method || r.method === 'ANY' || method === 'ANY'));
    if (!route) throw new Error('That method and route are not part of this API gateway schema');
    const stagePart = stage && stage !== '$default' ? `/${encodeURIComponent(stage)}` : '';
    const url = new URL(`${definition.endpoint}${stagePart}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query || {})) if (value !== '') url.searchParams.set(key, value);
    const response = await fetch(url, { method, headers: headers || {}, body: ['GET','HEAD'].includes(method) ? undefined : body || undefined, signal: AbortSignal.timeout(30_000) });
    const text = (await response.text()).slice(0, 1_000_000); let parsed; try { parsed = JSON.parse(text); } catch {}
    return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), body: parsed ?? text, truncated: text.length >= 1_000_000 };
  }
}

function optional(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function objectOrUndefined(value) { return value && typeof value === 'object' && Object.keys(value).length ? value : undefined; }
function clampLimit(value) { return Math.min(Math.max(Number(value) || 50, 1), 250); }
function s3Object(o) { return { key: o.Key, size: o.Size, modified: o.LastModified, etag: o.ETag, storageClass: o.StorageClass }; }
function contentTypeFor(key) { const ext=key.toLowerCase().split('.').pop();return ({pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',txt:'text/plain',md:'text/markdown',json:'application/json',csv:'text/csv',html:'text/plain',xml:'text/xml'}[ext]||'application/octet-stream'); }
function lambdaName(value) { return String(value || '').match(/:function:([^:]+)/)?.[1] || String(value || ''); }
function matchesFunction(mapping, functionName) { return lambdaName(mapping.FunctionArn) === lambdaName(functionName); }
function mappingSummary(m) { return { uuid: m.UUID, state: m.State, stateTransitionReason: m.StateTransitionReason, eventSourceArn: m.EventSourceArn, batchSize: m.BatchSize, maximumBatchingWindowInSeconds: m.MaximumBatchingWindowInSeconds, parallelizationFactor: m.ParallelizationFactor, startingPosition: m.StartingPosition, maximumRetryAttempts: m.MaximumRetryAttempts, maximumRecordAgeInSeconds: m.MaximumRecordAgeInSeconds, bisectBatchOnFunctionError: m.BisectBatchOnFunctionError, functionResponseTypes: m.FunctionResponseTypes, filterCriteria: m.FilterCriteria, destinationConfig: m.DestinationConfig, lastModified: m.LastModified }; }
