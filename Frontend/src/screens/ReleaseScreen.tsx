import { V3, V3_HASH } from "../domain/data";
import { classify, describeP, getO, golden, grid } from "../domain/logic";
import type { Model, Role, Workflow } from "../domain/types";
import type { Actions } from "../actions";
import { XlsCompare } from "../components/XlsCompare";
import { JsonDiff } from "../components/JsonDiff";
import { Flow, type Markers } from "../components/Flow";
import { allItems, changedVs } from "../domain/logic";
import { useState } from "react";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/Page";

type Tab = "flow" | "json" | "form";
/** What IT approves: the flow (live or new), the logic model JSON diff and the form diff, all built from the approved hash. */
function Changes({ w }: { w: Workflow }) {
  const [tab, setTab] = useState<Tab>("flow");
  const [side, setSide] = useState<"new" | "live">("new");
  const m = w.model, ver = w.approved!.ver;
  const shown = side === "new" ? m : V3;
  const mk: Markers = {};
  if (side === "new") allItems(m, V3).forEach(id => { if (changedVs(m, id)) mk[id] = [["changed", "Changed"]]; });
  const n = allItems(m, V3).filter(id => changedVs(m, id)).length;
  return (
    <section className="panel">
      <div className="ph">
        <h2>{"Changes · v3 → " + ver}</h2>
        <div className="viewtgl" role="group" aria-label="Changes view">
          {([["flow", "Flow"], ["json", "JSON diff"], ["form", "Form diff"]] as [Tab, string][]).map(([k, l]) => <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      </div>
      {tab === "flow" ? (
        <>
          <div className="btnrow">
            <div className="viewtgl" role="group" aria-label="Version">
              <button type="button" aria-pressed={side === "live"} onClick={() => setSide("live")}>Live v3</button>
              <button type="button" aria-pressed={side === "new"} onClick={() => setSide("new")}>{"New " + ver}</button>
            </div>
            <span className="note">{n + " steps changed. Read-only; boxes marked Changed differ from v3."}</span>
          </div>
          <Flow key={side} m={shown} markers={mk} label={"Decision flow " + (side === "new" ? ver : "v3")} />
        </>
      ) : tab === "json" ? <JsonDiff a={V3} b={m} la="v3" lb={ver} />
        : <XlsCompare a={V3} b={m} la="v3" lb={ver} />}
    </section>
  );
}

/** The outcome as plain text: colour here read as an error to testers, so scenarios carry none. */
function Outcome({ o, m }: { o: string | null; m: Model }) {
  const x = o ? getO(m, o) : null;
  return x ? <span>{x.title}</span> : <span className="note">no outcome</span>;
}

/** Evenly spaced rows, one per outcome first so every classification shows up. */
function sample<T>(xs: T[], n: number): { i: number; p: T }[] {
  const step = Math.max(1, Math.floor(xs.length / n));
  return xs.map((p, i) => ({ i, p })).filter(({ i }) => i % step === 0).slice(0, n);
}

/** Release = Verify (synthetic patients) + Changes (IT deploy approval). */
export function ReleaseScreen({ w, role, act }: { w: Workflow | null; role: Role; act: Actions }) {
  if (!w || !w.approved || !["verify", "deploy", "done"].includes(w.state))
    return <div className="banner">Release opens after the clinician approves. Then every synthetic patient runs through the new form, and the IT approver deploys it.</div>;
  const m = w.model, v = w.verify, a = w.approved;
  const tile = (k: string, x: string | number, pass = false) => (
    <div key={k} className={"chk" + (pass ? " pass" : "")}>
      <span className="k">{pass ? <Icon name="check_circle" size={16} fill /> : null}{k}</span><span className="v">{x}</span>
    </div>
  );
  const gold = v ? golden(m) : [];
  const allPass = !!v && v.match === v.total && v.cov === v.covTotal && gold.every(g => g.ok);

  return (
    <>
      <PageHead eyebrow={[w.state === "verify" ? "Step 03" : w.state === "deploy" ? "Step 04" : "Step 05", "v3 " + V3_HASH + " → " + a.ver + " " + a.hash + " · built from the approved hash only"]} title={"Release " + a.ver}
        actions={w.state === "verify" ? <button type="button" className="btn primary" onClick={act.runVerify}><Icon name="science" size={18} />Run synthetic check</button>
          : w.state === "deploy" ? <button type="button" className="btn primary" disabled={role !== "it"} onClick={act.approveDeploy}><Icon name="rocket_launch" size={18} />Approve deploy</button>
          : <span className="st ok">Deployed</span>} />
      {w.state === "deploy" && role !== "it" ? (
        <div className="banner" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span>The deploy requires the IT approver role. Use the <b>Viewing as</b> dropdown in the top bar, or:</span>
          <button type="button" className="btn primary" onClick={() => act.setRole("it")}>
            <Icon name="swap_horiz" size={18} />Switch to IT approver
          </button>
        </div>
      ) : null}

      {!v ? (
        <div className="banner">The system builds the form with cht-conf, then runs every synthetic patient through (a) the approved rules in code and (b) the filled form in cht-conf-test-harness. Any mismatch returns the change to the clinician.</div>
      ) : (
        <>
          {allPass ? <div className="allpass"><Icon name="verified" size={24} fill /><span><b>{"All " + v.total + " test patients passed."}</b>{" The built form gives the same result as the approved rules for every one."}</span></div> : null}
          <div className="checks">
            {tile("Test patients", v.match + " of " + v.total + " passed", v.match === v.total)}
            {tile("Known cases", gold.filter(g => g.ok).length + " of " + gold.length + " passed", gold.every(g => g.ok))}
            {tile("Rule coverage", v.cov + " of " + v.covTotal + " rules used", v.cov === v.covTotal)}
            {tile("Content approval", "Clinician · " + a.hash)}
            {tile("Mutation test", v.mut + " of " + v.mutTotal + " threshold changes caught")}
            {tile("Rollback", "Redeploy v3")}
          </div>
          <section className="panel">
            <div className="ph"><h2>Test patients</h2><span className="ver">{"A sample of 12 from " + v.total + " · expected results come from the approved rules"}</span></div>
            <div className="tw">
              <table className="pttable">
                <colgroup><col style={{ width: 88 }} /><col /><col style={{ width: "24%" }} /><col style={{ width: "24%" }} /><col style={{ width: 112 }} /></colgroup>
                <thead><tr>{["Patient", "Inputs", "Expected (rules)", "Actual (form)", "Result"].map((t, i) => <th key={i}>{t}</th>)}</tr></thead>
                <tbody>
                  {sample(grid(m), 12).map(({ i, p }) => {
                    const e = classify(m, p).out;
                    return (
                      <tr key={i}>
                        <td className="mono">{"P-" + String(i + 1).padStart(4, "0")}</td>
                        <td>{describeP(m, p)}</td>
                        <td><Outcome o={e} m={m} /></td>
                        <td><Outcome o={e} m={m} /></td>
                        <td><span className="passed"><Icon name="check_circle" size={16} fill />Passed</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="note" style={{ margin: 0 }}>Simulated: the "Actual (form)" column will come from cht-conf-test-harness once the backend runs it.</p>
          </section>
          <Changes w={w} />
        </>
      )}
    </>
  );
}
