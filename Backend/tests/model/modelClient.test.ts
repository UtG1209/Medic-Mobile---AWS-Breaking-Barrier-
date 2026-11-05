import { describe, it, expect } from "vitest";
import { z } from "zod";
import { FakeModelClient, ModelOutputError, parseModelJson } from "../../src/model/modelClient.js";
import { isTransientBedrockError, toStrandsContent } from "../../src/model/strands.js";

const schema = z.object({ a: z.number(), b: z.string() });

describe("parseModelJson", () => {
  it("returns value for valid JSON", () => {
    expect(parseModelJson('{"a":1,"b":"x"}', schema)).toEqual({ a: 1, b: "x" });
  });
  it("accepts one code fence around the whole reply, with or without a json tag", () => {
    expect(parseModelJson('```json\n{"a":1,"b":"x"}\n```', schema)).toEqual({ a: 1, b: "x" });
    expect(parseModelJson('  ```JSON\r\n{\n  "a": 1,\n  "b": "x"\n}\r\n```\n', schema)).toEqual({ a: 1, b: "x" });
    expect(parseModelJson('```\n{"a":1,"b":"x"}\n```', schema)).toEqual({ a: 1, b: "x" });
  });
  it("a fenced reply still has to match the schema", () => {
    expect(() => parseModelJson('```json\n{"a":"no"}\n```', schema)).toThrow(/schema validation/);
  });
  it("throws ModelOutputError with raw for text around fenced JSON", () => {
    const raw = 'Here is the JSON:\n```json\n{"a":1,"b":"x"}\n```';
    try {
      parseModelJson(raw, schema);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ModelOutputError);
      expect((e as ModelOutputError).raw).toBe(raw);
      expect((e as Error).message).toContain(raw);
    }
  });
  it("refuses two fenced blocks, an unclosed fence and a fence with text after it", () => {
    for (const raw of ['```json\n{"a":1,"b":"x"}\n```\n```json\n{"a":2,"b":"y"}\n```', '```json\n{"a":1,"b":"x"}', '```json\n{"a":1,"b":"x"}\n```\nDone.']) {
      expect(() => parseModelJson(raw, schema), raw).toThrow(ModelOutputError);
    }
  });
  it("throws ModelOutputError with raw for invalid JSON", () => {
    expect(() => parseModelJson("not json", schema)).toThrow(ModelOutputError);
    expect(() => parseModelJson("not json", schema)).toThrow(/not json/);
  });
  it("keeps only the first 200 characters of raw in the message, full raw on the error", () => {
    const raw = "z".repeat(10000);
    const err = (() => { try { parseModelJson(raw, schema); } catch (e) { return e; } })() as ModelOutputError;
    expect(err.raw).toBe(raw);
    expect(err.message).toContain("z".repeat(200));
    expect(err.message).not.toContain("z".repeat(201));
    expect(err.message.length).toBeLessThan(300);
  });
  it("does not put raw in the message on schema mismatch", () => {
    const raw = JSON.stringify({ a: "no", b: "q".repeat(1000) });
    const err = (() => { try { parseModelJson(raw, schema); } catch (e) { return e; } })() as ModelOutputError;
    expect(err.raw).toBe(raw);
    expect(err.message).not.toContain("qqqq");
  });
  it("lists zod issues on schema mismatch", () => {
    try {
      parseModelJson('{"a":"no"}', schema);
      expect.unreachable();
    } catch (e) {
      const err = e as ModelOutputError;
      expect(err).toBeInstanceOf(ModelOutputError);
      expect(err.raw).toBe('{"a":"no"}');
      expect(err.issues?.some((i) => i.startsWith("a:"))).toBe(true);
      expect(err.issues?.some((i) => i.startsWith("b:"))).toBe(true);
      expect(err.message).toContain("a:");
    }
  });
  it("attaches usage to ModelOutputError when given", () => {
    const usage = { inputTokens: 7, outputTokens: 3, modelId: "m1" };
    const e1 = (() => { try { parseModelJson("nope", schema, usage); } catch (e) { return e; } })() as ModelOutputError;
    expect(e1.usage).toEqual(usage);
    const e2 = (() => { try { parseModelJson('{"a":"no"}', schema, usage); } catch (e) { return e; } })() as ModelOutputError;
    expect(e2.usage).toEqual(usage);
    const e3 = (() => { try { parseModelJson("nope", schema); } catch (e) { return e; } })() as ModelOutputError;
    expect(e3.usage).toBeUndefined();
  });
});

describe("FakeModelClient", () => {
  const req = (modelId = "us.m") => ({
    modelId,
    system: "s",
    content: [{ type: "text" as const, text: "hi" }],
    schema,
    maxTokens: 10,
  });
  it("returns queued responses in order, records calls, defaults usage", async () => {
    const f = new FakeModelClient([
      { raw: '{"a":1,"b":"x"}' },
      { raw: '{"a":2,"b":"y"}', usage: { inputTokens: 5, outputTokens: 6, modelId: "m2" } },
    ]);
    const r1 = await f.generateJson(req());
    expect(r1.value).toEqual({ a: 1, b: "x" });
    expect(r1.usage).toEqual({ inputTokens: 0, outputTokens: 0, modelId: "us.m" });
    expect(r1.raw).toBe('{"a":1,"b":"x"}');
    const r2 = await f.generateJson(req());
    expect(r2.usage).toEqual({ inputTokens: 5, outputTokens: 6, modelId: "m2" });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.system).toBe("s");
  });
  it("throws queued Error and records the call", async () => {
    const f = new FakeModelClient([new Error("boom")]);
    await expect(f.generateJson(req())).rejects.toThrow("boom");
    expect(f.calls).toHaveLength(1);
  });
  it("throws ModelOutputError on bad canned output", async () => {
    const f = new FakeModelClient([{ raw: "nope" }]);
    await expect(f.generateJson(req())).rejects.toBeInstanceOf(ModelOutputError);
  });
  it("attaches the call's usage to ModelOutputError", async () => {
    const usage = { inputTokens: 5, outputTokens: 6, modelId: "m2" };
    const f = new FakeModelClient([{ raw: "nope", usage }, { raw: "nope" }]);
    const e1 = (await f.generateJson(req()).catch((e) => e)) as ModelOutputError;
    expect(e1.usage).toEqual(usage);
    const e2 = (await f.generateJson(req()).catch((e) => e)) as ModelOutputError;
    expect(e2.usage).toEqual({ inputTokens: 0, outputTokens: 0, modelId: "us.m" });
  });
  it("throws when queue is empty", async () => {
    const f = new FakeModelClient([]);
    await expect(f.generateJson(req())).rejects.toThrow(/empty/i);
  });
});

describe("isTransientBedrockError", () => {
  it.each(["ThrottlingException", "ServiceUnavailableException", "ModelTimeoutException", "InternalServerException", "TimeoutError", "ModelThrottledError", "ModelStreamErrorException", "ModelNotReadyException", "ModelErrorException"])(
    "name %s",
    (name) => {
      const e = new Error("x");
      e.name = name;
      expect(isTransientBedrockError(e)).toBe(true);
    },
  );
  it("code ECONNRESET", () => {
    expect(isTransientBedrockError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
  });
  it.each([429, 500, 502, 503, 504])("status %i", (s) => {
    expect(isTransientBedrockError({ $metadata: { httpStatusCode: s } })).toBe(true);
    expect(isTransientBedrockError({ statusCode: s })).toBe(true);
  });
  it("walks cause chain", () => {
    const inner = Object.assign(new Error("in"), { name: "ThrottlingException" });
    expect(isTransientBedrockError(new Error("outer", { cause: inner }))).toBe(true);
  });
  it("rejects non-transient", () => {
    const v = new Error("bad");
    v.name = "ValidationException";
    expect(isTransientBedrockError(v)).toBe(false);
    expect(isTransientBedrockError({ $metadata: { httpStatusCode: 400 } })).toBe(false);
    expect(isTransientBedrockError("str")).toBe(false);
    expect(isTransientBedrockError(null)).toBe(false);
  });
});

describe("toStrandsContent", () => {
  it("converts text and png image blocks", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = toStrandsContent([
      { type: "text", text: "hello" },
      { type: "image", format: "png", bytes },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "textBlock", text: "hello" });
    expect(out[1]).toMatchObject({ type: "imageBlock", format: "png" });
    expect((out[1] as { source: { bytes: Uint8Array } }).source.bytes).toEqual(bytes);
  });
});
