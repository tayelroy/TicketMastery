import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { S3Client } from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { createHandler } from './handler.js';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Clients are created once per execution environment and reused across invocations. Region and credentials come
// from the Lambda runtime (AWS_REGION + execution role).
export const handler = createHandler({
  s3: new S3Client({}),
  // The SES sandbox allows 1 email per second; the SDK backs off and retries throttling errors a few more times
  // before the record is handed back to SQS.
  ses: new SESv2Client({ maxAttempts: 6 }),
  cognito: new CognitoIdentityProviderClient({}),
  bucket: requiredEnv('TICKET_PDF_BUCKET'),
  fromAddress: requiredEnv('SES_FROM_ADDRESS'),
  userPoolId: requiredEnv('COGNITO_USER_POOL_ID'),
});
