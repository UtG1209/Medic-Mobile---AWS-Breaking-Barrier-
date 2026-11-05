import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { OrchestratorDataStack } from "../lib/data-stack";

function build(context: Record<string, unknown> = {}): Template {
  const app = new App({ context });
  const stack = new OrchestratorDataStack(app, "T", { env: { region: "us-west-2", account: "111111111111" } });
  return Template.fromStack(stack);
}
const t = build();

const tableKeys = (t2: Template): unknown[] =>
  Object.values(t2.findResources("AWS::DynamoDB::Table")).map((r) => (r as any).Properties.KeySchema);

describe("dynamo tables", () => {
  it("creates five pay-per-request PITR retained tables without fixed names", () => {
    t.resourceCountIs("AWS::DynamoDB::Table", 5);
    for (const r of Object.values(t.findResources("AWS::DynamoDB::Table")) as any[]) {
      expect(r.Properties.BillingMode).toBe("PAY_PER_REQUEST");
      expect(r.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
      expect(r.Properties.TableName).toBeUndefined();
      expect(r.DeletionPolicy).toBe("Retain");
      expect(r.UpdateReplacePolicy).toBe("Retain");
    }
  });
  const hashOnly = [{ AttributeName: "runId", KeyType: "HASH" }];
  const withRange = (n: string) => [...hashOnly, { AttributeName: n, KeyType: "RANGE" }];
  it("has the documented key schemas", () => {
    const keys = tableKeys(t);
    expect(keys.filter((k) => JSON.stringify(k) === JSON.stringify(hashOnly))).toHaveLength(1);
    expect(keys.filter((k) => JSON.stringify(k) === JSON.stringify(withRange("sk")))).toHaveLength(3);
    expect(keys.filter((k) => JSON.stringify(k) === JSON.stringify(withRange("n")))).toHaveLength(1);
  });
  it("types the range key of versions as number and others as string", () => {
    const tables = Object.values(t.findResources("AWS::DynamoDB::Table")) as any[];
    const versions = tables.filter((x) => x.Properties.KeySchema.some((k: any) => k.AttributeName === "n"));
    expect(versions).toHaveLength(1);
    expect(versions[0].Properties.AttributeDefinitions).toEqual(
      expect.arrayContaining([
        { AttributeName: "runId", AttributeType: "S" },
        { AttributeName: "n", AttributeType: "N" },
      ]),
    );
    const sk = tables.filter((x) => x.Properties.KeySchema.some((k: any) => k.AttributeName === "sk"));
    for (const s of sk) expect(s.Properties.AttributeDefinitions).toContainEqual({ AttributeName: "sk", AttributeType: "S" });
  });
});

describe("bucket", () => {
  const bucket = () => Object.values(t.findResources("AWS::S3::Bucket"))[0] as any;
  it("blocks public access, encrypts, retains, no versioning", () => {
    t.resourceCountIs("AWS::S3::Bucket", 1);
    const p = bucket().Properties;
    expect(p.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    });
    expect(p.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm).toBe("AES256");
    expect(p.VersioningConfiguration).toBeUndefined();
    expect(bucket().DeletionPolicy).toBe("Retain");
  });
  it("enforces SSL", () => {
    t.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: { Statement: Match.arrayWith([
        Match.objectLike({ Effect: "Deny", Action: "s3:*", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
      ]) },
    });
  });
  it("has CORS and multipart abort lifecycle", () => {
    const p = bucket().Properties;
    expect(p.CorsConfiguration.CorsRules).toEqual([
      {
        AllowedMethods: ["PUT", "GET", "HEAD"],
        AllowedOrigins: ["http://localhost:5173"],
        AllowedHeaders: ["*"],
        ExposedHeaders: ["ETag"],
        MaxAge: 3000,
      },
    ]);
    expect(p.LifecycleConfiguration.Rules[0].AbortIncompleteMultipartUpload.DaysAfterInitiation).toBe(1);
  });
  it("takes CORS origins from context and never wildcards by default", () => {
    const p = (Object.values(build({ uiOrigins: ["https://a.example", "https://b.example"] }).findResources("AWS::S3::Bucket"))[0] as any).Properties;
    expect(p.CorsConfiguration.CorsRules[0].AllowedOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(bucket().Properties.CorsConfiguration.CorsRules[0].AllowedOrigins).not.toContain("*");
  });
  // The CDK CLI passes every `-c key=value` as a string, so uiOrigins must parse from strings too.
  describe("uiOrigins given as the CLI passes it (a string)", () => {
    const origins = (ctx: unknown): unknown =>
      (Object.values(build({ uiOrigins: ctx }).findResources("AWS::S3::Bucket"))[0] as any).Properties.CorsConfiguration.CorsRules[0].AllowedOrigins;
    it("accepts a JSON array string", () => {
      expect(origins('["https://a.example","https://b.example"]')).toEqual(["https://a.example", "https://b.example"]);
    });
    it("accepts one bare origin", () => {
      expect(origins("https://a.example")).toEqual(["https://a.example"]);
    });
    it("accepts a comma separated list and trims spaces", () => {
      expect(origins("https://a.example, https://b.example")).toEqual(["https://a.example", "https://b.example"]);
    });
    it("rejects a wildcard inside a string", () => {
      expect(() => build({ uiOrigins: '["*"]' })).toThrow(/wildcard/);
      expect(() => build({ uiOrigins: "*" })).toThrow(/wildcard/);
    });
    it("rejects values that are not http(s) origins instead of falling back to localhost", () => {
      expect(() => build({ uiOrigins: "app.example.org" })).toThrow(/uiOrigins/);
      expect(() => build({ uiOrigins: "[1,2]" })).toThrow(/uiOrigins/);
      expect(() => build({ uiOrigins: 5 })).toThrow(/uiOrigins/);
    });
    it("falls back to localhost only when unset or empty", () => {
      expect(origins(undefined)).toEqual(["http://localhost:5173"]);
      expect(origins("")).toEqual(["http://localhost:5173"]);
      expect(origins([])).toEqual(["http://localhost:5173"]);
    });
  });
  it("notifies the queue on input pdf creation only", () => {
    const custom = Object.values(t.findResources("Custom::S3BucketNotifications")) as any[];
    expect(custom).toHaveLength(1);
    const q = custom[0].Properties.NotificationConfiguration.QueueConfigurations;
    expect(q).toHaveLength(1);
    expect(q[0].Events).toEqual(["s3:ObjectCreated:*"]);
    expect(q[0].Filter.Key.FilterRules).toEqual(
      expect.arrayContaining([
        { Name: "prefix", Value: "runs/" },
        { Name: "suffix", Value: "/input/guideline.pdf" },
      ]),
    );
  });
});

describe("queues", () => {
  it("has a main queue with 5400s visibility, SSE, and redrive after 5", () => {
    t.resourceCountIs("AWS::SQS::Queue", 2);
    t.hasResourceProperties("AWS::SQS::Queue", {
      VisibilityTimeout: 5400,
      SqsManagedSseEnabled: true,
      RedrivePolicy: { maxReceiveCount: 5, deadLetterTargetArn: Match.anyValue() },
    });
  });
  it("has a DLQ with 14 day retention", () => {
    t.hasResourceProperties("AWS::SQS::Queue", { MessageRetentionPeriod: 1209600, SqsManagedSseEnabled: true });
  });
  it("enforces SSL on both queues", () => {
    const pols = Object.values(t.findResources("AWS::SQS::QueuePolicy")) as any[];
    const ssl = pols.filter((p) =>
      JSON.stringify(p.Properties.PolicyDocument).includes('"aws:SecureTransport":"false"'),
    );
    expect(ssl.length).toBe(2);
  });
  it("lets only this bucket send to the main queue", () => {
    const [mainId] = Object.entries(t.findResources("AWS::SQS::Queue")).find(([, q]: any) => q.Properties.RedrivePolicy)!;
    const bucketId = Object.keys(t.findResources("AWS::S3::Bucket"))[0];
    const pols = Object.values(t.findResources("AWS::SQS::QueuePolicy")) as any[];
    const send = pols
      .flatMap((p) => p.Properties.PolicyDocument.Statement as any[])
      .find((st) => JSON.stringify(st.Action).includes("sqs:SendMessage"));
    expect(send.Principal).toEqual({ Service: "s3.amazonaws.com" });
    expect(send.Resource).toEqual({ "Fn::GetAtt": [mainId, "Arn"] });
    expect(send.Condition.ArnLike["aws:SourceArn"]).toEqual({ "Fn::GetAtt": [bucketId, "Arn"] });
  });
});

describe("app policy", () => {
  const stmts = (): any[] => {
    const pols = Object.entries(t.findResources("AWS::IAM::ManagedPolicy")).filter(([k]) => k.startsWith("OrchestratorAppPolicy")) as any[];
    expect(pols).toHaveLength(1);
    return pols[0][1].Properties.PolicyDocument.Statement;
  };
  const bedrockStmts = (): any[] => {
    const pols = Object.entries(t.findResources("AWS::IAM::ManagedPolicy")).filter(([k]) => k.startsWith("BedrockInvokePolicy")) as any[];
    expect(pols).toHaveLength(1);
    return pols[0][1].Properties.PolicyDocument.Statement;
  };
  const actions = (s: any): string[] => ([] as string[]).concat(s.Action);
  const resources = (s: any): unknown[] => ([] as unknown[]).concat(s.Resource);

  it("lets CDK generate the policy name and has no export names", () => {
    const p = Object.values(t.findResources("AWS::IAM::ManagedPolicy"))[0] as any;
    expect(p.Properties.ManagedPolicyName).toBeUndefined();
    for (const o of Object.values(t.toJSON().Outputs as Record<string, any>)) expect(o.Export).toBeUndefined();
  });
  it("has no wildcard resource for dynamodb, s3, sqs", () => {
    for (const s of stmts()) {
      if (actions(s).some((a) => /^(dynamodb|s3|sqs):/.test(a))) {
        for (const r of resources(s)) {
          expect(r).not.toBe("*");
          const flat = JSON.stringify(r);
          // only the object-key wildcard of the bucket is allowed
          expect(flat.replace('/*"', '"')).not.toContain("*");
        }
      }
    }
  });
  const refOf = (logicalPrefix: string, type: string): string => {
    const ids = Object.keys(t.findResources(type)).filter((k) => k.startsWith(logicalPrefix));
    expect(ids).toHaveLength(1);
    return ids[0];
  };
  it("grants only the dynamodb actions the code uses, on exactly the five tables", () => {
    const s = stmts().find((x) => actions(x).some((a) => a.startsWith("dynamodb:")));
    expect(actions(s).sort()).toEqual(
      ["dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:UpdateItem"].sort(),
    );
    const got = resources(s).map((r: any) => r["Fn::GetAtt"][0]).sort();
    const want = ["RunsTable", "StepsTable", "VersionsTable", "CommentsTable", "AuditTable"]
      .map((p) => refOf(p, "AWS::DynamoDB::Table"))
      .sort();
    expect(got).toEqual(want);
  });
  it("scopes s3 to bucket objects plus ListBucket on the bucket, and sqs to the upload queue", () => {
    const bucketId = refOf("ArtifactBucket", "AWS::S3::Bucket");
    const objs = stmts().find((x) => actions(x).includes("s3:GetObject"));
    expect(actions(objs).sort()).toEqual(["s3:GetObject", "s3:PutObject"]);
    expect(JSON.stringify(resources(objs))).toContain(bucketId);
    expect(JSON.stringify(resources(objs))).toContain("/*");
    const list = stmts().find((x) => actions(x).includes("s3:ListBucket"));
    expect(actions(list)).toEqual(["s3:ListBucket"]);
    expect(resources(list)).toEqual([{ "Fn::GetAtt": [bucketId, "Arn"] }]);
    const sqs = stmts().find((x) => actions(x).some((a) => a.startsWith("sqs:")));
    expect(actions(sqs).sort()).toEqual(["sqs:DeleteMessage", "sqs:ReceiveMessage"]);
    const queues = Object.entries(t.findResources("AWS::SQS::Queue")).filter(([, q]: any) => q.Properties.RedrivePolicy);
    expect(queues).toHaveLength(1);
    expect(resources(sqs)).toEqual([{ "Fn::GetAtt": [queues[0][0], "Arn"] }]);
  });
  it("allows bedrock on profile and foundation model arns", () => {
    expect(stmts().some((x) => actions(x).some((a) => a.startsWith("bedrock:")))).toBe(false);
    expect(bedrockStmts()).toHaveLength(1);
    const b = bedrockStmts()[0];
    expect(actions(b).sort()).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
    const json = JSON.stringify(resources(b));
    expect(json).toContain("inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(json).toContain("foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(json).toContain(":bedrock:*::foundation-model/");
    expect(json).not.toMatch(/\d{12}/);
  });
  it("derives the base model id from the context modelId", () => {
    const json = JSON.stringify(build({ modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }).toJSON());
    expect(json).toContain("foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0");
  });
});

describe("outputs and tags", () => {
  it("emits every env value", () => {
    const outs = t.toJSON().Outputs as Record<string, { Description: string }>;
    for (const n of ["TABLERUNS", "TABLESTEPS", "TABLEVERSIONS", "TABLECOMMENTS", "TABLEAUDIT", "ARTIFACTBUCKET", "UPLOADQUEUEURL", "MODELID", "UPLOADDLQURL", "APPPOLICYARN"]) {
      expect(outs[n], n).toBeDefined();
    }
    expect(outs.TABLERUNS.Description).toContain("TABLE_RUNS");
    expect(outs.UPLOADQUEUEURL.Description).toContain("UPLOAD_QUEUE_URL");
  });
  it("tags every resource that supports tags", () => {
    const json = t.toJSON().Resources as Record<string, any>;
    const taggable = ["AWS::DynamoDB::Table", "AWS::S3::Bucket", "AWS::SQS::Queue", "AWS::IAM::ManagedPolicy"];
    // IAM managed policies have no Tags property; the others must carry the tag.
    const must = Object.entries(json).filter(([, r]) => taggable.slice(0, 3).includes(r.Type));
    expect(must).toHaveLength(8);
    for (const [id, r] of must) {
      expect((r.Properties.Tags ?? []).some((x: any) => x.Key === "project" && x.Value === "no-code-cht-config"), id).toBe(true);
    }
  });
  it("hard-codes no account id", () => {
    expect(JSON.stringify(t.toJSON())).not.toContain("111111111111");
  });
});
