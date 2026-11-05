import { Annotations, Aws, CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export const PROJECT_TAG_KEY = "project";
export const PROJECT_TAG_VALUE = "no-code-cht-config";
export const DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
export const DEFAULT_UI_ORIGINS = ["http://localhost:5173"];

// 6x the 15 minute Lambda timeout (AWS guidance for SQS event sources), also well above the run
// lease (LEASE_MS 960000 on Lambda). Recovery of a cut-off run is the 5 minute resume schedule, so the
// longer wait before SQS redelivers is acceptable.
const VISIBILITY_TIMEOUT = Duration.seconds(5400);

// Reads the uiOrigins context. cdk.json can hold a real array, but `-c uiOrigins=...` always arrives as a
// string, so a string may be a JSON array ('["https://a","https://b"]'), one origin or a comma separated
// list. Unset or empty gives the localhost default; anything malformed throws rather than silently
// falling back to localhost, which would block the real UI with CORS errors after deploy.
export function resolveUiOrigins(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_UI_ORIGINS;
  let list: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text.startsWith("[")) {
      try {
        list = JSON.parse(text);
      } catch {
        throw new Error("context uiOrigins looks like a JSON array but does not parse");
      }
    } else {
      list = text.split(",").map((o) => o.trim()).filter((o) => o !== "");
    }
  }
  if (!Array.isArray(list)) throw new Error("context uiOrigins must be an array, a JSON array string or a comma separated string");
  if (list.length === 0) return DEFAULT_UI_ORIGINS;
  const origins = list.map((o) => (typeof o === "string" ? o.trim() : o));
  if (origins.includes("*")) throw new Error("context uiOrigins must list explicit origins; a wildcard is not allowed");
  for (const o of origins) {
    if (typeof o !== "string" || !/^https?:\/\/[^/\s]+$/.test(o)) {
      throw new Error(`context uiOrigins entry ${JSON.stringify(o)} must be an origin such as https://app.example.org (scheme and host, no path)`);
    }
  }
  return origins as string[];
}

// "us.anthropic.claude-..." -> "anthropic.claude-..." (strip the cross-region profile prefix).
export function baseModelId(modelId: string): string {
  return modelId.replace(/^(us|eu|apac|global|us-gov)\./, "");
}

function tableOf(scope: Construct, id: string, partitionKey: dynamodb.Attribute, sortKey?: dynamodb.Attribute): dynamodb.Table {
  return new dynamodb.Table(scope, id, {
    partitionKey,
    sortKey,
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    encryption: dynamodb.TableEncryption.DEFAULT,
    removalPolicy: RemovalPolicy.RETAIN,
  });
}

export class OrchestratorDataStack extends Stack {
  public readonly runsTable: dynamodb.Table;
  public readonly stepsTable: dynamodb.Table;
  public readonly versionsTable: dynamodb.Table;
  public readonly commentsTable: dynamodb.Table;
  public readonly auditTable: dynamodb.Table;
  public readonly artifactBucket: s3.Bucket;
  public readonly uploadQueue: sqs.Queue;
  public readonly uploadDlq: sqs.Queue;
  /** Attach this to whatever compute role is created later (compute is deliberately not part of this stack). */
  public readonly appPolicy: iam.ManagedPolicy;
  public readonly bedrockPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const uiOrigins = resolveUiOrigins(this.node.tryGetContext("uiOrigins"));
    const ctxModel = this.node.tryGetContext("modelId") as unknown;
    const modelId = typeof ctxModel === "string" && ctxModel !== "" ? ctxModel : DEFAULT_MODEL_ID;
    if (!this.node.tryGetContext("uiOrigins")) {
      Annotations.of(this).addInfo("context uiOrigins not set; CORS falls back to http://localhost:5173");
    }

    // Tables. Key layout follows the header of Backend/src/store/dynamoStore.ts.
    const S = dynamodb.AttributeType.STRING;
    const runId = { name: "runId", type: S };
    this.runsTable = tableOf(this, "RunsTable", runId);
    this.stepsTable = tableOf(this, "StepsTable", runId, { name: "sk", type: S });
    this.versionsTable = tableOf(this, "VersionsTable", runId, { name: "n", type: dynamodb.AttributeType.NUMBER });
    this.commentsTable = tableOf(this, "CommentsTable", runId, { name: "sk", type: S });
    this.auditTable = tableOf(this, "AuditTable", runId, { name: "sk", type: S });
    const tables = [this.runsTable, this.stepsTable, this.versionsTable, this.commentsTable, this.auditTable];

    // Queues.
    this.uploadDlq = new sqs.Queue(this, "UploadDlq", {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    this.uploadQueue = new sqs.Queue(this, "UploadQueue", {
      visibilityTimeout: VISIBILITY_TIMEOUT,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: this.uploadDlq, maxReceiveCount: 5 },
    });

    // Bucket.
    this.artifactBucket = new s3.Bucket(this, "ArtifactBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: uiOrigins,
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
    });
    // CDK adds the S3 -> SQS SendMessage queue policy statement for this notification.
    this.artifactBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(this.uploadQueue),
      { prefix: "runs/", suffix: "/input/guideline.pdf" },
    );

    // Application policy, scoped to the resources above. Actions mirror the SDK commands the
    // Backend issues: Get/Put/Update/Query/Scan/TransactWrite on DynamoDB (TransactWriteItems is
    // authorised through the per-item Put/Update/ConditionCheck actions; ConditionCheckItem is for the
    // sign-off write, which checks the versions table's latest pointer, DEC-019), Get/Put/Head on S3 (HeadObject needs
    // s3:GetObject; s3:ListBucket is added so a missing key returns 404 instead of 403), Receive/Delete
    // on SQS (Bedrock Converse, authorised by bedrock:InvokeModel, is in the separate bedrockPolicy).
    this.appPolicy = new iam.ManagedPolicy(this, "OrchestratorAppPolicy", {
      description: "Least-privilege runtime access for the CHT config orchestrator",
      statements: [
        new iam.PolicyStatement({
          sid: "DynamoTables",
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:ConditionCheckItem",
            "dynamodb:Query",
            "dynamodb:Scan",
          ],
          resources: tables.map((t) => t.tableArn),
        }),
        new iam.PolicyStatement({
          sid: "ArtifactObjects",
          actions: ["s3:GetObject", "s3:PutObject"],
          resources: [this.artifactBucket.arnForObjects("*")],
        }),
        new iam.PolicyStatement({
          sid: "ArtifactBucketList",
          actions: ["s3:ListBucket"],
          resources: [this.artifactBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          sid: "UploadQueueConsume",
          actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
          resources: [this.uploadQueue.queueArn],
        }),
      ],
    });

    // Separate from the app policy so the Lambda role can omit it when the model is reached via AgentCore.
    this.bedrockPolicy = new iam.ManagedPolicy(this, "BedrockInvokePolicy", {
      description: "Direct Bedrock model invocation; attached to the Lambda role only when modelBackend=bedrock",
      statements: [
        new iam.PolicyStatement({
          sid: "BedrockInvoke",
          actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          resources: [
            this.formatArn({
              service: "bedrock",
              resource: "inference-profile",
              resourceName: modelId,
              account: Aws.ACCOUNT_ID,
            }),
            // Cross-region inference routes to the foundation model in any US region, hence the wildcard.
            `arn:${Aws.PARTITION}:bedrock:*::foundation-model/${baseModelId(modelId)}`,
          ],
        }),
      ],
    });

    // Outputs. Descriptions name the Backend env var each value feeds.
    const out = (id: string, value: string, envVar: string): void => {
      new CfnOutput(this, id, { value, description: envVar });
    };
    out("TABLERUNS", this.runsTable.tableName, "TABLE_RUNS");
    out("TABLESTEPS", this.stepsTable.tableName, "TABLE_STEPS");
    out("TABLEVERSIONS", this.versionsTable.tableName, "TABLE_VERSIONS");
    out("TABLECOMMENTS", this.commentsTable.tableName, "TABLE_COMMENTS");
    out("TABLEAUDIT", this.auditTable.tableName, "TABLE_AUDIT");
    out("ARTIFACTBUCKET", this.artifactBucket.bucketName, "ARTIFACT_BUCKET");
    out("UPLOADQUEUEURL", this.uploadQueue.queueUrl, "UPLOAD_QUEUE_URL");
    out("MODELID", modelId, "MODEL_ID");
    out("UPLOADDLQURL", this.uploadDlq.queueUrl, "UPLOAD_DLQ_URL (monitoring only)");
    out("APPPOLICYARN", this.appPolicy.managedPolicyArn, "policy ARN (attach to the compute role)");

    Tags.of(this).add(PROJECT_TAG_KEY, PROJECT_TAG_VALUE);
  }
}
