/* Logic tree format (schema_version 2.0), e.g. cough-pathway-logic-tree-v0.9.json.
   Pure functions that evaluate it:
   1) collect inputs in declaration order; 2) compute derived fields in order;
   3) start at tree root, follow yes/no to a leaf; 4) look up the leaf's action ids.
   A field that was not asked has no value, and any comparison on it is false. */

export type Scalar = string | number;
export type Op = "=" | "!=" | ">=" | "<" | "in";
export type Cond = { field: string; op: Op; value: Scalar | Scalar[] } | { all: Cond[] } | { any: Cond[] };

export interface TreeInput {
  id: string; booklet_text: string;
  type: "integer" | "date" | "yes_no" | "choice";
  unit?: string; auto?: boolean; options?: string[];
  asked_when?: Cond; source: string; flags: string[];
}
export interface DangerSign { id: string; booklet_text: string; logic?: Cond; source: string; flags: string[] }
export type DerivedLogic = Cond | { cases: { when: Cond; value: string }[]; otherwise: string };
export interface Derived {
  id: string; type: "yes_no" | "choice"; options?: string[];
  logic?: DerivedLogic; danger_signs?: DangerSign[]; source: string; flags: string[];
}
export interface DoseValue { booklet_text: string; tablets?: number }
export interface DueAt { from: string; add_days: number; repeat_every_days?: number; until?: string }
export interface Action {
  id: string; category: string; booklet_text: string; medicine?: string;
  dose?: { selected_by: string; values: Record<string, DoseValue>; times_per_day?: number; days?: number };
  pending_condition?: Cond; due_at: DueAt;
  source: string; flags: string[];
}
export interface ExternalDate { id: string; description: string; source: string; flags: string[] }
export interface Leaf { leaf: string; decision: string; actions: string[]; flags: string[]; source: string }
export interface Branch { node: string; question: string; check: Cond; yes: TreeNode; no: TreeNode }
export type TreeNode = Branch | Leaf;
export interface TreeFlag { id: string; kind: string; issue: string; pages: string }

export interface LogicTree {
  schema_version: string; pathway: string; guideline: string; logic_model_version: string;
  inputs: TreeInput[]; external_dates?: ExternalDate[]; derived: Derived[]; actions: Action[]; tree: TreeNode; flags: TreeFlag[];
}

export type Values = Record<string, Scalar | undefined>;

export const isLeaf = (n: TreeNode): n is Leaf => "leaf" in n;

export function evalCond(c: Cond, v: Values): boolean {
  if ("all" in c) return c.all.every(x => evalCond(x, v));
  if ("any" in c) return c.any.some(x => evalCond(x, v));
  const have = v[c.field];
  if (have === undefined || have === "") return false;
  switch (c.op) {
    case "=": return have === c.value;
    case "!=": return have !== c.value;
    case ">=": return typeof have === "number" && typeof c.value === "number" && have >= c.value;
    case "<": return typeof have === "number" && typeof c.value === "number" && have < c.value;
    case "in": return Array.isArray(c.value) && c.value.includes(have);
  }
}

/** Fields named anywhere in a condition. */
export function condFields(c: Cond | null | undefined): string[] {
  if (!c) return [];
  if ("all" in c) return c.all.flatMap(condFields);
  if ("any" in c) return c.any.flatMap(condFields);
  return [c.field];
}

export function condText(c: Cond): string {
  if ("all" in c) return c.all.map(condText).join(" AND ");
  if ("any" in c) return "(" + c.any.map(condText).join(") OR (") + ")";
  const val = Array.isArray(c.value) ? "[" + c.value.join(", ") + "]" : String(c.value);
  return c.field + " " + c.op + " " + val;
}

export interface Evaluation {
  /** Inputs that are asked, given the answers so far (asked_when true or always). */
  asked: Set<string>;
  /** Answers to asked inputs plus derived values. */
  values: Values;
  /** Danger sign id -> true, false, or null when the sign has no logic. */
  dangerSigns: Record<string, boolean | null>;
  /** Nodes visited from the root, ending at the leaf. */
  path: { node: string; answer: "yes" | "no" }[];
  leaf: Leaf;
}

export function evaluate(t: LogicTree, answers: Values): Evaluation {
  const values: Values = {};
  const asked = new Set<string>();
  for (const i of t.inputs) {
    if (i.asked_when && !evalCond(i.asked_when, values)) continue;
    if (i.auto) continue;
    asked.add(i.id);
    if (answers[i.id] !== undefined && answers[i.id] !== "") values[i.id] = answers[i.id];
  }
  const dangerSigns: Record<string, boolean | null> = {};
  for (const d of t.derived) {
    if (!d.logic && d.danger_signs) {
      for (const s of d.danger_signs) dangerSigns[s.id] = s.logic ? evalCond(s.logic, values) : null;
      values[d.id] = d.danger_signs.some(s => dangerSigns[s.id] === true) ? "yes" : "no";
    } else if (d.logic) {
      const l = d.logic;
      if ("cases" in l) values[d.id] = (l.cases.find(c => evalCond(c.when, values))?.value) ?? l.otherwise;
      else values[d.id] = evalCond(l, values) ? "yes" : "no";
    }
  }
  const path: Evaluation["path"] = [];
  let n = t.tree;
  while (!isLeaf(n)) {
    const yes = evalCond(n.check, values);
    path.push({ node: n.node, answer: yes ? "yes" : "no" });
    n = yes ? n.yes : n.no;
  }
  return { asked, values, dangerSigns, path, leaf: n };
}

/** Every node and leaf, depth first. */
export function walk(n: TreeNode, out: TreeNode[] = []): TreeNode[] {
  out.push(n);
  if (!isLeaf(n)) { walk(n.yes, out); walk(n.no, out); }
  return out;
}

/** Deterministic reference checks: every field, action and flag id the tree uses must be defined. */
export function referenceIssues(t: LogicTree): string[] {
  const fields = new Set([...t.inputs.map(i => i.id), ...t.derived.map(d => d.id)]);
  const actions = new Set(t.actions.map(a => a.id));
  const flags = new Set(t.flags.map(f => f.id));
  const issues: string[] = [];
  const need = (f: string, where: string) => { if (!fields.has(f)) issues.push(where + " uses undefined field " + f); };
  t.inputs.forEach(i => condFields(i.asked_when).forEach(f => need(f, "input " + i.id)));
  t.derived.forEach(d => {
    if (!d.logic && d.danger_signs) {
      d.danger_signs.forEach(s => condFields(s.logic).forEach(f => need(f, d.id + "." + s.id)));
    } else if (d.logic) {
      const l = d.logic;
      if ("cases" in l) l.cases.forEach(c => condFields(c.when).forEach(f => need(f, "derived " + d.id)));
      else condFields(l).forEach(f => need(f, "derived " + d.id));
    }
  });
  const flagged: { id: string; flags: string[] }[] = [...t.inputs, ...t.derived, ...t.actions, ...t.derived.flatMap(d => d.danger_signs ?? [])];
  walk(t.tree).forEach(n => {
    if (isLeaf(n)) {
      flagged.push({ id: n.leaf, flags: n.flags });
      n.actions.forEach(a => { if (!actions.has(a)) issues.push("leaf " + n.leaf + " uses undefined action " + a); });
    } else condFields(n.check).forEach(f => need(f, "node " + n.node));
  });
  flagged.forEach(x => x.flags.forEach(f => { if (!flags.has(f)) issues.push(x.id + " cites undefined flag " + f); }));
  return issues;
}

/** Ids of everything that cites a flag. */
export function flagUsers(t: LogicTree): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (id: string, fl: string[]) => fl.forEach(f => (out[f] = out[f] || []).push(id));
  t.inputs.forEach(i => add(i.id, i.flags));
  t.derived.forEach(d => { add(d.id, d.flags); (d.danger_signs ?? []).forEach(s => add(s.id, s.flags)); });
  t.actions.forEach(a => add(a.id, a.flags));
  walk(t.tree).forEach(n => { if (isLeaf(n)) add(n.leaf, n.flags); });
  return out;
}

export const isLogicTree = (x: unknown): x is LogicTree =>
  !!x && typeof x === "object" && "schema_version" in x && "inputs" in x && "tree" in x;
