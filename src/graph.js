// Labels shared by the CloudFormation, Terraform and Pulumi graph builders, so
// the same relationship reads the same way whichever framework declared it.
export function triggerLabel(sourceType) {
  return ({
    'AWS::S3::Bucket': 'object event', 'AWS::SNS::Topic': 'notifies', 'AWS::Events::Rule': 'event rule', 'AWS::Events::EventBus': 'event bus',
    'AWS::ApiGateway::RestApi': 'HTTP request', 'AWS::ApiGatewayV2::Api': 'HTTP request', 'AWS::Cognito::UserPool': 'Cognito trigger'
  }[sourceType] || 'invokes');
}
// An event source mapping polls its source, so a queue reads as an invocation
// while a stream or table reads as the change feed it is.
export function eventSourceLabel(sourceType) {
  return sourceType === 'AWS::SQS::Queue' ? 'invokes' : 'stream event';
}
