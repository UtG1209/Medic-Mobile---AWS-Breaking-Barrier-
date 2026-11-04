import { z } from "zod";

/* Zod schema for the logic tree format (schema_version 2.0), e.g. cough-pathway-logic-tree-v0.9.json.
   Mirrors the types in Frontend/src/domain/logicTree.ts; keep the two in step.
   Every logic model, placeholder or agent, must pass this before it is stored or served.
   Unknown extra keys are allowed so the format can grow without breaking the pipeline. */

const scalar = z.union([z.string(), z.number()]);
type Cond = { field: string; op: "=" | "!=" | ">=" | "<" | "in"; value: string | number | (string | number)[] } | { all: Cond[] } | { any: Cond[] };
export const CondSchema: z.ZodType<Cond> = z.lazy(() => z.union([
  z.object({ field: z.string().min(1), op: z.enum(["=", "!=", ">=", "<", "in"]), value: z.union([scalar, z.array(scalar)]) }),
  z.object({ all: z.array(CondSchema).min(1) }),
  z.object({ any: z.array(CondSchema).min(1) }),
]));

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const flags = z.array(z.string());

const InputSchema = z.object({
  id, booklet_text: z.string().min(1), type: z.enum(["integer", "date", "yes_no", "choice"]),
  unit: z.string().optional(), auto: z.boolean().optional(), options: z.array(z.string()).optional(),
  asked_when: CondSchema.optional(), source: z.string(), flags,
}).passthrough();

const ExternalDateSchema = z.object({ id, description: z.string(), source: z.string(), flags }).passthrough();

const DangerSignSchema = z.object({ id, booklet_text: z.string(), logic: CondSchema.optional(), source: z.string(), flags }).passthrough();

const DerivedLogicSchema = z.union([
  z.object({ cases: z.array(z.object({ when: CondSchema, value: z.string() })), otherwise: z.string() }),
  CondSchema,
]);

const DerivedSchema = z.object({
  id, type: z.enum(["yes_no", "choice"]), options: z.array(z.string()).optional(),
  logic: DerivedLogicSchema.optional(),
  danger_signs: z.array(DangerSignSchema).optional(), source: z.string(), flags,
}).passthrough();

const DoseValues = z.record(z.object({ booklet_text: z.string(), tablets: z.number().optional() }).passthrough());
const DueAt = z.object({ from: z.string(), add_days: z.number(), repeat_every_days: z.number().optional(), until: z.string().optional() });

const ActionSchema = z.object({
  id: z.string().min(1), category: z.string(), booklet_text: z.string(),
  medicine: z.string().optional(),
  dose: z.object({ selected_by: z.string(), values: DoseValues, times_per_day: z.number().optional(), days: z.number().optional() }).optional(),
  pending_condition: CondSchema.optional(),
  due_at: DueAt,
  source: z.string(), flags,
}).passthrough();

const LeafSchema = z.object({ leaf: z.string(), decision: z.string(), actions: z.array(z.string()), flags, source: z.string() }).passthrough();
type Node = z.infer<typeof LeafSchema> | { node: string; question: string; check: Cond; yes: Node; no: Node };
const NodeSchema: z.ZodType<Node> = z.lazy(() => z.union([
  LeafSchema,
  z.object({ node: z.string(), question: z.string(), check: CondSchema, yes: NodeSchema, no: NodeSchema }),
]));

export const LogicTreeSchema = z.object({
  schema_version: z.literal("2.0"),
  pathway: z.string().min(1),
  guideline: z.string(),
  logic_model_version: z.string(),
  inputs: z.array(InputSchema).min(1),
  external_dates: z.array(ExternalDateSchema).optional(),
  derived: z.array(DerivedSchema),
  actions: z.array(ActionSchema),
  tree: NodeSchema,
  flags: z.array(z.object({ id: z.string(), kind: z.string(), issue: z.string(), pages: z.string() })),
}).passthrough();

export type LogicTree = z.infer<typeof LogicTreeSchema>;
export const FORMAT = "logic-tree/2.0";
