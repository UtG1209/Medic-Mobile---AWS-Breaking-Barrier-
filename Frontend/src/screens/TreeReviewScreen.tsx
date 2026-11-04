import { useMemo, useState } from "react";
import { condText, isLeaf, walk, type LogicTree, type TreeNode } from "../domain/logicTree";
import { coverage, itemSig, kindOf, treeItem, treeItemLabel } from "../domain/treeModel";
import { verLabel } from "../domain/workflow";
import type { Check, Role, Workflow } from "../domain/types";
import type { Actions } from "../actions";
import { FlowGraph, type FlowEdge, type FlowNode, type Markers, type Tone } from "../components/Flow";
import { TreeEditor } from "../components/TreeEditor";
import { ReviewControls } from "../components/ReviewControls";
import { FeedbackCard } from "../components/FeedbackCard";
import { FlagsPanel } from "../components/panels";
import { FlagChips, FormPreview } from "./LogicTreeReview";
import { fnv } from "../domain/data";

const nid = (n: TreeNode) => (isLeaf(n) ? n.leaf : n.node);

function leafColor(t: LogicTree, n: Extract<TreeNode, { leaf: string }>): string | undefined {
  if (/refer/i.test(n.decision)) return "pink";
  if (/home/i.test(n.decision)) {
    const hasMedicine = n.actions.some(id => t.actions.find(a => a.id === id)?.category === "medicine");
    return hasMedicine ? "yellow" : "green";
  }
  return undefined;
}

function toGraph(t: LogicTree): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [{
    id: "start", type: "start", kick: "Inputs", text: t.pathway,
    sub: "Asks up to " + t.inputs.length + " questions, computes " + t.derived.map(d => d.id).join(", "),
  }];
  const edges: FlowEdge[] = [["start", nid(t.tree), ""]];
  walk(t.tree).forEach(n => {
    if (isLeaf(n)) {
      nodes.push({ id: n.leaf, type: "outcome", kick: "Outcome " + n.leaf, color: leafColor(t, n), text: n.decision,
        sub: n.actions.length ? n.actions.join(", ") : "No actions" });
    } else {
      nodes.push({ id: n.node, type: "decision", kick: "Question " + n.node, text: n.question, sub: "Yes if " + condText(n.check) });
      edges.push([n.node, nid(n.yes), "yes"], [n.node, nid(n.no), "no"]);
    }
  });
  return { nodes, edges };
}

function markersFor(w: Workflow, t: LogicTree, role: Role, checks: Check[], ids: string[]) {
  const mk: Markers = {}, tone: Tone = {};
  const add = (id: string, cls: string, label: string) => { (mk[id] = mk[id] || []).push([cls, label]); };
  const draft = w.treeDraft ?? t;
  ids.forEach(id => {
    if ((w.state === "po_draft" || w.state === "po_revise") && role === "po" && id !== "start" && itemSig(t, id) !== itemSig(draft, id)) { add(id, "ed", "Edited"); tone[id] = "changed"; }
    const r = w.reviews[id];
    if (r?.status === "approved") add(id, "ok", "Approved");
    else if (r?.status === "changes" && r.round === w.round) {
      const s = w.sug[id];
      const resolved = w.state === "po_revise" && ((s && (s.outcome === "accepted" || s.outcome === "edited")) || w.fixed[id]);
      if (resolved) add(id, "ok", "Resolved"); else add(id, "req", "Change requested");
    } else if (w.state === "clinician" && w.required.includes(id)) add(id, "todo", "To review");
  });
  checks.filter(c => c.sev === "blocking").forEach(c => { tone[c.id] = "bad"; add(c.id, "req", "Check"); });
  return { mk, tone };
}

function TrayGroup({ title, ids, t, sel, onSelect, mk }: { title: string; ids: string[]; t: LogicTree; sel: string; onSelect: (id: string) => void; mk: Markers }) {
  return (
    <div className="tray">
      <div className="tray-h">{title}</div>
      <div className="tray-items">
        {ids.map(id => (
          <button key={id} type="button" className={"titem" + (sel === id ? " sel" : "")} onClick={() => onSelect(id)}>
            <span className="badges">{(mk[id] || []).map((b, i) => <span key={i} className={"badge " + b[0]}>{b[1]}</span>)}</span>
            <span className="mono">{id.slice(3)}</span>
            {kindOf(id) === "input" ? <span>{treeItemLabel(t, id)}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function TreeChecksPanel({ t, checks, onSelect }: { t: LogicTree; checks: Check[]; onSelect: (id: string) => void }) {
  const cov = useMemo(() => coverage(t), [t]);
  const blocking = checks.filter(c => c.sev === "blocking").length;
  return (
    <section className="panel">
      <h2>Automatic checks</h2>
      <div className="kv"><span>Synthetic patients</span><b className={cov.reached === cov.leaves.length ? "okc" : "badc"}>{cov.patients.toLocaleString()} · {cov.reached} of {cov.leaves.length} outcomes reached</b></div>
      <div className="kv"><span>Blocking problems</span><b className={blocking ? "badc" : "okc"}>{blocking}</b></div>
      {checks.length ? (
        <ul className="clist">
          {checks.map((c, i) => (
            <li key={i} className={c.sev}>
              <span className="sev">{c.sev[0].toUpperCase() + c.sev.slice(1)}</span>{" "}
              <button type="button" className="lnk" onClick={() => onSelect(c.id)}>{c.id}</button>: {c.text}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface Props { w: Workflow; t: LogicTree; role: Role; sel: string; setSel: (id: string) => void; act: Actions; checks: Check[] }

export function TreeReviewScreen({ w, t, role, sel, setSel, act, checks }: Props) {
  const [tab, setTab] = useState<"flow" | "form">("flow");
  const graph = useMemo(() => toGraph(t), [t]);
  const inputIds = t.inputs.map(i => "in:" + i.id), derivedIds = t.derived.map(d => "dv:" + d.id), actionIds = t.actions.map(a => "ac:" + a.id);
  const allIds = ["start", ...walk(t.tree).map(nid), ...inputIds, ...derivedIds, ...actionIds];
  const { mk, tone } = markersFor(w, t, role, checks, allIds);
  const canEdit = role === "po" && (w.state === "po_draft" || w.state === "po_revise");
  const canReview = role === "clinician" && w.state === "clinician" && sel !== "start";
  const draft = w.treeDraft ?? t;
  const nEdited = allIds.filter(id => id !== "start" && itemSig(t, id) !== itemSig(draft, id)).length;
  const id = allIds.includes(sel) ? sel : "start";
  const item = treeItem(t, id) as { source?: string; flags?: string[] } | null;
  const title = role === "clinician" ? "Clinical review" + (w.round ? " · round " + w.round : "") : role === "it" ? "Workflow (read-only)" : "Program officer workflow";

  let banner: string | null = null, bcls = "banner";
  if (w.state === "po_draft" && role === "po") banner = "Click any box or item to check it against its source and edit it. Use Form preview to try the form as a CHW.";
  if (w.state === "clinician" && role === "clinician") banner = "Click a box marked To review. Approve it, or request a change; you can't edit. The next one opens after each decision.";
  if (w.state === "po_revise" && role === "po") banner = "Items marked Change requested carry the clinician's feedback and a suggested revision. Open each one and accept, edit or discard it.";
  if (!banner && ["po_draft", "clinician", "po_revise"].includes(w.state)) { banner = "Read-only for your role. Editing is locked while it is with someone else."; bcls = "banner muted"; }
  if (w.approved) { banner = "Content approved by the clinician: " + w.approved.ver + " · " + w.approved.hash + ". Release for the logic tree is the next build step."; bcls = "banner good"; }

  const r = w.reviews[id];
  return (
    <>
      <div className="top">
        <div>
          <h1>{title}</h1>
          <div className="ver">{verLabel(w) + " · " + fnv(JSON.stringify(t)) + " · " + t.pathway + " · " + t.logic_model_version + " · " + nEdited + " items edited"}</div>
        </div>
      </div>
      {banner ? <div className={bcls}>{banner}</div> : null}
      {w.treeNote ? <div className="banner muted">{w.treeNote}</div> : null}
      <div className="editgrid">
        <section className="panel">
          <div className="ph">
            <div className="chips" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={tab === "flow"} className={"chipb" + (tab === "flow" ? " on" : "")} onClick={() => setTab("flow")}>Decision flow</button>
              <button type="button" role="tab" aria-selected={tab === "form"} className={"chipb" + (tab === "form" ? " on" : "")} onClick={() => setTab("form")}>Form preview</button>
            </div>
            <span className="ver">{tab === "form" ? "Answer as a CHW would" : canEdit ? "Click a box to edit it" : canReview ? "Click a box to review it" : "Click a box to see it"}</span>
          </div>
          {tab === "flow" ? (
            <>
              <FlowGraph nodes={graph.nodes} edges={graph.edges} selected={id} onSelect={setSel} markers={mk} tone={tone} label="Decision flow" />
              <TrayGroup title={"Questions (" + inputIds.length + ")"} ids={inputIds} t={t} sel={id} onSelect={setSel} mk={mk} />
              <TrayGroup title={"Derived fields (" + derivedIds.length + ")"} ids={derivedIds} t={t} sel={id} onSelect={setSel} mk={mk} />
              <TrayGroup title={"Actions (" + actionIds.length + ")"} ids={actionIds} t={t} sel={id} onSelect={setSel} mk={mk} />
              <div className="legend">
                {role === "po" ? <span><span className="badge ed">Edited</span> by you</span> : null}
                <span><span className="badge todo">To review</span></span>
                <span><span className="badge ok">Approved</span></span>
                <span><span className="badge req">Change requested</span></span>
                <span><i className="sw" style={{ borderColor: "var(--del)" }} />blocking check</span>
              </div>
            </>
          ) : <FormPreview t={t} onSelect={x => { setSel(x); setTab("flow"); }} />}
        </section>

        <div className="rightcol">
          <section className="panel editor" aria-labelledby="tp-h">
            <div className="ph">
              <h2 id="tp-h">{treeItemLabel(t, id)}</h2>
              <span className="badges">{(mk[id] || []).map((b, i) => <span key={i} className={"badge " + b[0]}>{b[1]}</span>)}</span>
            </div>
            {w.state === "po_revise" ? <FeedbackCard w={w} id={id} onSug={act.sug} /> : null}
            <TreeEditor key={id + ":" + w.rev + ":" + w.round} t={t} id={id} edit={canEdit ? act.edit : undefined} onSelect={setSel} />
            {item?.source ? <div className="quote">{item.source}<small>Source in the guideline (page and block ids){item.flags?.length ? " · flags " : ""}{item.flags?.length ? <FlagChips ids={item.flags} t={t} /> : null}</small></div> : null}
            {canReview ? (
              <ReviewControls key={id + ":" + w.round + ":" + (r ? r.status : "none")} id={id}
                review={r && (r.round === w.round || r.status === "approved") ? r : null}
                required={w.required.includes(id)} onDecide={d => act.decide(id, d)}
                hint={w.required.includes(id) ? "Part of this round's review. Approve it, or request a change. The program officer applies changes." : "Not required this round. You can still request a change."} />
            ) : r && role !== "po" ? (
              <div className={"rv " + r.status}>{r.status === "approved" ? "Approved by the clinician, round " + r.round : "Change requested, round " + r.round + ": " + r.note}</div>
            ) : null}
          </section>
          <FlagsPanel w={w} role={role} onFlag={act.flag} onSelect={setSel} />
          <TreeChecksPanel t={t} checks={checks} onSelect={setSel} />
        </div>
      </div>
    </>
  );
}
