/* Review support for the logic tree format: item ids, structured edits, checks, flags and suggestions.
   Item ids: decision nodes and outcomes use their own ids (n1, R01); questions "in:<id>",
   derived fields "dv:<id>", actions "ac:<id>"; "start" is the inputs box at the top of the flow. */
import { clone } from "./data";
import { condFields, condText, evaluate, isLeaf, walk, type Cond, type LogicTree, type TreeNode, type Values } from "./logicTree";
import type { Check, Flag, ItemId, Review, Suggestion, TreePatch } from "./types";

export type ItemKind = "start" | "node" | "leaf" | "input" | "derived" | "action";
export type TJson = string | number | boolean | null | TJson[] | { [k: string]: TJson };

export function kindOf(id: ItemId): ItemKind {
  if (id === "start") return "start";
  if (id.startsWith("in:")) return "input";
  if (id.startsWith("dv:")) return "derived";
  if (id.startsWith("ac:")) return "action";
  return /^R\d/.test(id) ? "leaf" : "node";
}
const nodeId = (n: TreeNode) => (isLeaf(n) ? n.leaf : n.node);

/** The object an item id points at, inside `t` (not a copy). */
export function treeItem(t: LogicTree, id: ItemId): Record<string, unknown> | null {
  const rest = id.slice(3);
  switch (kindOf(id)) {
    case "input": return (t.inputs.find(i => i.id === rest) as unknown as Record<string, unknown>) ?? null;
    case "derived": return (t.derived.find(d => d.id === rest) as unknown as Record<string, unknown>) ?? null;
    case "action": return (t.actions.find(a => a.id === rest) as unknown as Record<string, unknown>) ?? null;
    case "start": return null;
    default: return (walk(t.tree).find(n => nodeId(n) === id) as unknown as Record<string, unknown>) ?? null;
  }
}

function setPath(obj: Record<string, unknown>, path: string, value: TJson) {
  const keys = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] === null || typeof cur[k] !== "object") throw new Error("Bad edit path " + path);
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = clone(value);
}

/** The only way a logic tree changes: set one or more dotted keys on one item. */
export function applyTreePatch(t: LogicTree, p: TreePatch): LogicTree {
  const x = clone(t);
  const obj = treeItem(x, p.item);
  if (!obj) throw new Error("No item " + p.item);
  Object.entries(p.set).forEach(([k, v]) => setPath(obj, k, v as TJson));
  return x;
}

/** What a reviewer signs off for one item. A decision node excludes its subtrees. */
export function itemSig(t: LogicTree, id: ItemId): string {
  const o = treeItem(t, id);
  if (!o) return "";
  if (kindOf(id) === "node") { const n = o as unknown as { node: string; question: string; check: Cond }; return JSON.stringify([n.node, n.question, n.check]); }
  return JSON.stringify(o);
}

export function allItemIds(t: LogicTree): ItemId[] {
  return [
    ...walk(t.tree).map(nodeId),
    ...t.inputs.map(i => "in:" + i.id), ...t.derived.map(d => "dv:" + d.id), ...t.actions.map(a => "ac:" + a.id),
  ];
}

export function treeItemLabel(t: LogicTree | undefined, id: ItemId): string {
  if (!t) return id;
  if (id.startsWith("F-")) return "Flag " + id.slice(2);
  if (id === "start") return "Inputs";
  const o = treeItem(t, id) as Record<string, unknown> | null;
  if (!o) return id;
  switch (kindOf(id)) {
    case "node": return id + " · " + o.question;
    case "leaf": return id + " · " + o.decision;
    case "input": return String(o.booklet_text);
    default: return id.slice(3);
  }
}

/** Where each flag is cited, as item ids. */
export function flagCiters(t: LogicTree): Record<string, ItemId[]> {
  const out: Record<string, ItemId[]> = {};
  const add = (id: ItemId, fl: string[]) => fl.forEach(f => { (out[f] = out[f] || []); if (!out[f].includes(id)) out[f].push(id); });
  t.inputs.forEach(i => add("in:" + i.id, i.flags));
  t.derived.forEach(d => { add("dv:" + d.id, d.flags); (d.danger_signs ?? []).forEach(s => add("dv:" + d.id, s.flags)); });
  t.actions.forEach(a => add("ac:" + a.id, a.flags));
  walk(t.tree).forEach(n => { if (isLeaf(n)) add(n.leaf, n.flags); });
  return out;
}

/** The logic tree's open questions become clinical flags the clinician must decide. */
export function treeFlags(t: LogicTree): Flag[] {
  const citers = flagCiters(t);
  return t.flags.map(f => {
    const by = citers[f.id] ?? [];
    const about = by[0] ?? "start";
    return {
      id: "F-" + f.id, clinical: true, kind: "Open question", about, title: f.id + ": " + f.issue,
      src: f.pages ? "Guideline pages " + f.pages : "No page cited",
      why: by.length ? "Cited by " + by.map(id => treeItemLabel(t, id)).join(", ") + "." : "Not cited by any item.",
      opts: [
        { label: "Keep as drafted" },
        { label: "Needs a change", fb: { type: "value", about, note: "Resolve " + f.id + ": " + f.issue, value: "" } },
      ],
    } satisfies Flag;
  });
}

/* ---------- Checks ---------- */

/** Deterministic pseudo-random numbers so the synthetic patients are the same on every run. */
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

/** Synthetic patients: each input gets a value near the thresholds the tree uses, or is left blank. */
export function syntheticPatients(t: LogicTree, n = 2000): Values[] {
  const thresholds: Record<string, Set<number>> = {};
  const collect = (c: Cond | null | undefined) => {
    if (!c) return;
    if ("all" in c) return c.all.forEach(collect);
    if ("any" in c) return c.any.forEach(collect);
    if (typeof c.value === "number") (thresholds[c.field] ??= new Set()).add(c.value);
  };
  t.inputs.forEach(i => collect(i.asked_when));
  t.derived.forEach(d => {
    if (!d.logic && d.danger_signs) d.danger_signs.forEach(s => collect(s.logic));
    else if (d.logic) {
      const l = d.logic;
      if ("cases" in l) l.cases.forEach(c => collect(c.when));
      else collect(l);
    }
  });
  walk(t.tree).forEach(x => { if (!isLeaf(x)) collect(x.check); });
  const domain = (i: LogicTree["inputs"][number]): (string | number)[] => {
    if (i.type === "integer") {
      const ts = [...(thresholds[i.id] ?? new Set([1]))];
      return [...new Set(ts.flatMap(v => [v - 1, v, v + 1]).filter(v => v >= 0))];
    }
    if (i.type === "date" || i.auto) return [];
    return i.options ?? ["yes", "no"];
  };
  const r = rng(42), out: Values[] = [];
  for (let k = 0; k < n; k++) {
    const v: Values = {};
    for (const i of t.inputs) { if (r() < 0.1) continue; const d = domain(i); v[i.id] = d[Math.floor(r() * d.length)]; }
    out.push(v);
  }
  return out;
}

export function coverage(t: LogicTree) {
  const leaves = walk(t.tree).filter(isLeaf).map(l => l.leaf);
  const pts = syntheticPatients(t);
  const hits: Record<string, number> = Object.fromEntries(leaves.map(l => [l, 0]));
  for (const p of pts) hits[evaluate(t, p).leaf.leaf]++;
  return { patients: pts.length, leaves, hits, reached: leaves.filter(l => hits[l] > 0).length };
}

export function treeChecks(t: LogicTree): Check[] {
  const out: Check[] = [];
  const block = (id: ItemId, text: string) => out.push({ sev: "blocking", id, text });
  const warn = (id: ItemId, text: string) => out.push({ sev: "warning", id, text });
  const fieldOpts = new Map<string, string[] | null>([
    ...t.inputs.map(i => [i.id, (i.type === "integer" || i.type === "date") ? null : (i.options ?? ["yes", "no"])] as const),
    ...t.derived.map(d => [d.id, d.type === "yes_no" ? ["yes", "no"] : (d.options ?? [])] as const),
  ]);
  const actions = new Set(t.actions.map(a => a.id));
  const flags = new Set(t.flags.map(f => f.id));

  const checkCond = (id: ItemId, c: Cond | null | undefined) => {
    if (!c) return;
    if ("all" in c) return c.all.forEach(x => checkCond(id, x));
    if ("any" in c) return c.any.forEach(x => checkCond(id, x));
    if (!fieldOpts.has(c.field)) return block(id, "uses undefined field " + c.field);
    const opts = fieldOpts.get(c.field);
    const vals = Array.isArray(c.value) ? c.value : [c.value];
    if (opts && vals.some(v => !opts.includes(String(v)))) block(id, condText(c) + ": " + c.field + " is one of " + opts.join(", "));
    if (!opts && vals.some(v => typeof v !== "number")) block(id, condText(c) + ": " + c.field + " is a number");
  };

  t.inputs.forEach(i => {
    const id = "in:" + i.id;
    if (!i.booklet_text.trim()) block(id, "question text is empty");
    checkCond(id, i.asked_when);
  });
  t.derived.forEach(d => {
    const id = "dv:" + d.id;
    if (!d.logic && d.danger_signs) {
      d.danger_signs.forEach(s => {
        if (s.logic) checkCond(id, s.logic);
        else warn(id, s.id + " (" + s.booklet_text + ") has no logic and is not evaluated");
      });
    } else if (d.logic) {
      const l = d.logic;
      if ("cases" in l) l.cases.forEach(c => checkCond(id, c.when));
      else checkCond(id, l);
    }
  });
  const bands = t.derived.find(d => d.id === "age_band")?.options?.filter(o => o !== "out_of_scope") ?? [];
  walk(t.tree).forEach(n => {
    if (isLeaf(n)) {
      if (!n.decision.trim()) block(n.leaf, "decision is empty");
      n.actions.forEach(a => {
        if (!actions.has(a)) return block(n.leaf, "uses undefined action " + a);
        const act = t.actions.find(x => x.id === a)!;
        if (act.dose) bands.filter(b => !act.dose!.values[b]).forEach(b => block("ac:" + a, "no dose for age band " + b));
      });
    } else {
      if (!n.question.trim()) block(n.node, "question is empty");
      checkCond(n.node, n.check);
    }
  });
  t.actions.forEach(a => { if (!a.booklet_text.trim()) block("ac:" + a.id, "action text is empty"); });
  const cited: [ItemId, string[]][] = [...t.inputs.map(i => ["in:" + i.id, i.flags] as [ItemId, string[]]), ...t.derived.map(d => ["dv:" + d.id, d.flags] as [ItemId, string[]]), ...t.actions.map(a => ["ac:" + a.id, a.flags] as [ItemId, string[]])];
  walk(t.tree).forEach(n => { if (isLeaf(n)) cited.push([n.leaf, n.flags]); });
  cited.forEach(([id, fl]) => fl.forEach(f => { if (!flags.has(f)) block(id, "cites undefined flag " + f); }));

  if (!out.some(c => c.sev === "blocking")) {
    const cov = coverage(t);
    cov.leaves.filter(l => !cov.hits[l]).forEach(l => warn(l, "no synthetic patient reaches this outcome"));
  }
  return out.filter((c, i) => out.findIndex(d => d.sev === c.sev && d.id === c.id && d.text === c.text) === i);
}

/* ---------- Review rounds ---------- */

/** Round 1: every decision and outcome, plus anything the program officer edited. */
export function treeRequired(draft: LogicTree, t: LogicTree): ItemId[] {
  const core = walk(t.tree).map(nodeId);
  const edited = allItemIds(t).filter(id => !core.includes(id) && itemSig(t, id) !== itemSig(draft, id));
  return core.concat(edited);
}

/* ---------- Suggested revision from clinician feedback (placeholder rules, no model) ---------- */

/** Parses "field op value" or "always". Returns undefined if it can't. */
export function parseCond(s: string): Cond | null | undefined {
  const x = s.trim();
  if (!x || /^always$/i.test(x)) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|!=|=|<|in)\s*(.+)$/.exec(x);
  if (!m) return undefined;
  const raw = m[3].trim().replace(/^\[|\]$/g, "");
  const val = (v: string) => (/^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v.trim().replace(/^"|"$/g, ""));
  return { field: m[1], op: m[2] as "=", value: m[2] === "in" ? raw.split(",").map(val) : val(raw) };
}

/** Paths to every numeric comparison inside an item, e.g. "logic.any.0.all.1.value", with the text of
    the AND-group around it (its context, e.g. age_band = "12_to_59m"). */
export function numericPaths(o: unknown, base = "", ctx = ""): { path: string; field: string; op: string; value: number; ctx: string }[] {
  if (!o || typeof o !== "object") return [];
  const r = o as Record<string, unknown>;
  if (typeof r.field === "string" && typeof r.value === "number") return [{ path: base + "value", field: r.field, op: String(r.op), value: r.value, ctx }];
  if (Array.isArray(r.all)) {
    const group = condText({ all: r.all as Cond[] });
    return (r.all as unknown[]).flatMap((v, i) => numericPaths(v, base + "all." + i + ".", group));
  }
  return Object.entries(r).flatMap(([k, v]) => (k === "yes" || k === "no" ? [] : numericPaths(v, base + k + ".", ctx)));
}

const numbersIn = (s: string) => new Set((s.match(/\d+(\.\d+)?/g) ?? []).map(Number));

export function suggestTree(t: LogicTree, id: ItemId, fb: Review): Suggestion {
  const note = (fb.note || "").trim(), val = (fb.value || "").trim();
  const clar = (text: string): Suggestion => ({ kind: "clarify", text });
  const mk = (field: string, from: unknown, to: unknown, set: Record<string, TJson>): Suggestion =>
    ({ kind: "change", field, from: String(from), to: String(to), patch: { op: "tree", item: id, set } });
  const o = treeItem(t, id);
  if (!o) return clar("This item is not in the logic model.");
  if (!val && note.length < 25) return clar("Needs clarification: the note does not say what to change. Ask the clinician for the exact wording or value, or edit it yourself.");
  const k = kindOf(id);
  switch (fb.type) {
    case "wording": {
      const key = { node: "question", leaf: "decision", input: "booklet_text", action: "booklet_text" }[k as string];
      if (!val) return clar("Needs clarification: no new wording was given.");
      if (!key) return clar("This item has no wording to change. Edit its logic instead.");
      return mk(key, o[key], val, { [key]: val });
    }
    case "value": {
      const num = parseFloat(val.replace(/[^\d.-]/g, ""));
      if (isNaN(num)) return clar("Needs clarification: no number was given. Say which value should change, and to what.");
      const paths = numericPaths(k === "node" ? { check: o.check } : k === "derived" ? { logic: o.logic } : o);
      if (!paths.length) return clar("This item has no numeric threshold. Say what should change.");
      const said = numbersIn(note);
      const scored = paths.map(x => {
        const ctxNums = [...numbersIn(x.ctx)].filter(n => n !== x.value);
        return { x, score: (said.has(x.value) ? 2 : 0) + ctxNums.filter(n => said.has(n)).length };
      });
      const best = Math.max(...scored.map(s => s.score));
      const top = scored.filter(s => s.score === best);
      if (paths.length > 1 && (best === 0 || top.length > 1))
        return clar("Needs clarification: this item has " + paths.length + " thresholds (" + paths.map(x => (x.ctx ? x.ctx : x.field + " " + x.op + " " + x.value)).join("; ") + "). Say which one should change.");
      const p = top[0].x;
      return mk((p.ctx || p.field + " " + p.op + " " + p.value).replace(String(p.value), "?"), p.value, num, { [p.path]: num });
    }
    case "show": {
      if (k !== "input") return clar("Show conditions belong to questions. Pick the question.");
      const c = parseCond(val);
      if (c === undefined) return clar("Needs clarification: write the condition as field = value, for example cough = yes.");
      const current = o.asked_when ? condText(o.asked_when as Cond) : "always";
      return mk("Asked when", current, val || "always", { asked_when: c as TJson });
    }
    case "source":
      if (!val) return clar("Needs clarification: say which pages or blocks to cite instead.");
      if (!("source" in o)) return clar("This item has no source field.");
      return mk("Source", o.source, val, { source: val });
    default:
      return clar("This needs a structural change (" + (fb.type === "remove" ? "remove" : "add") + "). Edit the logic model yourself, then resend.");
  }
}
