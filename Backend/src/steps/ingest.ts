import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactKey, inputPdfKey, pageImageName } from "../artifacts/artifactStore.js";
import type { Step } from "../engine/step.js";

export type Exec = (cmd: string, args: string[]) => Promise<void>;

// Rendering every page of a long PDF can take minutes.
export const DEFAULT_EXEC_TIMEOUT_MS = 300000;

export function createDefaultExec(opts: { timeoutMs?: number } = {}): Exec {
  const timeout = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  return (cmd, args) =>
    new Promise<void>((resolve, reject) => {
      execFile(cmd, args, { timeout }, (err, _stdout, stderr) => {
        if (err) {
          // The first line of the error is only "Command failed: ..."; the reason (encrypted or corrupt PDF, ...) is in stderr.
          const tail = String(stderr ?? "").trim().split("\n").slice(-3).join(" | ").slice(0, 400);
          const why = err.killed ? `timed out after ${timeout} ms` : err.message.split("\n")[0];
          reject(new Error(`Command failed: ${path.basename(cmd)} (${why}${tail ? `; ${tail}` : ""})`));
        } else resolve();
      });
    });
}

export const defaultExec: Exec = createDefaultExec();

// Reads the page count with poppler's pdfinfo, so a huge PDF is refused before pdftoppm renders it.
export function parsePdfInfoPages(output: string): number {
  const m = /^Pages:\s*(\d+)\s*$/m.exec(output);
  const n = m ? Number(m[1]) : 0;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("Could not read the page count from pdfinfo output");
  return n;
}

export type PdfPageCount = (pdfPath: string) => Promise<number>;

export function createPdfInfoPageCount(opts: { bin?: string; timeoutMs?: number } = {}): PdfPageCount {
  const bin = opts.bin ?? "pdfinfo";
  const timeout = opts.timeoutMs ?? 30000;
  return (pdfPath) =>
    new Promise<number>((resolve, reject) => {
      execFile(bin, [pdfPath], { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) {
          reject(new Error(`Command failed: ${path.basename(bin)} (${err.killed ? `timed out after ${timeout} ms` : err.message.split("\n")[0]})`));
          return;
        }
        try {
          resolve(parsePdfInfoPages(stdout));
        } catch (e) {
          reject(e);
        }
      });
    });
}

interface InputPage {
  pdf_page: number;
  image: string;
}
interface InputDoc {
  doc_sha256?: unknown;
  page_count: number;
  pages: InputPage[];
  [k: string]: unknown;
}

const PAGE_FILE = /^page-0*(\d+)\.png$/;

// pdftoppm pads page numbers to the digit count of the last page (page-1.png,
// page-01.png, page-001.png), so the image field in input_blocks.json cannot be
// trusted. Map the files actually written to their page number instead.
async function listPageImages(pagesDir: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  let names: string[];
  try {
    names = await readdir(pagesDir);
  } catch {
    return out;
  }
  for (const name of names) {
    const m = PAGE_FILE.exec(name);
    if (m) out.set(Number(m[1]), name);
  }
  return out;
}

export function createIngestStep(opts: {
  pythonBin: string;
  scriptPath: string;
  exec: Exec;
  // Largest input PDF to download, in bytes (checked with a size lookup, before the download).
  maxPdfBytes?: number;
  // With pdfPageCount: largest total page count to render. The whole document is rendered even
  // when only some pages are selected, so the limit applies to the document, not the selection.
  maxPages?: number;
  pdfPageCount?: PdfPageCount;
}): Step {
  return {
    name: "ingest",
    runState: "ingesting",
    async run(ctx) {
      const runId = ctx.run.runId;
      const selected = ctx.run.pages;
      if (selected) {
        if (selected.length === 0) throw new Error("No pages selected");
        const invalid = selected.filter((n) => !Number.isInteger(n) || n < 1);
        if (invalid.length > 0) {
          throw new Error(`Invalid page numbers selected: ${invalid.join(", ")}`);
        }
      }
      const pdfKey = inputPdfKey(runId);
      if (!(await ctx.artifacts.exists(pdfKey))) {
        throw new Error(`Input PDF not found for run ${runId}`);
      }
      if (opts.maxPdfBytes !== undefined) {
        const size = await ctx.artifacts.size(pdfKey);
        if (size > opts.maxPdfBytes) {
          throw new Error(`Input PDF is ${size} bytes, over the limit of ${opts.maxPdfBytes} bytes`);
        }
      }
      const pdf = await ctx.artifacts.get(pdfKey);

      const dir = await mkdtemp(path.join(tmpdir(), "ingest-"));
      try {
        const pdfPath = path.join(dir, "guideline.pdf");
        const outDir = path.join(dir, "out");
        await writeFile(pdfPath, pdf);
        if (opts.maxPages !== undefined && opts.pdfPageCount) {
          const pageCount = await opts.pdfPageCount(pdfPath);
          if (pageCount > opts.maxPages) {
            throw new Error(`Input PDF has ${pageCount} pages, over the limit of ${opts.maxPages} pages`);
          }
        }
        await opts.exec(opts.pythonBin, [opts.scriptPath, pdfPath, outDir]);

        const doc = JSON.parse(await readFile(path.join(outDir, "input_blocks.json"), "utf8")) as InputDoc;

        // Record the document hash once; a retry finds it already set.
        if (!ctx.run.docSha256 && typeof doc.doc_sha256 === "string" && doc.doc_sha256 !== "") {
          const stored = await ctx.store.getRun(runId);
          if (stored && !stored.docSha256) await ctx.store.updateRun(runId, { docSha256: doc.doc_sha256 });
        }

        if (selected) {
          const outOfRange = selected.filter((n) => n < 1 || n > doc.page_count);
          if (outOfRange.length > 0) {
            throw new Error(
              `Selected pages out of range: ${outOfRange.join(", ")} (document has ${doc.page_count} pages)`,
            );
          }
          const keep = new Set(selected);
          doc.pages = doc.pages.filter((p) => keep.has(p.pdf_page));
          doc.page_count = doc.pages.length;
        }

        const pagesDir = path.join(outDir, "pages");
        const images = await listPageImages(pagesDir);
        const missing = doc.pages.filter((p) => !images.has(p.pdf_page)).map((p) => p.pdf_page);
        if (missing.length > 0) {
          throw new Error(`No page image found for page ${missing.join(", ")}`);
        }
        for (const p of doc.pages) p.image = `pages/${pageImageName(p.pdf_page)}`;

        const blocksKey = artifactKey(runId, "ingest", "input_blocks.json");
        await ctx.artifacts.put(blocksKey, JSON.stringify(doc, null, 2), "application/json");
        for (const p of doc.pages) {
          const bytes = await readFile(path.join(pagesDir, images.get(p.pdf_page)!));
          await ctx.artifacts.put(artifactKey(runId, "ingest", "pages", pageImageName(p.pdf_page)), bytes, "image/png");
        }
        return { artifactRefs: { blocks: blocksKey, pages: artifactKey(runId, "ingest", "pages") + "/" } };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
