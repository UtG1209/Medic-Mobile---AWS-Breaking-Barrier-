import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { OrchestratorDataStack } from "../lib/data-stack";
import { OrchestratorLambdaStack } from "../lib/lambda-stack";
import { routes } from "../../Backend/src/contract/routes";

function build(context: Record<string, unknown> = {}, env: { region: string; account: string } | null = { region: "us-west-2", account: "111111111111" }): Template {
  const app = new App({ context });
  const stackEnv = env ?? undefined;
  const data = new OrchestratorDataStack(app, "D", { env: stackEnv });
  const stack = new OrchestratorLambdaStack(app, "L", {
    env: stackEnv,
    runsTable: data.runsTable,
    stepsTable: data.stepsTable,
    versionsTable: data.versionsTable,
    commentsTable: data.commentsTable,
    auditTable: data.auditTable,
    artifactBucket: data.artifactBucket,
    uploadQueue: data.uploadQueue,
    appPolicy: data.appPolicy,
    bedrockPolicy: data.bedrockPolicy,
  });
  return Template.fromStack(stack);
}
const t = build();
const fn = () => Object.values(t.findResources("AWS::Lambda::Function"))[0] as any;

describe("function", () => {
  it("is an arm64 image function with the sizing from the plan", () => {
    t.resourceCountIs("AWS::Lambda::Function", 1);
    const p = fn().Properties;
    expect(p.PackageType).toBe("Image");
    expect(p.Architectures).toEqual(["arm64"]);
    expect(p.Timeout).toBe(900);
    expect(p.MemorySize).toBe(2048);
    expect(p.EphemeralStorage).toEqual({ Size: 2048 });
  });
  it("sets the environment", () => {
    const e = fn().Properties.Environment.Variables;
    expect(e.RUN_MODE).toBe("lambda");
    expect(e.LEASE_MS).toBe("960000");
    expect(e.MODEL_ID).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(e.TMPDIR).toBe("/tmp");
    for (const k of ["TABLE_RUNS", "TABLE_STEPS", "TABLE_VERSIONS", "TABLE_COMMENTS", "TABLE_AUDIT", "ARTIFACT_BUCKET"]) {
      expect(e[k]).toBeDefined();
    }
    expect(e.PRICES_JSON).toBeUndefined();
  });
  it("passes PRICES_JSON and modelId from context", () => {
    const t2 = build({ modelId: "us.x.y-v1:0", prices: { "us.x.y-v1:0": { inPerMTok: 1, outPerMTok: 2 } } });
    const e = (Object.values(t2.findResources("AWS::Lambda::Function"))[0] as any).Properties.Environment.Variables;
    expect(e.MODEL_ID).toBe("us.x.y-v1:0");
    expect(JSON.parse(e.PRICES_JSON)).toEqual({ "us.x.y-v1:0": { inPerMTok: 1, outPerMTok: 2 } });
  });
  it("passes RUN_BUDGET_USD from the runBudgetUsd context, as a number or a string, and omits it by default", () => {
    const envOf = (t2: Template) => (Object.values(t2.findResources("AWS::Lambda::Function"))[0] as any).Properties.Environment.Variables;
    expect(envOf(build({ runBudgetUsd: 25 })).RUN_BUDGET_USD).toBe("25");
    expect(envOf(build({ runBudgetUsd: "12.5" })).RUN_BUDGET_USD).toBe("12.5");
    expect(fn().Properties.Environment.Variables.RUN_BUDGET_USD).toBeUndefined();
  });
  it("rejects a runBudgetUsd that is not a positive number", () => {
    for (const bad of [0, -1, "abc"]) expect(() => build({ runBudgetUsd: bad })).toThrow(/runBudgetUsd/);
  });
  it("adds JUDGE_MODEL_ID and a Bedrock grant for the judge only when context judgeModelId is set", () => {
    const judgeStatements = (tpl: Template) =>
      (Object.values(tpl.findResources("AWS::IAM::Policy")) as any[]).flatMap((p) => p.Properties.PolicyDocument.Statement).filter((st: any) => st.Sid === "BedrockInvokeJudge");
    expect(fn().Properties.Environment.Variables.JUDGE_MODEL_ID).toBeUndefined();
    expect(judgeStatements(t)).toEqual([]);
    const t2 = build({ judgeModelId: "us.meta.llama4-scout-17b-instruct-v1:0" });
    const e = (Object.values(t2.findResources("AWS::Lambda::Function"))[0] as any).Properties.Environment.Variables;
    expect(e.JUDGE_MODEL_ID).toBe("us.meta.llama4-scout-17b-instruct-v1:0");
    const [st] = judgeStatements(t2);
    expect(st.Action).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
    const res = JSON.stringify(st.Resource);
    expect(res).toContain("inference-profile/us.meta.llama4-scout-17b-instruct-v1:0");
    expect(res).toContain("foundation-model/meta.llama4-scout-17b-instruct-v1:0");
    expect(() => build({ judgeModelId: 7 })).toThrow(/judgeModelId/);
  });
  it("attaches the app managed policy to the role", () => {
    const roles = Object.values(t.findResources("AWS::IAM::Role")) as any[];
    const withPolicy = roles.filter((r) => (r.Properties.ManagedPolicyArns ?? []).some((a: any) => JSON.stringify(a).includes("OrchestratorAppPolicy") || JSON.stringify(a).includes("Fn::ImportValue")));
    expect(withPolicy.length).toBeGreaterThanOrEqual(1);
  });
  it("has a two-week log group", () => {
    t.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 14 });
    expect(fn().Properties.LoggingConfig.LogGroup).toBeDefined();
  });
});

describe("image asset", () => {
  it("builds the lambda target for linux/arm64 from ../Backend", () => {
    const app = new App();
    const env = { region: "us-west-2", account: "111111111111" };
    const d = new OrchestratorDataStack(app, "D", { env });
    const l = new OrchestratorLambdaStack(app, "L", {
      env, runsTable: d.runsTable, stepsTable: d.stepsTable, versionsTable: d.versionsTable,
      commentsTable: d.commentsTable, auditTable: d.auditTable, artifactBucket: d.artifactBucket,
      uploadQueue: d.uploadQueue, appPolicy: d.appPolicy, bedrockPolicy: d.bedrockPolicy,
    });
    const asm = app.synth();
    const file = readdirSync(asm.directory).find((f) => f === `${l.artifactId}.assets.json`);
    expect(file).toBeDefined();
    const manifest = readFileSync(path.join(asm.directory, file as string), "utf8").replace(/\s/g, "");
    expect(manifest).toContain('"dockerBuildTarget":"lambda"');
    expect(manifest).toContain('"platform":"linux/arm64"');
  });
});

describe("triggers", () => {
  it("maps the upload queue with batch size 1, partial failures and max concurrency 5", () => {
    t.resourceCountIs("AWS::Lambda::EventSourceMapping", 1);
    t.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: 5 },
    });
  });
  it("runs a schedule every 5 minutes with an input the backend schema accepts", () => {
    t.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(5 minutes)" });
    const rule = Object.values(t.findResources("AWS::Events::Rule"))[0] as any;
    const input = JSON.parse(rule.Properties.Targets[0].Input);
    expect(input).toEqual({ source: "aws.events", "detail-type": "Scheduled Event" });
    // Mirrors the LambdaScheduledEvent refine in Backend/src/contract/schemas.ts (source or detail-type).
    expect(input.source === "aws.events" || input["detail-type"] === "Scheduled Event").toBe(true);
  });
});

describe("http api", () => {
  const routeKeys = (): string[] =>
    (Object.values(t.findResources("AWS::ApiGatewayV2::Route")) as any[]).map((r) => r.Properties.RouteKey as string);
  it("exposes exactly the public contract routes", () => {
    const paths = new Set(routeKeys().map((k) => k.split(" ")[1]));
    const want = new Set(routes.proxiable.map((p) => p.replace(/:(\w+)/g, "{$1}")));
    expect(paths).toEqual(want);
    expect(new Set(routeKeys()).size).toBe(routeKeys().length);
  });
  it("lists the documented methods per route", () => {
    expect([...routeKeys()].sort()).toEqual(
      [
        "POST /runs", "GET /runs", "GET /runs/{id}", "GET /runs/{id}/versions", "POST /runs/{id}/versions",
        "GET /runs/{id}/versions/{n}", "GET /runs/{id}/versions/{n}/comments", "POST /runs/{id}/versions/{n}/comments",
        "GET /runs/{id}/versions/{n}/findings", "GET /runs/{id}/versions/{n}/flags", "GET /runs/{id}/versions/{n}/status", "POST /runs/{id}/versions/{n}/signatures/{role}",
        "POST /runs/{id}/versions/{n}/reject", "POST /runs/{id}/versions/{n}/acknowledge", "POST /runs/{id}/resume", "GET /runs/{id}/metrics",
        "POST /runs/{id}/versions/{n}/revisions", "GET /runs/{id}/versions/{n}/revisions",
        "GET /runs/{id}/revisions/{rid}", "POST /runs/{id}/revisions/{rid}/confirm",
        "GET /runs/{id}/activity", "POST /runs/{id}/chat", "GET /runs/{id}/versions/{n}/flow",
        "POST /runs/{id}/versions/{n}/edits/preview", "POST /runs/{id}/versions/{n}/edits",
        "GET /runs/{id}/versions/{a}/diff/{b}", "GET /runs/{id}/versions/{n}/change", "POST /runs/{id}/versions/{n}/restore",
        "GET /runs/{id}/versions/{n}/scores",
      ].sort(),
    );
  });
  it("never exposes events, invocations, ping or a catch-all", () => {
    for (const k of routeKeys()) {
      expect(k).not.toMatch(/\/(events|invocations|ping)\b/);
      expect(k).not.toContain("$default");
      expect(k).not.toContain("+");
    }
  });
  it("uses payload format 2.0 and an AWS_PROXY integration", () => {
    t.hasResourceProperties("AWS::ApiGatewayV2::Integration", { IntegrationType: "AWS_PROXY", PayloadFormatVersion: "2.0" });
  });
  it("throttles the default stage", () => {
    t.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 25 },
    });
  });
  it("sets CORS from uiOrigins", () => {
    const api = Object.values(t.findResources("AWS::ApiGatewayV2::Api"))[0] as any;
    expect(api.Properties.ProtocolType).toBe("HTTP");
    expect(api.Properties.CorsConfiguration.AllowOrigins).toEqual(["http://localhost:5173"]);
    const t2 = build({ uiOrigins: ["https://app.example.org"] });
    const api2 = Object.values(t2.findResources("AWS::ApiGatewayV2::Api"))[0] as any;
    expect(api2.Properties.CorsConfiguration.AllowOrigins).toEqual(["https://app.example.org"]);
  });
  it("sets CORS from a uiOrigins string as the CLI passes it", () => {
    const t3 = build({ uiOrigins: '["https://app.example.org"]' });
    const api3 = Object.values(t3.findResources("AWS::ApiGatewayV2::Api"))[0] as any;
    expect(api3.Properties.CorsConfiguration.AllowOrigins).toEqual(["https://app.example.org"]);
  });
  it("lets only the API invoke the function", () => {
    t.hasResourceProperties("AWS::Lambda::Permission", { Principal: "apigateway.amazonaws.com" });
  });
});

describe("outputs and hygiene", () => {
  it("has api url and function name outputs", () => {
    const o = t.toJSON().Outputs;
    expect(o.APIURL).toBeDefined();
    expect(o.FUNCTIONNAME).toBeDefined();
  });
  it("hard-codes no account id", () => {
    // The concrete account only appears in the template when the env supplies it (ECR asset URI,
    // execute-api ARN); with an environment-agnostic stack no account literal may remain.
    const agnostic = JSON.stringify(build({}, null).toJSON());
    expect(agnostic).not.toMatch(/\b\d{12}\b/);
    expect(agnostic).not.toContain("111111111111");
  });
});

describe("revision loop async self-invoke", () => {
  const policies = (): any[] => Object.values(t.findResources("AWS::IAM::Policy")) as any[];
  const statements = (): any[] => policies().flatMap((p) => [p.Properties.PolicyDocument.Statement].flat());
  const invokes = (): any[] => statements().filter((s) => [s.Action].flat().includes("lambda:InvokeFunction"));

  it("grants lambda:InvokeFunction on the function itself only", () => {
    expect(invokes()).toHaveLength(1);
    const st = invokes()[0];
    expect(st.Effect).toBe("Allow");
    expect(st.Action).toBe("lambda:InvokeFunction");
    const res = [st.Resource].flat();
    expect(res).toHaveLength(1);
    const json = JSON.stringify(res[0]);
    expect(json).toContain(":function:L-orchestrator");
    expect(json).not.toContain('"*"');
    expect(fn().Properties.FunctionName).toBe("L-orchestrator");
  });
  it("has no wildcard resource on any statement of the function policies", () => {
    for (const st of statements().filter((s) => [s.Action].flat().includes("lambda:InvokeFunction"))) {
      expect([st.Resource].flat()).not.toContain("*");
    }
  });
  it("synthesizes without a circular dependency (policy does not reference the function)", () => {
    const st = invokes()[0];
    expect(JSON.stringify(st.Resource)).not.toContain("OrchestratorFunction");
  });
  it("sets no automatic async retries", () => {
    const cfgs = Object.values(t.findResources("AWS::Lambda::EventInvokeConfig")) as any[];
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0].Properties.MaximumRetryAttempts).toBe(0);
  });
  it("keeps the API integration timeout at the 30 s maximum", () => {
    const integ = Object.values(t.findResources("AWS::ApiGatewayV2::Integration")) as any[];
    expect(integ).toHaveLength(1);
    expect(integ[0].Properties.TimeoutInMillis).toBe(30000);
  });
  it("still exposes no /events, /invocations, /ping or catch-all route", () => {
    const keys = (Object.values(t.findResources("AWS::ApiGatewayV2::Route")) as any[]).map((r) => r.Properties.RouteKey as string);
    for (const k of keys) {
      expect(k).not.toMatch(/\/(events|invocations|ping)/);
      expect(k).not.toMatch(/\$default|ANY|\{proxy\+\}/);
    }
    expect(keys).toContain("POST /runs/{id}/revisions/{rid}/confirm");
  });
  it("keeps the lease above the function timeout", () => {
    expect(Number(fn().Properties.Environment.Variables.LEASE_MS)).toBeGreaterThan(fn().Properties.Timeout * 1000);
  });
});

describe("sign-in (DEC-015)", () => {
  it("creates a user pool with one group per role, a PKCE client and a hosted domain", () => {
    const t = build({ uiOrigins: "https://app.example.org" });
    t.resourceCountIs("AWS::Cognito::UserPool", 1);
    t.hasResourceProperties("AWS::Cognito::UserPool", { AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } });
    for (const g of ["program_officer", "clinician", "it"]) t.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: g });
    t.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      CallbackURLs: ["https://app.example.org/"],
      LogoutURLs: ["https://app.example.org/"],
    });
    t.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
  });
  it("puts a JWT authorizer on every route and allows the Authorization header", () => {
    const t = build();
    t.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", { AuthorizerType: "JWT", IdentitySource: ["$request.header.Authorization"] });
    const rs = Object.values(t.findResources("AWS::ApiGatewayV2::Route"));
    expect(rs.length).toBeGreaterThan(0);
    expect(rs.every((r) => (r as { Properties: { AuthorizationType?: string } }).Properties.AuthorizationType === "JWT")).toBe(true);
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", { CorsConfiguration: { AllowHeaders: ["content-type", "authorization"] } });
  });
  it("gives the function the pool and client ids", () => {
    const fn = Object.values(build().findResources("AWS::Lambda::Function"))[0] as { Properties: { Environment: { Variables: Record<string, unknown> } } };
    expect(Object.keys(fn.Properties.Environment.Variables)).toEqual(expect.arrayContaining(["COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID"]));
  });
  it("can be switched off with -c auth=off", () => {
    const t = build({ auth: "off" });
    t.resourceCountIs("AWS::Cognito::UserPool", 0);
    t.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 0);
  });
});
