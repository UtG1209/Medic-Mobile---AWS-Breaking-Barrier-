import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore, artifactKey, inputPdfKey, pageImageName } from "../../src/artifacts/artifactStore.js";
import type { StepContext } from "../../src/engine/step.js";
import type { ModelClient } from "../../src/model/modelClient.js";
import { DEFAULT_EXEC_TIMEOUT_MS, createDefaultExec, createIngestStep, defaultExec, parsePdfInfoPages } from "../../src/steps/ingest.js";
import { MemoryStore } from "../../src/store/memoryStore.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fixtureDoc(pageCount: number) {
  return {
    source_id: "guideline",
    doc_name: "guideline.pdf",
    doc_sha256: "abc",
    page_count: pageCount,
    pages: Array.from({ length: pageCount }, (_, i) => ({
      pdf_page: i + 1,
      width: 595,
      height: 842,
      image: `pages/page-${String(i + 1).padStart(2, "0")}.png`,
      blocks: [{ block_id: `p${i + 1}.b1`, pdf_page: i + 1, bbox: [0, 0, 1, 1], text: `text ${i + 1}` }],
    })),
  };
}

// pad: digits used for page file names, like pdftoppm (digit count of the last page).
// "fixed2" mimics the 2-digit names the input_blocks.json image field claims.
function fakeExec(
  pageCount: number,
  calls: { cmd: string; args: string[] }[] = [],
  pad: number | "fixed2" = "fixed2",
  skip: number[] = [],
) {
  return async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const outDir = args[2]!;
    await mkdir(path.join(outDir, "pages"), { recursive: true });
    await writeFile(path.join(outDir, "input_blocks.json"), JSON.stringify(fixtureDoc(pageCount)));
    const width = pad === "fixed2" ? 2 : pad;
    for (let i = 1; i <= pageCount; i++) {
      if (skip.includes(i)) continue;
      const bytes = new Uint8Array([...PNG, i % 256]);
      await writeFile(path.join(outDir, "pages", `page-${String(i).padStart(width, "0")}.png`), bytes);
    }
  };
}
const pngFor = (i: number) => new Uint8Array([...PNG, i % 256]);

async function setup(pages?: number[], hasPdf = true, docSha256?: string) {
  const artifacts = new MemoryArtifactStore();
  if (hasPdf) await artifacts.put(inputPdfKey("r1"), new Uint8Array([37, 80, 68, 70]));
  const run = {
    runId: "r1",
    state: "ingesting" as const,
    createdAt: 0,
    ...(pages ? { pages } : {}),
    ...(docSha256 ? { docSha256 } : {}),
  };
  const store = new MemoryStore();
  await store.createRun(run);
  const ctx: StepContext = {
    run,
    store,
    artifacts,
    model: {} as ModelClient,
    now: () => 0,
  };
  return { ctx, artifacts, store };
}

describe("ingest step", () => {
  it("has name and runState", () => {
    const s = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(1) });
    expect(s.name).toBe("ingest");
    expect(s.runState).toBe("ingesting");
  });

  it("keeps all pages when run.pages unset and stores blocks and images", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(3, calls) });
    const { ctx, artifacts } = await setup();
    const res = await step.run(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("py");
    expect(calls[0]!.args[0]).toBe("s.py");
    const doc = JSON.parse(new TextDecoder().decode(await artifacts.get(artifactKey("r1", "ingest", "input_blocks.json"))));
    expect(doc.page_count).toBe(3);
    expect(doc.pages.map((p: { pdf_page: number }) => p.pdf_page)).toEqual([1, 2, 3]);
    for (const [i, n] of [[1, "01"], [2, "02"], [3, "03"]] as const) {
      expect(await artifacts.get(artifactKey("r1", "ingest", "pages", `page-${n}.png`))).toEqual(pngFor(i));
    }
    expect(res.artifactRefs).toEqual({
      blocks: "runs/r1/ingest/input_blocks.json",
      pages: "runs/r1/ingest/pages/",
    });
  });

  it("keeps only selected pages, with original numbering", async () => {
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(5) });
    const { ctx, artifacts } = await setup([2, 4]);
    await step.run(ctx);
    const doc = JSON.parse(new TextDecoder().decode(await artifacts.get(artifactKey("r1", "ingest", "input_blocks.json"))));
    expect(doc.page_count).toBe(2);
    expect(doc.pages.map((p: { pdf_page: number }) => p.pdf_page)).toEqual([2, 4]);
    expect(doc.pages[0].blocks[0].block_id).toBe("p2.b1");
    expect(await artifacts.exists(artifactKey("r1", "ingest", "pages", "page-02.png"))).toBe(true);
    expect(await artifacts.exists(artifactKey("r1", "ingest", "pages", "page-04.png"))).toBe(true);
    expect(await artifacts.exists(artifactKey("r1", "ingest", "pages", "page-01.png"))).toBe(false);
    expect(await artifacts.exists(artifactKey("r1", "ingest", "pages", "page-03.png"))).toBe(false);
  });

  it("records the document hash on the run when it has none", async () => {
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(1) });
    const { ctx, store } = await setup();
    await step.run(ctx);
    expect((await store.getRun("r1"))!.docSha256).toBe("abc");
    // Idempotent on retry.
    await step.run(ctx);
    expect((await store.getRun("r1"))!).toMatchObject({ docSha256: "abc", state: "ingesting" });
  });

  it("leaves an existing document hash alone", async () => {
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(1) });
    const { ctx, store } = await setup(undefined, true, "from-event");
    await step.run(ctx);
    expect((await store.getRun("r1"))!.docSha256).toBe("from-event");
  });

  it("finds pdftoppm images with 1-digit names (fewer than 10 pages)", async () => {
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(9, [], 1) });
    const { ctx, artifacts } = await setup();
    await step.run(ctx);
    for (let i = 1; i <= 9; i++) {
      expect(await artifacts.get(artifactKey("r1", "ingest", "pages", `page-0${i}.png`))).toEqual(pngFor(i));
    }
    const doc = JSON.parse(new TextDecoder().decode(await artifacts.get(artifactKey("r1", "ingest", "input_blocks.json"))));
    expect(doc.pages[0].image).toBe("pages/page-01.png");
  });

  it("finds pdftoppm images with 3-digit names (100 or more pages)", async () => {
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(101, [], 3) });
    const { ctx, artifacts } = await setup([1, 9, 10, 100, 101]);
    await step.run(ctx);
    for (const [i, name] of [[1, "page-01.png"], [9, "page-09.png"], [10, "page-10.png"], [100, "page-100.png"], [101, "page-101.png"]] as const) {
      expect(await artifacts.get(artifactKey("r1", "ingest", "pages", name))).toEqual(pngFor(i));
      expect(pageImageName(i)).toBe(name);
    }
    expect(await artifacts.exists(artifactKey("r1", "ingest", "pages", "page-001.png"))).toBe(false);
    const doc = JSON.parse(new TextDecoder().decode(await artifacts.get(artifactKey("r1", "ingest", "input_blocks.json"))));
    expect(doc.pages.map((p: { image: string }) => p.image)).toEqual([
      "pages/page-01.png",
      "pages/page-09.png",
      "pages/page-10.png",
      "pages/page-100.png",
      "pages/page-101.png",
    ]);
  });

  it("fails non-transient naming the page when a kept page has no image", async () => {
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(3, [], 1, [2]) });
    const { ctx } = await setup();
    const err = await step.run(ctx).catch((e) => e);
    expect(err.name).toBe("Error");
    expect(err.message).toMatch(/image.*page 2/i);
  });

  it("does not need images for pages that were not selected", async () => {
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(3, [], 1, [2]) });
    const { ctx, artifacts } = await setup([1, 3]);
    await step.run(ctx);
    expect(await artifacts.exists(artifactKey("r1", "ingest", "pages", "page-03.png"))).toBe(true);
  });

  it("fails non-transient when a selected page is out of range", async () => {
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(3) });
    const { ctx } = await setup([2, 7, 9]);
    const err = await step.run(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("Error");
    expect(err.message).toContain("7");
    expect(err.message).toContain("9");
    expect(err.message).toContain("3");
  });

  it("fails clearly when the PDF is missing", async () => {
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(1) });
    const { ctx } = await setup(undefined, false);
    const err = await step.run(ctx).catch((e) => e);
    expect(err.name).toBe("Error");
    expect(err.message).toMatch(/input PDF/i);
  });

  it("removes the temp directory even when exec fails", async () => {
    let seen = "";
    const { stat } = await import("node:fs/promises");
    const step = createIngestStep({
      pythonBin: "py",
      scriptPath: "s.py",
      exec: async (_c, args) => {
        seen = args[2]!;
        throw new Error("boom");
      },
    });
    const { ctx } = await setup();
    await expect(step.run(ctx)).rejects.toThrow("boom");
    await expect(stat(path.dirname(seen))).rejects.toThrow();
  });

  it.each([
    ["empty", [], /No pages selected/],
    ["fractional", [2.5], /2\.5/],
    ["zero", [0], /0/],
    ["negative", [-1, 2], /-1/],
  ])("rejects invalid page selection (%s) before exec or writes", async (_n, pages, re) => {
    const calls: { cmd: string; args: string[] }[] = [];
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(3, calls) });
    const { ctx, artifacts } = await setup(pages as number[]);
    const err = await step.run(ctx).catch((e) => e);
    expect(err.name).toBe("Error");
    expect(err.message).toMatch(re);
    expect(calls).toHaveLength(0);
    expect(await artifacts.exists(artifactKey("r1", "ingest", "input_blocks.json"))).toBe(false);
  });
});

describe("default exec", () => {
  it("allows 5 minutes by default", () => {
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(300000);
  });

  it("runs a command", async () => {
    await expect(defaultExec(process.execPath, ["-e", ""])).resolves.toBeUndefined();
  });

  it("keeps the reason from stderr in the error (an encrypted or corrupt PDF)", async () => {
    await expect(defaultExec(process.execPath, ["-e", "console.error('first'); console.error('PDF is encrypted'); process.exit(2)"])).rejects.toThrow(/Command failed: .*PDF is encrypted/);
  });

  it("fails a command that outlives its timeout", async () => {
    const exec = createDefaultExec({ timeoutMs: 100 });
    await expect(exec(process.execPath, ["-e", "setTimeout(() => {}, 10000)"])).rejects.toThrow(/Command failed: .*timed out after 100 ms/);
  });
});

describe("ingest bounds", () => {
  it("fails permanently before downloading when the object is over maxPdfBytes", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const { ctx, artifacts } = await setup();
    await artifacts.put(inputPdfKey("r1"), new Uint8Array(101));
    let gets = 0;
    const get = artifacts.get.bind(artifacts);
    artifacts.get = async (k) => {
      gets++;
      return get(k);
    };
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(1, calls), maxPdfBytes: 100 });
    await expect(step.run(ctx)).rejects.toThrow(/101 bytes.*limit of 100/);
    await expect(step.run(ctx)).rejects.not.toMatchObject({ name: "TransientError" });
    expect(gets).toBe(0);
    expect(calls).toHaveLength(0);
  });
  it("accepts an object exactly at maxPdfBytes", async () => {
    const { ctx, artifacts } = await setup();
    await artifacts.put(inputPdfKey("r1"), new Uint8Array(100));
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(1), maxPdfBytes: 100 });
    await expect(step.run(ctx)).resolves.toBeDefined();
  });
  it("fails permanently when pdfinfo reports more pages than maxPages, before rendering", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const { ctx } = await setup();
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(1, calls), maxPages: 200, pdfPageCount: async () => 201 });
    await expect(step.run(ctx)).rejects.toThrow(/201 pages.*limit of 200/);
    expect(calls).toHaveLength(0);
  });
  it("renders when the page count is within maxPages", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const { ctx } = await setup();
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(2, calls), maxPages: 2, pdfPageCount: async () => 2 });
    await step.run(ctx);
    expect(calls).toHaveLength(1);
  });
  it("passes the written PDF path to the page counter", async () => {
    const { ctx } = await setup();
    let seen = "";
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(1), maxPages: 5, pdfPageCount: async (p) => ((seen = p), 1) });
    await step.run(ctx);
    expect(seen).toMatch(/guideline\.pdf$/);
  });
  it("a pdfinfo failure fails the step with a clear message", async () => {
    const { ctx } = await setup();
    const step = createIngestStep({ pythonBin: "py", scriptPath: "s.py", exec: fakeExec(1), maxPages: 5, pdfPageCount: async () => { throw new Error("Command failed: pdfinfo"); } });
    await expect(step.run(ctx)).rejects.toThrow(/pdfinfo/);
  });
});

describe("parsePdfInfoPages", () => {
  it("reads the Pages line", () => {
    expect(parsePdfInfoPages("Title: x\nPages:           12\nEncrypted: no\n")).toBe(12);
  });
  it("throws when there is no usable Pages line", () => {
    expect(() => parsePdfInfoPages("Title: x\n")).toThrow(/page count/i);
    expect(() => parsePdfInfoPages("Pages: 0\n")).toThrow(/page count/i);
  });
});
