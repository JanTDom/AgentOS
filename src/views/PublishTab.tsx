import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Database, ExternalLink, GitBranch, GitPullRequest, Loader2, RefreshCw, Rocket, RotateCcw, ScrollText, UploadCloud } from "lucide-react";
import { api } from "../api";
import { useApp, relativeTime } from "../context";
import { deployStateLabel, formatRows, isReadOnlySql, SCHEMA_SQL, waitForDeployment } from "../integrations";
import type { GitStatus, Project, ProjectIntegrations, VercelDeployment } from "../types";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PublishTab({ project }: { project: Project }) {
  const { mutate } = useApp();
  const setIntegrations = (patch: Partial<ProjectIntegrations>) =>
    mutate((s) => ({ ...s, projects: s.projects.map((p) => (p.id === project.id ? { ...p, integrations: { ...p.integrations, ...patch } } : p)) }));
  return (
    <div className="tab-body">
      <GitPanel project={project} setIntegrations={setIntegrations} />
      <VercelPanel project={project} setIntegrations={setIntegrations} />
      <SupabasePanel project={project} setIntegrations={setIntegrations} />
    </div>
  );
}

function NotConnected({ name }: { name: string }) {
  const { go } = useApp();
  return <p className="muted small">{name} nie jest połączony. <button className="link" onClick={() => go({ screen: "integrations" })}>Połącz w ekranie Integracje</button></p>;
}

function GitPanel({ project, setIntegrations }: { project: Project; setIntegrations: (p: Partial<ProjectIntegrations>) => void }) {
  const { snapshot, notify, confirmDialog } = useApp();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [branch, setBranch] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [repoName, setRepoName] = useState(project.name.toLowerCase().replace(/[^a-z0-9-_]+/g, "-"));
  const [priv, setPriv] = useState(true);
  const github = snapshot.accounts.github;

  const refresh = useCallback(async () => {
    try { setStatus(await api.gitStatus(project.path)); setError(""); } catch (e) { setError(errText(e)); }
  }, [project.path]);
  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    try { const out = await fn(); if (out) notify(out); await refresh(); } catch (e) { notify(errText(e), "bad"); } finally { setBusy(null); }
  };

  const commit = () => run("commit", async () => {
    let allow = false;
    if (status?.sensitive.length) {
      if (!(await confirmDialog(`Wśród zmian są pliki, które mogą zawierać hasła lub klucze:\n${status.sensitive.join("\n")}\n\nZatwierdzić je mimo to? Lepiej dodać je do .gitignore.`, "Uwaga: pliki z hasłami"))) return;
      allow = true;
    }
    const author = github ? await api.githubUser().catch(() => undefined) : undefined;
    const out = await api.gitCommit(project.path, message, allow, author);
    setMessage("");
    return `Zatwierdzono: ${out}`;
  });

  const push = () => run("push", async () => {
    const protectedBranch = status?.branch === "main" || status?.branch === "master";
    let allow = Boolean(project.integrations?.allowMainPush);
    if (protectedBranch && !allow) {
      if (!(await confirmDialog(`Wypchnąć zmiany bezpośrednio na gałąź ${status?.branch}?\n\nZwykle bezpieczniej jest utworzyć nową gałąź i pull request.`, "Wypchnięcie na gałąź główną"))) return;
      allow = true;
    }
    return api.gitPush(project.path, allow);
  });

  if (error) return <section className="panel"><h3><GitBranch size={15} /> Historia wersji i GitHub</h3><div className="inline-warn bad">{error}</div></section>;
  if (!status) return <section className="panel"><h3><GitBranch size={15} /> Historia wersji i GitHub</h3><Loader2 size={14} className="spin" /></section>;

  if (!status.isRepo) {
    return (
      <section className="panel">
        <h3><GitBranch size={15} /> Historia wersji i GitHub</h3>
        <p className="muted small">Ten projekt nie ma jeszcze historii wersji. Włącz ją, aby zapisywać kolejne wersje, wypychać na GitHub i wdrażać automatycznie.</p>
        <div className="row"><button className="btn btn-primary" disabled={busy !== null} onClick={() => void run("init", () => api.gitInit(project.path))}>Włącz historię wersji</button></div>
      </section>
    );
  }

  const onMain = status.branch === "main" || status.branch === "master";
  return (
    <section className="panel">
      <div className="section-head">
        <h3><GitBranch size={15} /> Historia wersji i GitHub</h3>
        <button className="btn btn-ghost btn-xs" onClick={() => void refresh()}><RefreshCw size={12} /> Odśwież</button>
      </div>
      <div className="kv">
        <span>Gałąź</span><span className="mono">{status.branch || "—"}</span>
        <span>GitHub</span><span>{status.githubRepo ? <a className="link" href={`https://github.com/${status.githubRepo}`} target="_blank" rel="noreferrer">{status.githubRepo} <ExternalLink size={11} /></a> : status.remote ?? "brak zdalnego repozytorium"}</span>
        <span>Do wysłania</span><span>{status.upstream ? `${status.ahead} commitów${status.behind ? ` · ${status.behind} nowszych na GitHubie` : ""}` : "gałąź jeszcze nie była wypchnięta"}</span>
        <span>Ostatnio</span><span>{status.lastCommit ?? "brak commitów"}</span>
      </div>
      {status.sensitive.length > 0 && <div className="inline-warn bad"><AlertTriangle size={13} /> Pliki mogące zawierać hasła: {status.sensitive.join(", ")}. Dodaj je do .gitignore.</div>}
      {status.files.length > 0 ? (
        <>
          <span className="small muted">Niezatwierdzone zmiany ({status.files.length}):</span>
          <div className="file-list-sm">{status.files.slice(0, 80).map((f) => <div key={f.path}>{f.status}: {f.path}</div>)}</div>
          <div className="row">
            <input className="input grow" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Opis zmian, np. „Dodano formularz kontaktowy”" />
            <button className="btn btn-primary" disabled={!message.trim() || busy !== null} onClick={() => void commit()}>{busy === "commit" && <Loader2 size={13} className="spin" />} Zatwierdź zmiany</button>
          </div>
        </>
      ) : <span className="small muted">Brak niezatwierdzonych zmian.</span>}
      <div className="row">
        {status.remote
          ? <button className="btn" disabled={busy !== null} onClick={() => void push()}>{busy === "push" ? <Loader2 size={13} className="spin" /> : <UploadCloud size={13} />} Wypchnij na GitHub</button>
          : github
            ? <>
                <input className="input" style={{ maxWidth: 240 }} value={repoName} onChange={(e) => setRepoName(e.target.value)} />
                <label className="check"><input type="checkbox" checked={priv} onChange={() => setPriv((p) => !p)} /> prywatne</label>
                <button className="btn" disabled={!repoName.trim() || busy !== null} onClick={() => void run("repo", async () => `Utworzono repozytorium: ${await api.githubCreateRepo(project.path, repoName.trim(), priv)}`)}>Utwórz repozytorium na GitHubie</button>
              </>
            : <NotConnected name="GitHub" />}
      </div>
      <div className="row">
        <input className="input" style={{ maxWidth: 260 }} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="nazwa nowej gałęzi" />
        <button className="btn btn-ghost" disabled={!branch.trim() || busy !== null} onClick={() => void run("branch", async () => { const b = await api.gitBranch(project.path, branch); setBranch(""); return `Przełączono na nową gałąź ${b}.`; })}>Nowa gałąź</button>
      </div>
      {github && status.githubRepo && !onMain && (
        <div className="row">
          <input className="input grow" value={prTitle} onChange={(e) => setPrTitle(e.target.value)} placeholder="Tytuł pull requesta" />
          <button className="btn" disabled={!prTitle.trim() || busy !== null} onClick={() => void run("pr", async () => { const url = await api.githubCreatePr(project.path, prTitle, `Utworzono w AgentOS.\n\n${status.lastCommit ?? ""}`); setPrTitle(""); window.open(url, "_blank"); return `Pull request: ${url}`; })}><GitPullRequest size={13} /> Utwórz pull request</button>
        </div>
      )}
      <label className="check"><input type="checkbox" checked={Boolean(project.integrations?.allowMainPush)} onChange={() => setIntegrations({ allowMainPush: !project.integrations?.allowMainPush })} /> Pozwalaj agentowi wypychać bezpośrednio na main (nadal za Twoją zgodą)</label>
    </section>
  );
}

function VercelPanel({ project, setIntegrations }: { project: Project; setIntegrations: (p: Partial<ProjectIntegrations>) => void }) {
  const { snapshot, notify, confirmDialog } = useApp();
  const link = project.integrations?.vercel;
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }> | null>(null);
  const [deployments, setDeployments] = useState<VercelDeployment[]>([]);
  const [active, setActive] = useState<{ state: string; url?: string } | null>(null);
  const [logs, setLogs] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const teamId = link?.teamId ?? null;

  const loadDeployments = useCallback(async () => {
    if (!link?.projectId) return;
    try { setDeployments(await api.vercelDeployments(link.projectId, link.teamId)); } catch (e) { notify(errText(e), "warn"); }
  }, [link?.projectId, link?.teamId, notify]);

  useEffect(() => {
    if (!snapshot.accounts.vercel) return;
    api.vercelAccount().then((a) => setTeams(a.teams)).catch(() => undefined);
    api.vercelProjects(teamId).then(setProjects).catch((e) => notify(errText(e), "warn"));
    void loadDeployments();
  }, [snapshot.accounts.vercel, teamId, loadDeployments, notify]);

  if (!snapshot.accounts.vercel) return <section className="panel"><h3><Rocket size={15} /> Vercel</h3><NotConnected name="Vercel" /></section>;

  const deploy = async (production: boolean) => {
    if (production && !(await confirmDialog("Wdrożyć na PRODUKCJĘ?\n\nTa wersja zastąpi obecną wersję publiczną. Poprzednią można przywrócić z listy wdrożeń.", "Wdrożenie produkcyjne"))) return;
    setBusy(production ? "prod" : "preview");
    setActive({ state: "UPLOADING" });
    try {
      const dep = await api.vercelDeploy(project.path, link?.name ?? project.name, link?.projectId, teamId, production);
      if (!link?.projectId && dep.projectId) setIntegrations({ vercel: { projectId: dep.projectId, name: link?.name ?? project.name, teamId } });
      const result = await waitForDeployment(dep.id, teamId, (state) => setActive({ state, url: dep.url }), () => false);
      setActive({ state: result.state, url: result.url ?? dep.url });
      if (result.state === "READY") notify(`Wdrożenie gotowe: ${result.url ?? dep.url}`);
      else {
        notify(`Wdrożenie: ${deployStateLabel[result.state] ?? result.state}${result.error ? ` — ${result.error}` : ""}`, "bad");
        setLogs({ id: dep.id, text: await api.vercelLogs(dep.id, teamId).catch((e) => errText(e)) });
      }
      await loadDeployments();
    } catch (e) {
      setActive(null);
      notify(errText(e), "bad");
    } finally { setBusy(null); }
  };

  const rollback = async (d: VercelDeployment) => {
    if (!link?.projectId) return;
    if (!(await confirmDialog(`Przywrócić wdrożenie z ${d.created ? new Date(d.created).toLocaleString("pl-PL") : "?"} jako wersję produkcyjną?`, "Przywróć poprzednie wdrożenie"))) return;
    try { await api.vercelRollback(link.projectId, d.id, teamId); notify("Ruch produkcyjny przekierowano na wybrane wdrożenie."); await loadDeployments(); } catch (e) { notify(errText(e), "bad"); }
  };

  return (
    <section className="panel">
      <div className="section-head">
        <h3><Rocket size={15} /> Vercel</h3>
        {link?.projectId && <button className="btn btn-ghost btn-xs" onClick={() => void loadDeployments()}><RefreshCw size={12} /> Odśwież</button>}
      </div>
      <div className="row">
        {teams.length > 0 && (
          <select className="input" style={{ maxWidth: 200 }} value={teamId ?? ""} onChange={(e) => setIntegrations({ vercel: { name: link?.name ?? project.name, teamId: e.target.value || null } })}>
            <option value="">Konto osobiste</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <select className="input grow" value={link?.projectId ?? ""} onChange={(e) => {
          const p = projects?.find((x) => x.id === e.target.value);
          setIntegrations({ vercel: p ? { projectId: p.id, name: p.name, teamId } : { name: project.name, teamId } });
        }}>
          <option value="">— nowy projekt Vercel „{project.name}” przy pierwszym wdrożeniu —</option>
          {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="row">
        <button className="btn" disabled={busy !== null} onClick={() => void deploy(false)}>{busy === "preview" ? <Loader2 size={13} className="spin" /> : <Rocket size={13} />} Wdróż podgląd</button>
        <button className="btn btn-danger-solid" disabled={busy !== null} onClick={() => void deploy(true)}>{busy === "prod" ? <Loader2 size={13} className="spin" /> : <Rocket size={13} />} Wdróż na produkcję</button>
        {active && <span className="small">{active.state === "UPLOADING" ? "Wysyłanie plików…" : `Stan: ${deployStateLabel[active.state] ?? active.state}`} {active.url && active.state === "READY" && <a className="link" href={active.url} target="_blank" rel="noreferrer">{active.url} <ExternalLink size={11} /></a>}</span>}
      </div>
      <p className="muted small">Wysyłane są pliki projektu bez .env, node_modules i .git. Vercel sam rozpoznaje technologię i buduje projekt.</p>
      {deployments.length > 0 && (
        <div className="list">
          {deployments.map((d) => (
            <div key={d.id} className="deploy-row">
              <span className={`pill pill-${d.state === "READY" ? "done" : d.state === "ERROR" ? "failed" : "running"}`}>{deployStateLabel[d.state ?? ""] ?? d.state}</span>
              <span className="muted small">{d.target === "production" ? "produkcja" : "podgląd"} · {d.created ? relativeTime(new Date(d.created).toISOString()) : ""}</span>
              {d.url && <a className="ellipsis small" href={d.url} target="_blank" rel="noreferrer">{d.url.replace("https://", "")}</a>}
              <span style={{ marginLeft: "auto" }} className="row">
                <button className="btn btn-ghost btn-xs" onClick={async () => setLogs({ id: d.id, text: await api.vercelLogs(d.id, teamId).catch((e) => errText(e)) })}><ScrollText size={12} /> Logi</button>
                {d.state === "READY" && d.target === "production" && <button className="btn btn-ghost btn-xs" onClick={() => void rollback(d)}><RotateCcw size={12} /> Przywróć</button>}
              </span>
            </div>
          ))}
        </div>
      )}
      {logs && <><div className="row"><strong className="small">Logi budowania</strong><button className="link small" onClick={() => setLogs(null)}>zamknij</button></div><pre className="logs">{logs.text}</pre></>}
    </section>
  );
}

function SupabasePanel({ project, setIntegrations }: { project: Project; setIntegrations: (p: Partial<ProjectIntegrations>) => void }) {
  const { snapshot, notify, confirmDialog } = useApp();
  const link = project.integrations?.supabase;
  const [projects, setProjects] = useState<Array<{ ref: string; name: string }> | null>(null);
  const [sql, setSql] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("NEXT_PUBLIC_");
  useEffect(() => {
    if (snapshot.accounts.supabase) api.supabaseProjects().then(setProjects).catch((e) => notify(errText(e), "warn"));
  }, [snapshot.accounts.supabase, notify]);
  if (!snapshot.accounts.supabase) return <section className="panel"><h3><Database size={15} /> Supabase</h3><NotConnected name="Supabase" /></section>;

  const run = async (key: string, fn: () => Promise<void>) => { setBusy(key); try { await fn(); } catch (e) { notify(errText(e), "bad"); } finally { setBusy(null); } };
  const execute = () => run("sql", async () => {
    const readOnly = isReadOnlySql(sql);
    if (!readOnly && !(await confirmDialog(`To zapytanie zmienia dane lub strukturę bazy „${link!.name}”. Tego nie da się cofnąć przyciskiem.\n\n${sql.slice(0, 800)}`, "Zmiana w bazie danych"))) return;
    setResult(formatRows(await api.supabaseQuery(link!.ref, sql, readOnly), 200));
  });
  const vercel = project.integrations?.vercel;

  return (
    <section className="panel">
      <h3><Database size={15} /> Supabase</h3>
      <select className="input" value={link?.ref ?? ""} onChange={(e) => {
        const p = projects?.find((x) => x.ref === e.target.value);
        setIntegrations({ supabase: p ? { ref: p.ref, name: p.name } : undefined });
      }}>
        <option value="">— wybierz projekt Supabase —</option>
        {(projects ?? []).map((p) => <option key={p.ref} value={p.ref}>{p.name}</option>)}
      </select>
      {link && (
        <>
          <div className="kv"><span>Adres</span><span className="mono">https://{link.ref}.supabase.co</span></div>
          <div className="row">
            <button className="btn" disabled={busy !== null} onClick={() => void run("schema", async () => setResult(formatRows(await api.supabaseQuery(link.ref, SCHEMA_SQL, true), 200)))}>Struktura bazy</button>
            <button className="btn" disabled={busy !== null} onClick={() => void run("types", async () => {
              const types = await api.supabaseTypes(link.ref);
              const hasSrc = (await api.listFiles(project.path, "", 1).catch(() => [])).some((f) => f.path === "src" && f.kind === "dir");
              const target = hasSrc ? "src/lib/database.types.ts" : "database.types.ts";
              await api.writeFile(project.path, target, types, `manual-${project.id}`, await api.fileHash(project.path, target));
              notify(`Zapisano typy bazy w ${target} (poprzednia wersja ma kopię zapasową).`);
            })}>Zapisz typy TypeScript</button>
            {vercel?.projectId && (
              <>
                <select className="input" style={{ maxWidth: 160 }} value={prefix} onChange={(e) => setPrefix(e.target.value)}>
                  <option value="NEXT_PUBLIC_">NEXT_PUBLIC_</option><option value="VITE_">VITE_</option><option value="">bez przedrostka</option>
                </select>
                <button className="btn" disabled={busy !== null} onClick={() => void run("env", async () => {
                  const keys = await api.supabaseKeys(link.ref);
                  if (!keys.publicKey) throw new Error("Nie udało się pobrać klucza publicznego Supabase.");
                  await api.vercelSetEnv(vercel.projectId!, vercel.teamId, `${prefix}SUPABASE_URL`, keys.url, false);
                  await api.vercelSetEnv(vercel.projectId!, vercel.teamId, `${prefix}SUPABASE_ANON_KEY`, keys.publicKey, false);
                  notify(`Ustawiono ${prefix}SUPABASE_URL i ${prefix}SUPABASE_ANON_KEY w Vercelu. Zadziałają przy następnym wdrożeniu.`);
                })}>Przekaż adres i klucz do Vercela</button>
              </>
            )}
          </div>
          <textarea className="text-area sql-box" rows={4} value={sql} onChange={(e) => setSql(e.target.value)} placeholder="select * from public.nazwa_tabeli limit 20;" />
          <div className="row">
            <button className="btn btn-primary" disabled={!sql.trim() || busy !== null} onClick={() => void execute()}>{busy === "sql" && <Loader2 size={13} className="spin" />} Wykonaj</button>
            <span className="muted small">{sql.trim() ? (isReadOnlySql(sql) ? "Tylko odczyt — wykona się bez pytania." : "Zmienia bazę — zapytam o potwierdzenie.") : ""}</span>
          </div>
          {result && <pre className="logs">{result}</pre>}
        </>
      )}
    </section>
  );
}
