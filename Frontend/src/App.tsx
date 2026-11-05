import { useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import * as api from "./api";
import { checksOf, initialWorkflow } from "./domain/workflow";
import type { Role, Workflow } from "./domain/types";
import { ROLE_NAME, type Actions } from "./actions";
import { NextStrip, STAGES } from "./components/NextStrip";
import { GuidelinesScreen } from "./screens/GuidelinesScreen";
import { ReviewScreen } from "./screens/ReviewScreen";
import { ReleaseScreen } from "./screens/ReleaseScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { Icon } from "./components/Icon";
import { AUTH, completeSignIn, currentUser, signIn, signOut, type User } from "./auth";

const SCREENS: [string, string, string][] = [["/guidelines", "Guidelines", "menu_book"], ["/review", "Review", "fact_check"], ["/release", "Release", "rocket_launch"], ["/history", "History", "history"]];
const EMPTY = initialWorkflow("none");

export default function App() {
  const [role, setRole] = useState<Role>("clinician");
  // Sign-in (DEC-015): who is signed in, and whether the return from the sign-in page has been handled.
  const [user, setUser] = useState<User | null>(() => (AUTH ? currentUser() : null));
  const [authReady, setAuthReady] = useState(!AUTH);
  const [authError, setAuthError] = useState<string | null>(null);
  const [w, setW] = useState<Workflow | null>(null);
  const [sel, setSel] = useState("scope");
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();
  const { pathname } = useLocation();
  const cur = w ?? EMPTY;
  const checks = useMemo(() => checksOf(cur), [cur]);

  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  useEffect(() => {
    if (!AUTH) return;
    completeSignIn()
      .then(back => { setUser(currentUser()); if (back) nav(back, { replace: true }); })
      .catch(e => setAuthError(e instanceof Error ? e.message : String(e)))
      .finally(() => setAuthReady(true));
  }, [nav]);
  // "Viewing as" offers only the roles this person has.
  const roles = useMemo<Role[]>(() => (AUTH ? user?.roles ?? [] : (Object.keys(ROLE_NAME) as Role[])), [user]);
  useEffect(() => { if (roles.length && !roles.includes(role)) setRole(roles[0]); }, [roles, role]);

  const run = async (p: Promise<Workflow>, after?: (x: Workflow) => void) => {
    setError(null);
    try { const x = await p; setW(x); after?.(x); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const pick = (id: string) => {
    if (id.startsWith("F-")) {
      const f = cur.flags.find(x => x.id === id);
      if (f) setSel(f.about);
      nav("/review");
      return;
    }
    setSel(id);
    nav("/review");
  };

  const act: Actions = {
    createDraft: args => run(api.createDraft(args), () => nav("/review")),
    openForRelease: args => run(api.openForRelease(args), () => nav("/release")),
    edit: (item, field, patch) => { if (w) run(api.saveEdit(w.id, { item, field, patch })); },
    undo: () => { if (w) run(api.undo(w.id)); },
    chat: text => { if (w) run(api.chat(w.id, text, sel), x => { const s = x.chat[x.chat.length - 1]?.select; if (s) setSel(s); }); },
    feedback: text => { if (w) run(api.feedback(w.id, text, sel)); },
    confirmRevision: msgId => { if (w) run(api.confirmRevision(w.id, msgId, setW)); },
    cancelRevision: msgId => { if (w) run(api.cancelRevision(w.id, msgId)); },
    apply: (msgId, i) => { if (w) run(api.applyProposal(w.id, msgId, i)); },
    dismiss: msgId => { if (w) run(api.dismissProposal(w.id, msgId)); },
    answer: (flagId, choice) => { if (w) run(api.answer(w.id, flagId, choice)); },
    approveAll: async () => { if (w) await run(api.approve(w.id), x => { if (x.state !== "clinician") nav("/release"); }); }, // stays on Review when the officer agent escalated
    runVerify: () => { if (w) run(api.runVerify(w.id)); },
    approveDeploy: () => { if (w) run(api.approveDeploy(w.id)); },
    setRole,
    reset: () => { setW(null); setSel("scope"); setError(null); nav("/guidelines"); },
  };

  const stage = STAGES.find(s => s.key === cur.state)!;
  const actionPath = stage.owner === role || stage.owner === "system" ? stage.path : null;

  if (AUTH && (!authReady || !user || !user.roles.length)) {
    return (
      <main className="signin">
        <section className="panel signin-card" aria-label="Sign in">
          <div className="sn-brand"><img src="/logo.jpg" alt="" width={32} height={32} /><span>Guideline to Form</span></div>
          {!authReady ? <p className="note">Signing you in...</p>
            : !user ? (
              <>
                <h1>Sign in</h1>
                <p className="note">Use the account your team administrator created for you. You will see the runs for your role.</p>
                {authError ? <div className="banner" role="alert">{authError}</div> : null}
                <button type="button" className="btn primary" onClick={() => void signIn()}>Sign in</button>
              </>
            ) : (
              <>
                <h1>No role yet</h1>
                <p className="note">{"You are signed in as " + user.email + ", but your account is not in the clinician or IT approver group. Ask your team administrator to add you."}</p>
                <button type="button" className="btn" onClick={signOut}>Sign out</button>
              </>
            )}
        </section>
      </main>
    );
  }

  return (
    <div className="shell">
      <aside className="sidenav" aria-label="Screens">
        <div className="sn-brand"><img src="/logo.jpg" alt="" width={32} height={32} /><span>Guideline to Form</span></div>
        <nav className="sn-nav">
          {SCREENS.map(([p, l, ic]) => (
            <NavLink key={p} to={p} className={({ isActive }) => (isActive ? "on" : "")}>
              {({ isActive }) => (
                <>
                  <Icon name={ic} fill={isActive} />
                  <span className="sn-l">{l}</span>
                  {actionPath === p ? <span className="ndot" aria-label="your next step is here" /> : null}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <p className="sn-foot">Mock-up. Example data based on the WHO IMCI 2008 to 2014 revision. Not clinical advice.</p>
      </aside>
      <div className="shell-main">
        <header className="topbar">
          <span className="tb-ctx"><Icon name="medical_information" size={20} />No-Code CHT configuration</span>
          <label className="tb-who" htmlFor="role">
            Viewing as
            <select id="role" value={role} onChange={e => setRole(e.target.value as Role)}>
              {roles.map(k => <option key={k} value={k}>{ROLE_NAME[k]}</option>)}
            </select>
          </label>
          <span className="tb-av" title={(user ? user.email + " · " : "") + "Viewing as " + ROLE_NAME[role]}><Icon name="person" size={20} fill /></span>
          {AUTH && user ? <span className="tb-user"><span className="note">{user.email}</span><button type="button" className="lnk" onClick={signOut}>Sign out</button></span> : null}
        </header>
        <main className="app">
          <NextStrip w={cur} role={role} checks={checks} path={pathname} act={act} go={nav} pick={pick} />
          {error ? <div className="banner" role="alert">{error}</div> : null}
          <Routes>
            <Route path="/" element={<Navigate to="/guidelines" replace />} />
            <Route path="/guidelines" element={<GuidelinesScreen w={w} role={role} act={act} />} />
            <Route path="/review" element={<ReviewScreen w={w} role={role} sel={sel} setSel={setSel} act={act} checks={checks} />} />
            <Route path="/release" element={<ReleaseScreen w={w} role={role} act={act} />} />
            <Route path="/history" element={<HistoryScreen w={w} act={act} />} />
            <Route path="*" element={<Navigate to="/guidelines" replace />} />
          </Routes>
          <div className="foot">
            <span>{AUTH ? "Signed in with your team account. The run list shows the runs for your role." : "“Viewing as” stands in for two separate logins."}</span>
          </div>
        </main>
      </div>
    </div>
  );
}
