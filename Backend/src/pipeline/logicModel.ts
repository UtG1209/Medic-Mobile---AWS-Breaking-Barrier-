import { readFileSync } from "node:fs";
import { FORMAT, LogicTreeSchema, type LogicTree } from "./schema.ts";
import type { Digest } from "./digest.ts";

export interface BuildInput { guideline: { id: string; name: string }; digest: Digest }
export interface BuildOutput { model: unknown; source: "placeholder" | "agent"; notes: string[] }

/**
 * The model step. AgentCore will implement this interface (which model runs which task is theirs to decide).
 * Whatever it returns is untrusted: buildLogicModel validates it against LogicTreeSchema before anything uses it.
 */
export interface LogicModelBuilder {
  readonly name: string;
  build(input: BuildInput): Promise<BuildOutput>;
}

const TEMPLATE_FILE = "cough-pathway-logic-tree-v0.9.json";
const TEMPLATE = JSON.parse(readFileSync(new URL("./templates/" + TEMPLATE_FILE, import.meta.url), "utf8")) as unknown;

/**
 * Placeholder until AgentCore is connected. No model runs: it returns the team's cough-pathway logic tree (v0.9)
 * so the review screen has something to render. It does not read the uploaded guideline's content.
 */
export const placeholderBuilder: LogicModelBuilder = {
  name: "placeholder:" + TEMPLATE_FILE,
  async build() {
    return {
      model: structuredClone(TEMPLATE),
      source: "placeholder",
      notes: ["No model connected. This is the team's cough-pathway logic tree v0.9, not content drafted from this guideline."],
    };
  },
};

export class InvalidModelError extends Error {}

export interface LogicModelEnvelope {
  format: typeof FORMAT;
  guidelineId: string;
  builder: string;
  source: "placeholder" | "agent";
  createdAt: string;
  notes: string[];
  summary: { inputs: number; derived: number; nodes: number; leaves: number; actions: number; flags: number };
  model: LogicTree;
}

function countTree(n: LogicTree["tree"]): { nodes: number; leaves: number } {
  if ("leaf" in n) return { nodes: 0, leaves: 1 };
  const a = countTree(n.yes), b = countTree(n.no);
  return { nodes: 1 + a.nodes + b.nodes, leaves: a.leaves + b.leaves };
}

export async function buildLogicModel(builder: LogicModelBuilder, input: BuildInput): Promise<LogicModelEnvelope> {
  const out = await builder.build(input);
  const parsed = LogicTreeSchema.safeParse(out.model);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map(i => (i.path.join(".") || "(root)") + ": " + i.message).join("; ");
    throw new InvalidModelError(`${builder.name} returned a logic model that fails the schema: ${issues}`);
  }
  const m = parsed.data;
  return {
    format: FORMAT, guidelineId: input.guideline.id, builder: builder.name, source: out.source,
    createdAt: new Date().toISOString(), notes: out.notes,
    summary: { inputs: m.inputs.length, derived: m.derived.length, ...countTree(m.tree), actions: m.actions.length, flags: m.flags.length },
    model: m,
  };
}
