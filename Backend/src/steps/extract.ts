import { readFile } from "node:fs/promises";
import { artifactKey, pageImageName } from "../artifacts/artifactStore.js";
import { TransientUsageError, type Step } from "../engine/step.js";
import { ModelOutputError, RunawayOutputError, type ModelContent } from "../model/modelClient.js";
import { ExtractionOutput } from "./extractionSchema.js";

interface InputPage {
  pdf_page: number;
  image: string;
  blocks: { block_id: string; text: string }[];
}
interface InputDoc {
  source_id: string;
  page_count: number;
  pages: InputPage[];
}

/** A quote the model got almost right, and the deterministic repair applied to it (recorded, never silent). */
// Output cap of the one extraction call. Haiku 5.5 thinks before it answers and bills the hidden thinking as
// output: the 12-page cough booklet used 28k to 32k tokens for a 34 KB reply (Haiku 4.5: 10k for 27 KB), so 32k
// sat at the edge. 64k is the most the AgentCore wire allows and about 3.5 minutes at the model's speed, inside
// the 6 minute per-call timeout.
export const EXTRACT_MAX_TOKENS = 64000;

export interface QuoteFix {
  kind: "typography" | "block" | "format" | "span";
  from: { block_id: string; quote: string };
  to: { block_id: string; quote: string };
}

// Curly quotes and primes become their ASCII form. One UTF-16 unit for one, so an index found in the folded
// text is the same index in the original, and the booklet's own characters can be cut out of it.
const foldQuotes = (s: string): string => s.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"');

// Lower-cased, curly quotes folded, ALL whitespace dropped (the model adds and removes spaces and line breaks
// freely, and the booklet's OCR spacing is odd: "H EALTH"); map[i] is the index in the original of text[i], so a
// match found here is cut out of the original (the booklet's own characters).
function squash(s: string): { text: string; map: number[] } {
  const map: number[] = [];
  let text = "";
  for (let i = 0; i < s.length; i++) {
    const ch = foldQuotes(s[i]!);
    if (/\s/.test(ch)) continue;
    for (const c of ch.toLowerCase()) { text += c; map.push(i); }
  }
  return { text, map };
}

// A looser match must still be specific: shorter than this it could match anywhere.
const MIN_FORMAT_MATCH = 12;

/**
 * Last resort: the quote differs from the booklet only by case, spacing or trailing punctuation (the model
 * tidies the booklet's OCR, e.g. "H EALTH" or an added full stop). Found exactly once in the block, the
 * booklet's own text for that span is returned; never the model's version.
 */
function looseIn(text: string, quote: string): string | undefined {
  const q = squash(quote).text.replace(/^["']+/, "").replace(/["'.,;:!?]+$/, "");
  if (q.length < MIN_FORMAT_MATCH) return undefined;
  const t = squash(text);
  const i = t.text.indexOf(q);
  if (i < 0 || t.text.indexOf(q, i + 1) >= 0) return undefined;
  return text.slice(t.map[i]!, t.map[i + q.length - 1]! + 1);
}

/**
 * The model joined lines that are not next to each other (it skipped a line in the middle). When every line of
 * the quote is found in the block, in order, the booklet's own contiguous text from the first line's start to
 * the last line's end is returned, so the stored quote is still verbatim (just wider than what was cited).
 * Needs at least two lines, and the span may not be more than twice the quote's length.
 */
function spanIn(text: string, quote: string): string | undefined {
  const segs = quote
    .split(/\n/)
    .map((l) => squash(l).text)
    .filter((l) => l.length > 0);
  if (segs.length < 2 || segs.join("").length < MIN_FORMAT_MATCH) return undefined;
  const t = squash(text);
  let from = 0;
  let first = -1;
  let end = -1;
  for (const seg of segs) {
    const i = t.text.indexOf(seg, from);
    if (i < 0) return undefined;
    if (first < 0) first = i;
    from = end = i + seg.length;
  }
  const out = text.slice(t.map[first]!, t.map[end - 1]! + 1);
  return out.length <= 2 * quote.length ? out : undefined;
}

/** The booklet's exact text for `quote` in `text`: as is, or after folding curly quotes only; else undefined. */
function exactIn(text: string, quote: string): string | undefined {
  if (text.includes(quote)) return quote;
  const i = foldQuotes(text).indexOf(foldQuotes(quote));
  return i < 0 ? undefined : text.slice(i, i + quote.length);
}

// Block ids are p<page>.b<n> (extraction/prepare_input.py).
const pageOf = (blockId: string): string | undefined => /^(p\d+)\./.exec(blockId)?.[1];

/**
 * Checks every {block_id, quote} in the model's output against the booklet blocks, and with `apply` repairs
 * the two slips seen in real runs, deterministically:
 * - typography: the words are in the cited block but a curly quote was typed straight (or the reverse);
 *   the quote becomes the booklet's exact text;
 * - block: the quote is not in the cited block but is in exactly ONE block of the same page (the model
 *   miscounted blocks); block_id moves to that block.
 * - format: the quote is in the cited block but for case, spacing or trailing punctuation; the quote becomes
 *   the booklet's exact text (at least a phrase long, and found once).
 * - span: every line of the quote is in the cited block, in order, but the model skipped a line in between;
 *   the quote becomes the booklet's contiguous text covering them (at most twice the quote's length).
 * Anything else is bad: an empty quote, a quote in no block of the page, or in several (ambiguous).
 */
export function checkQuotes(
  output: unknown,
  blocks: Map<string, string>,
  opts: { apply?: boolean } = {},
): { bad: { block_id: string; quote: string }[]; fixes: QuoteFix[] } {
  const bad: { block_id: string; quote: string }[] = [];
  const fixes: QuoteFix[] = [];
  const byPage = new Map<string, string[]>();
  for (const id of blocks.keys()) {
    const p = pageOf(id);
    if (p !== undefined) byPage.set(p, [...(byPage.get(p) ?? []), id]);
  }
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      o.forEach(walk);
    } else if (o !== null && typeof o === "object") {
      const rec = o as Record<string, unknown>;
      if ("block_id" in rec && "quote" in rec) {
        const id = String(rec.block_id);
        const quote = String(rec.quote);
        // An empty quote would match any block, so it proves nothing.
        if (quote.trim() === "") {
          bad.push({ block_id: id, quote });
        } else {
          const here = exactIn(blocks.get(id) ?? "", quote);
          const loose = here === undefined ? looseIn(blocks.get(id) ?? "", quote) : undefined;
          const span = here === undefined && loose === undefined ? spanIn(blocks.get(id) ?? "", quote) : undefined;
          let fix: QuoteFix | undefined;
          if (here === undefined && loose !== undefined) {
            fix = { kind: "format", from: { block_id: id, quote }, to: { block_id: id, quote: loose } };
          } else if (here === undefined && span !== undefined) {
            fix = { kind: "span", from: { block_id: id, quote }, to: { block_id: id, quote: span } };
          } else if (here === undefined) {
            const page = pageOf(id);
            const hits = (page === undefined ? [] : byPage.get(page) ?? [])
              .filter((b) => b !== id)
              .flatMap((b) => {
                const t = exactIn(blocks.get(b)!, quote);
                return t === undefined ? [] : [{ b, t }];
              });
            if (hits.length === 1) fix = { kind: "block", from: { block_id: id, quote }, to: { block_id: hits[0]!.b, quote: hits[0]!.t } };
            else bad.push({ block_id: id, quote });
          } else if (here !== quote) {
            fix = { kind: "typography", from: { block_id: id, quote }, to: { block_id: id, quote: here } };
          }
          if (fix) {
            fixes.push(fix);
            if (opts.apply) {
              rec.block_id = fix.to.block_id;
              rec.quote = fix.to.quote;
            }
          }
        }
      }
      Object.values(rec).forEach(walk);
    }
  };
  walk(output);
  return { bad, fixes };
}

/** The quotes that are not exactly in their cited block (no repair). Kept for callers that only check. */
export function findBadQuotes(output: unknown, blocks: Map<string, string>): { block_id: string; quote: string }[] {
  const { bad, fixes } = checkQuotes(output, blocks);
  return [...bad, ...fixes.map((f) => f.from)];
}

const MAX_LISTED = 10;
const MAX_QUOTE = 80;

export function createExtractStep(opts: { modelId: string; promptPath: string; maxTokens?: number }): Step {
  return {
    name: "extract",
    runState: "extracting",
    async run(ctx) {
      const runId = ctx.run.runId;
      const system = await readFile(opts.promptPath, "utf8");
      const doc = JSON.parse(
        new TextDecoder().decode(await ctx.artifacts.get(artifactKey(runId, "ingest", "input_blocks.json"))),
      ) as InputDoc;

      if (doc.pages.length === 0) throw new Error("No pages to extract");

      const content: ModelContent[] = [
        {
          type: "text",
          text: `Run: ${runId}\nSource: ${doc.source_id}   Pages: ${doc.page_count}\nMode: new_guideline\nFor each page, in order:`,
        },
      ];
      for (const p of doc.pages) {
        content.push({ type: "text", text: `--- pdf_page ${p.pdf_page} ---` });
        content.push({
          type: "image",
          format: "png",
          bytes: await ctx.artifacts.get(artifactKey(runId, "ingest", "pages", pageImageName(p.pdf_page))),
        });
        content.push({ type: "text", text: "Blocks: " + JSON.stringify(p.blocks) });
      }
      content.push({ type: "text", text: "Return one JSON object for the whole document." });

      const rawKey = artifactKey(runId, "extract", "raw_response.txt");
      let result;
      try {
        result = await ctx.model.generateJson({
          modelId: opts.modelId,
          system,
          content,
          schema: ExtractionOutput,
          maxTokens: opts.maxTokens ?? EXTRACT_MAX_TOKENS,
        });
      } catch (e) {
        if (e instanceof RunawayOutputError) {
          // Keep what the model wrote before the cap, to see why it ran away; the retry follows as usual.
          await ctx.artifacts.put(artifactKey(runId, "extract", "raw_runaway.txt"), e.raw, "text/plain");
          throw e;
        }
        if (e instanceof ModelOutputError) {
          await ctx.artifacts.put(rawKey, e.raw, "text/plain");
          // Invalid JSON or a missing field varies from call to call: retry it (the cost of this call is recorded).
          throw new TransientUsageError(e.message, e.usage);
        }
        throw e;
      }
      await ctx.artifacts.put(rawKey, result.raw, "text/plain");

      const blocks = new Map(doc.pages.flatMap((p) => p.blocks.map((b) => [b.block_id, b.text] as const)));
      // Repairs only unambiguous slips (see checkQuotes) and records each one; everything else still fails.
      const { bad, fixes } = checkQuotes(result.value, blocks, { apply: true });
      if (bad.length > 0) {
        const listed = bad
          .slice(0, MAX_LISTED)
          .map((b) => `${b.block_id}: ${b.quote.length > MAX_QUOTE ? b.quote.slice(0, MAX_QUOTE) : b.quote}`)
          .join("; ");
        // The model's wording varies from call to call, so a fresh call usually passes: retry (the cost is recorded).
        throw new TransientUsageError(
          `Extraction has ${bad.length} quote(s) not found in their cited block: ${listed}`,
          result.usage,
        );
      }

      const outKey = artifactKey(runId, "extract", "extraction_output.json");
      await ctx.artifacts.put(outKey, JSON.stringify(result.value, null, 2), "application/json");
      const refs: Record<string, string> = { output: outKey, raw: rawKey };
      if (fixes.length > 0) {
        const fixKey = artifactKey(runId, "extract", "quote_fixes.json");
        await ctx.artifacts.put(fixKey, JSON.stringify(fixes, null, 2), "application/json");
        refs.quoteFixes = fixKey;
        refs.quoteFixCount = String(fixes.length);
      }
      return { artifactRefs: refs, usage: result.usage };
    },
  };
}
