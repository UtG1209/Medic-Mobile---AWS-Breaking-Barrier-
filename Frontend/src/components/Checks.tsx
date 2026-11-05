import { useEffect } from "react";
import { itemLabel } from "../domain/logic";
import { stageName, type Stage, type StageStatus } from "../domain/checks";
import type { Check, CheckKey } from "../domain/types";
import { Icon } from "./Icon";

const LABEL: Record<StageStatus, string> = { pass: "Passed", warn: "To look at", fail: "Needs fixing", skipped: "Not run yet", missing: "Not available here" };
const ICON: Record<StageStatus, string> = { pass: "check_circle", warn: "visibility", fail: "error", skipped: "schedule", missing: "do_not_disturb_on" };

/** Go to a check even when the address already points at it (a plain link would not fire hashchange then). */
function goCheck(e: React.MouseEvent, k: CheckKey) {
  e.preventDefault();
  history.pushState(null, "", "#check-" + k);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** A link to one check: pins that check open in the header. Shareable: /review#check-quote. */
export function CheckLink({ k }: { k?: CheckKey }) {
  if (!k) return null;
  return <a className="chklink" href={"#check-" + k} onClick={e => goCheck(e, k)}>{stageName(k)}</a>;
}

/** One issue: which check found it, the step it is on, and what is wrong. */
export function IssueLine({ c, onSelect, showCheck = true }: { c: Check; onSelect?: (id: string) => void; showCheck?: boolean }) {
  return (
    <li className={c.sev}>
      <span className="sev">{c.sev === "blocking" ? "Fix" : "Check"}</span>{" "}
      <span>
        {showCheck && c.kind ? <><CheckLink k={c.kind} />{" · "}</> : null}
        {onSelect ? <><button type="button" className="lnk" onClick={() => onSelect(c.id)}>{itemLabel(c.id)}</button>{": "}</> : null}
        {c.text}
      </span>
    </li>
  );
}

/** The six checks, each with a plain name and what it means. Click a check (or a #check- link) for its details. */
export function CheckBar({ stages, open, setOpen, onSelect }: { stages: Stage[]; open: CheckKey | null; setOpen: (k: CheckKey | null) => void; onSelect: (id: string) => void }) {
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".cwid")) setOpen(null); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open, setOpen]);
  return (
    <div className="cbar" role="list" aria-label="Checks">
      {stages.map((s, i) => {
        const on = open === s.key, n = s.issues.length, first = i === 0 || stages[i - 1].owner !== s.owner;
        return (
          <div key={s.key} role="listitem" id={"check-" + s.key} className={"cwid s-" + s.status + (on ? " on" : "") + (first ? " first" : "")}>
            <button type="button" className="chead" aria-expanded={on} onClick={() => setOpen(on ? null : s.key)}>
              <span className={"cico " + s.status}><Icon name={ICON[s.status]} size={22} fill={s.status === "pass"} /></span>
              <span className="cname">{s.name}</span>
              <span className="cdesc">{s.desc}</span>
              <span className="cstat">{s.headline ? LABEL[s.status] + " · " + s.headline : LABEL[s.status] + (n && (s.status === "fail" || s.status === "warn") ? " · " + n : "")}<span className="cmore">{on ? "Hide details" : "Details"}</span></span>
            </button>
            <div className="cpop" role="region" aria-label={s.name}>
              <div className="note">{s.summary}</div>
              <div className="note"><b>Asks: </b>{s.asks}</div>
              {s.uses ? <div className="note"><b>Against: </b>{s.uses}</div> : null}
              {s.parts ? (
                <ul className="parts">
                  {s.parts.map((p, k) => <li key={k} className={p.ok ? "ok" : "bad"}><span aria-hidden="true">{p.ok ? "✓" : "✗"}</span> <b>{p.name}</b> <span className="note">{p.text}</span></li>)}
                </ul>
              ) : null}
              {n ? <ul className="clist">{s.issues.map((c, k) => <IssueLine key={k} c={c} onSelect={onSelect} showCheck={false} />)}</ul>
                : s.status === "pass" ? <div className="note okc">No errors.</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
