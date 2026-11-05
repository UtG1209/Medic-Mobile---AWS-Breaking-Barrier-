import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TransientError } from "../../src/engine/step.js";
import { RunawayOutputError } from "../../src/model/modelClient.js";

type Invoke = (content: unknown, options?: { cancelSignal?: AbortSignal }) => Promise<unknown>;
const state: { invoke: Invoke; seenOptions: unknown[] } = { invoke: async () => ({}), seenOptions: [] };

vi.mock("@strands-agents/sdk", () => ({
  BedrockModel: class {},
  TextBlock: class {
    constructor(public text: string) {}
  },
  ImageBlock: class {
    constructor(public o: unknown) {}
  },
  Agent: class {
    invoke(content: unknown, options?: { cancelSignal?: AbortSignal }) {
      state.seenOptions.push(options);
      return state.invoke(content, options);
    }
  },
}));

const { DEFAULT_BEDROCK_TIMEOUT_MS, createStrandsModelClient, temperatureSetting } = await import("../../src/model/strands.js");

const req = { modelId: "m", system: "s", maxTokens: 10, schema: z.object({ a: z.number() }), content: [{ type: "text" as const, text: "hi" }] };
const result = (raw: string, stopReason = "endTurn") => ({
  stopReason,
  toString: () => raw,
  metrics: { accumulatedUsage: { inputTokens: 3, outputTokens: 4 } },
});

beforeEach(() => {
  state.seenOptions = [];
});

describe("createStrandsModelClient timeout", () => {
  it("defaults to 6 minutes", () => {
    expect(DEFAULT_BEDROCK_TIMEOUT_MS).toBe(6 * 60 * 1000);
  });
  it("passes a cancelSignal to the agent and returns the result", async () => {
    state.invoke = async () => result('{"a":1}');
    const r = await createStrandsModelClient({ region: "us-west-2" }).generateJson(req);
    expect(r.value).toEqual({ a: 1 });
    const opts = state.seenOptions[0] as { cancelSignal?: AbortSignal };
    expect(opts.cancelSignal).toBeInstanceOf(AbortSignal);
    expect(opts.cancelSignal?.aborted).toBe(false);
  });
  it("aborts the signal and throws TransientError when the SDK stops with 'cancelled'", async () => {
    state.invoke = (_c, o) =>
      new Promise((resolve) => o?.cancelSignal?.addEventListener("abort", () => resolve(result("", "cancelled"))));
    const p = createStrandsModelClient({ region: "us-west-2", timeoutMs: 20 }).generateJson(req);
    await expect(p).rejects.toBeInstanceOf(TransientError);
    await expect(p).rejects.toThrow(/timed out/);
  });
  it("retries a runaway generation: MaxTokensError becomes a TransientError", async () => {
    state.invoke = async () => {
      throw Object.assign(new Error("Model reached maximum token limit."), {
        name: "MaxTokensError",
        partialMessage: { role: "assistant", content: [{ text: '{"a": [1, 1, ' }, { text: "1, 1" }] },
      });
    };
    const p = createStrandsModelClient({ region: "us-west-2" }).generateJson(req);
    await expect(p).rejects.toBeInstanceOf(TransientError);
    await expect(p).rejects.toThrow(/maximum token limit/);
    const err = (await p.catch((e: unknown) => e)) as RunawayOutputError;
    expect(err).toBeInstanceOf(RunawayOutputError);
    expect(err.raw).toBe('{"a": [1, 1, 1, 1');
    expect(err.usage).toEqual({ inputTokens: 0, outputTokens: 10, modelId: "m" });
  });
  it("still times out when the SDK ignores the signal (non-cancelling race)", async () => {
    state.invoke = () => new Promise(() => {});
    await expect(createStrandsModelClient({ region: "us-west-2", timeoutMs: 20 }).generateJson(req)).rejects.toBeInstanceOf(TransientError);
  });
});

describe("temperatureSetting", () => {
  it("sends no temperature to Claude Haiku 5.5, which rejects it, and 0 to every other model", () => {
    expect(temperatureSetting("us.anthropic.claude-haiku-5-5")).toEqual({});
    expect(temperatureSetting("us.anthropic.claude-sonnet-5-5")).toEqual({});
    expect(temperatureSetting("global.anthropic.claude-opus-5-5")).toEqual({});
    expect(temperatureSetting("us.meta.llama4-scout-17b-instruct-v1:0")).toEqual({ temperature: 0 });
    expect(temperatureSetting("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toEqual({ temperature: 0 });
  });
});

describe("extractJsonReply", () => {
  it("takes the content of a fenced block, with or without a sentence before it", async () => {
    const { extractJsonReply } = await import("../../src/model/strands.js");
    expect(extractJsonReply('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonReply('\n```\n{"a":1}\n```\n')).toBe('{"a":1}');
    expect(extractJsonReply('I will search first.\n\n```json\n{"needs":[]}\n```')).toBe('{"needs":[]}');
  });
  it("takes the first block that is valid JSON when the model adds a second block or trailing text", async () => {
    const { extractJsonReply } = await import("../../src/model/strands.js");
    expect(extractJsonReply('Plan:\n```json\n{"a":1}\n```\nThen the answer:\n```json\n{"a":2}\n```')).toBe('{"a":1}');
    expect(extractJsonReply('```json\n{broken\n```\n```json\n{"a":2}\n```')).toBe('{"a":2}');
    expect(extractJsonReply('```json\n{"a":1}\n```\nHope that helps! {smile}')).toBe('{"a":1}');
  });
  it("takes bare JSON that follows a sentence, only when that span parses", async () => {
    const { extractJsonReply } = await import("../../src/model/strands.js");
    expect(extractJsonReply('I need to search.\n\n{"needs":[{"tool":"runStatus"}]}')).toBe('{"needs":[{"tool":"runStatus"}]}');
    const broken = 'I need to search {not json at all} ok';
    expect(extractJsonReply(broken)).toBe(broken);
  });
  it("leaves a reply with no valid JSON alone (the strict parser then refuses it)", async () => {
    const { extractJsonReply } = await import("../../src/model/strands.js");
    expect(extractJsonReply("plain words")).toBe("plain words");
    expect(extractJsonReply('```json\n{"a":\n```')).toBe('```json\n{"a":\n```');
  });
});
