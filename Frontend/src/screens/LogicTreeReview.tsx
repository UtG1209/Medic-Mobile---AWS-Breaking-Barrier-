import { useMemo, useState } from "react";
import { condText, evaluate, type Action, type LogicTree, type TreeInput, type Values } from "../domain/logicTree";

/** Example answers for the demo. Synthetic. */
const EXAMPLES: [string, Values][] = [
  ["8 months, cough, 55 breaths/min", { age_months: 8, cough: "yes", cough_days: 3, breaths_per_minute: 55 }],
  ["30 months, cough, chest indrawing", { age_months: 30, cough: "yes", cough_days: 2, breaths_per_minute: 30, chest_indrawing: "yes" }],
  ["30 months, cough, convulsions", { age_months: 30, cough: "yes", cough_days: 2, breaths_per_minute: 45, convulsions: "yes" }],
  ["24 months, cough, 32 breaths/min", { age_months: 24, cough: "yes", cough_days: 4, breaths_per_minute: 32 }],
];

export const DECISION_TONE = (d: string) => (/refer/i.test(d) ? "pink" : /home/i.test(d) ? "green" : "muted");

export function FlagChips({ ids, t }: { ids: string[]; t: LogicTree }) {
  if (!ids.length) return null;
  return <span className="fchips">{ids.map(id => <span key={id} className="fchip" title={t.flags.find(f => f.id === id)?.issue ?? ""}>{id}</span>)}</span>;
}

function Field({ i, value, set, asked, t }: { i: TreeInput; value: Values[string]; set: (v: Values[string]) => void; asked: boolean; t: LogicTree }) {
  const fid = "in-" + i.id;
  const whenText = i.asked_when ? condText(i.asked_when) : "always";
  return (
    <div className={"tfield" + (asked ? "" : " hidden")}>
      <div className="tf-head">
        <label htmlFor={i.type === "integer" ? fid : undefined} id={fid + "-l"}>{i.booklet_text}</label>
        <FlagChips ids={i.flags} t={t} />
      </div>
      {!asked ? <span className="note">Not asked: shown when {whenText}</span>
        : i.type === "integer" ? (
          <div className="tf-num">
            <input id={fid} type="number" inputMode="numeric" value={value ?? ""} onChange={e => set(e.target.value === "" ? undefined : Number(e.target.value))} />
            {i.unit ? <span className="note">{i.unit}</span> : null}
          </div>
        ) : (
          <div className="chips" role="group" aria-labelledby={fid + "-l"}>
            {(i.options ?? ["yes", "no"]).map(o => (
              <button key={o} type="button" className={"chipb" + (value === o ? " on" : "")} aria-pressed={value === o} onClick={() => set(value === o ? undefined : o)}>{o}</button>
            ))}
          </div>
        )}
      <span className="tf-meta mono">{i.id} · {i.type}{i.asked_when ? " · asked when " + condText(i.asked_when) : ""} · {i.source}</span>
    </div>
  );
}

function ActionCard({ a, band }: { a: Action; band: string | undefined }) {
  const doseVal = band && a.dose?.values[band];
  return (
    <div className="tact">
      <div className="tf-head"><b className="mono">{a.id}</b><span className="note">{a.category}</span></div>
      <p>{a.booklet_text}</p>
      {doseVal ? <div className="kv"><span>Dose for {band}</span><b>{doseVal.booklet_text}</b></div> : null}
      {a.due_at ? <span className="note">Due: day {a.due_at.add_days} from {a.due_at.from}{a.due_at.repeat_every_days ? ", repeat every " + a.due_at.repeat_every_days + " days" : ""}</span> : null}
    </div>
  );
}

/** The form as a CHW would fill it, with the outcome it leads to. Updates as you answer. */
export function FormPreview({ t, onSelect }: { t: LogicTree; onSelect?: (id: string) => void }) {
  const [answers, setAnswers] = useState<Values>(EXAMPLES[0][1]);
  const ev = useMemo(() => evaluate(t, answers), [t, answers]);
  const inputs = t.inputs.filter(i => !i.auto);
  const band = ev.values.age_band as string | undefined;
  const askedCount = inputs.filter(i => ev.asked.has(i.id)).length;
  const dsDef = t.derived.find(d => d.danger_signs)?.danger_signs ?? [];

  return (
    <div className="fpgrid">
      <div className="stack">
        <div className="chips">
          <span className="note">Try:</span>
          {EXAMPLES.map(([label, v]) => <button key={label} type="button" className="chipb" onClick={() => setAnswers(v)}>{label}</button>)}
          <button type="button" className="chipb" onClick={() => setAnswers({})}>Clear</button>
        </div>
        <div className="tf-head">
          <span className="note">{askedCount} of {inputs.length} questions asked for these answers</span>
        </div>
        <fieldset className="tgroup">
          <legend className="lab">Questions</legend>
          {inputs.filter(i => ev.asked.has(i.id)).map(i => (
            <Field key={i.id} i={i} t={t} asked={ev.asked.has(i.id)} value={answers[i.id]}
              set={v => setAnswers(a => { const n = { ...a }; if (v === undefined) delete n[i.id]; else n[i.id] = v; return n; })} />
          ))}
        </fieldset>
      </div>

      <div className="stack" aria-live="polite">
        <div className="lab">Outcome for these answers</div>
        <button type="button" className={"toutcome " + DECISION_TONE(ev.leaf.decision)} onClick={() => onSelect?.(ev.leaf.leaf)}>
          <b>{ev.leaf.decision}</b>
          <span className="note">{ev.leaf.leaf}</span>
        </button>
        <div className="tpath mono">{ev.path.map(p => p.node + " " + p.answer).join("  >  ")}  {">"}  {ev.leaf.leaf}</div>
        <div className="lab">Derived</div>
        {t.derived.map(d => (
          <div key={d.id} className="kv"><span className="mono">{d.id}</span><b>{String(ev.values[d.id] ?? "-")}</b></div>
        ))}
        {dsDef.some(s => ev.dangerSigns[s.id] !== false) ? (
          <ul className="tds">
            {dsDef.filter(s => ev.dangerSigns[s.id] !== false).map(s => (
              <li key={s.id} className={ev.dangerSigns[s.id] ? "hit" : "undef"}>
                <span className="mono">{s.id}</span> {s.booklet_text}{ev.dangerSigns[s.id] === null ? <span className="note"> (not evaluated: no logic defined)</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {ev.leaf.actions.length ? (
          <div className="tactg">
            <div className="lab">Actions</div>
            {ev.leaf.actions.map(id => { const a = t.actions.find(x => x.id === id); return a ? <ActionCard key={id} a={a} band={band} /> : <span key={id} className="badc">Undefined action {id}</span>; })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
