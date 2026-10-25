import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ExternalLink, FolderInput, Globe, KeyRound, Link2, Loader2, Puzzle, RefreshCw, Search, Star, Trash2, X } from "lucide-react";
import { api, inDesktopApp } from "../api";
import { useApp } from "../context";
import { EmptyState } from "../components";
import { Markdown } from "../Markdown";
import { skillToggleId, type InstalledSkill, type RemoteSkill, type SkillPreview, type SkillSearchResult } from "../types";

type Tab = "installed" | "find" | "add";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SkillsView() {
  const { snapshot } = useApp();
  const [tab, setTab] = useState<Tab>("installed");
  const [projectId, setProjectId] = useState<string | null>(snapshot.projects[0]?.id ?? null);
  const project = snapshot.projects.find((p) => p.id === projectId) ?? null;
  const [installed, setInstalled] = useState<InstalledSkill[] | null>(null);
  const [preview, setPreview] = useState<RemoteSkill | null>(null);

  const reload = useCallback(async () => {
    if (!inDesktopApp) { setInstalled([]); return; }
    try { setInstalled(await api.skillList(project?.path)); } catch { setInstalled([]); }
  }, [project?.path]);
  useEffect(() => { void reload(); }, [reload]);

  const isInstalled = (remote: RemoteSkill) => installed?.some((s) => s.repo === remote.repo && (s.repoPath ?? "") === remote.dir);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Umiejętności</h1>
          <p className="muted">Gotowe instrukcje, które uczą agenta konkretnej pracy — np. tworzenia PDF i arkuszy, analizy umów, testowania stron. Format SKILL.md jest zgodny z Claude i Codex. Agent sam sięga po pasującą umiejętność, a gdy żadnej nie ma — może ją wyszukać i zaproponować instalację.</p>
        </div>
        <label className="chip chip-select" title="Projekt, którego umiejętności pokazać i do którego instalować">
          <span className="muted">Projekt:</span>
          <select value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value || null)}>
            <option value="">— tylko globalne —</option>
            {snapshot.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </header>
      <nav className="tabs">
        <button className={`tab ${tab === "installed" ? "on" : ""}`} onClick={() => setTab("installed")}><Puzzle size={14} /> Zainstalowane{installed ? ` (${installed.length})` : ""}</button>
        <button className={`tab ${tab === "find" ? "on" : ""}`} onClick={() => setTab("find")}><Search size={14} /> Znajdź</button>
        <button className={`tab ${tab === "add" ? "on" : ""}`} onClick={() => setTab("add")}><Link2 size={14} /> Dodaj z linku</button>
      </nav>
      {tab === "installed" && <InstalledTab skills={installed} projectId={projectId} projectPath={project?.path ?? null} onChanged={reload} onFind={() => setTab("find")} />}
      {tab === "find" && <FindTab onPreview={setPreview} isInstalled={isInstalled} />}
      {tab === "add" && <AddTab onPreview={setPreview} projectPath={project?.path ?? null} onChanged={reload} isInstalled={isInstalled} />}
      {preview && <PreviewModal skill={preview} projectName={project?.name ?? null} projectPath={project?.path ?? null} onClose={() => setPreview(null)} onInstalled={() => { void reload(); }} />}
    </div>
  );
}

function InstalledTab({ skills, projectId, projectPath, onChanged, onFind }: { skills: InstalledSkill[] | null; projectId: string | null; projectPath: string | null; onChanged: () => Promise<void>; onFind: () => void }) {
  const { snapshot, mutate, notify, confirmDialog } = useApp();
  const [open, setOpen] = useState<InstalledSkill | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!skills) return <div className="pad muted"><Loader2 size={14} className="spin" /> Wczytywanie…</div>;
  if (!inDesktopApp) return <EmptyState title="Umiejętności działają w aplikacji AgentOS na Macu" />;
  if (skills.length === 0) {
    return (
      <EmptyState icon={<Puzzle size={18} />} title="Brak zainstalowanych umiejętności" text="Zacznij od oficjalnego katalogu albo wklej adres repozytorium GitHub.">
        <button className="btn btn-primary" onClick={onFind}><Search size={14} /> Przeglądaj katalog</button>
      </EmptyState>
    );
  }
  const toggle = (skill: InstalledSkill) => {
    const id = skillToggleId(skill, projectId);
    mutate((s) => ({ ...s, disabledSkills: s.disabledSkills.includes(id) ? s.disabledSkills.filter((x) => x !== id) : [...s.disabledSkills, id] }));
  };
  const remove = async (skill: InstalledSkill) => {
    if (!(await confirmDialog(`Usunąć umiejętność „${skill.name}”? Jej folder zostanie skasowany.`, "Usuń umiejętność"))) return;
    try { await api.skillRemove(skill.key, projectPath); notify(`Usunięto „${skill.name}”.`); await onChanged(); } catch (e) { notify(errText(e), "bad"); }
  };
  const update = async (skill: InstalledSkill) => {
    if (!skill.repo) return;
    setBusy(skill.key);
    try {
      await api.skillInstall({ repo: skill.repo, gitRef: skill.gitRef ?? "HEAD", dir: skill.repoPath ?? "" }, skill.scope, projectPath, true);
      notify(`Zaktualizowano „${skill.name}” do najnowszej wersji.`);
      await onChanged();
    } catch (e) { notify(errText(e), "bad"); } finally { setBusy(null); }
  };
  const groups: Array<[string, InstalledSkill[]]> = [
    ["Dla wszystkich projektów", skills.filter((s) => s.scope === "global")],
    [`W projekcie ${snapshot.projects.find((p) => p.id === projectId)?.name ?? ""}`, skills.filter((s) => s.scope === "project")],
  ];
  return (
    <div className="tab-body">
      {groups.filter(([, items]) => items.length).map(([title, items]) => (
        <section key={title}>
          <div className="section-head"><h2>{title}</h2></div>
          <div className="skill-grid">
            {items.map((skill) => {
              const enabled = !snapshot.disabledSkills.includes(skillToggleId(skill, projectId));
              return (
                <article key={skill.key} className={`skill-card ${enabled ? "" : "is-off"}`}>
                  <div className="skill-card-top">
                    <strong className="ellipsis">{skill.name}</strong>
                    <button className={`switch ${enabled ? "on" : ""}`} role="switch" aria-checked={enabled} aria-label={enabled ? "Wyłącz" : "Włącz"} onClick={() => toggle(skill)}><i /></button>
                  </div>
                  <p className="skill-desc">{skill.description || "Bez opisu."}</p>
                  <div className="skill-meta">
                    <span className="badge badge-cloud">{skill.location}</span>
                    <span className="muted small">{skill.fileCount} plików{skill.hasScripts ? " · ze skryptami" : ""}</span>
                  </div>
                  <div className="row">
                    <button className="btn btn-ghost btn-xs" onClick={() => setOpen(skill)}>Podgląd</button>
                    {skill.repo && <button className="btn btn-ghost btn-xs" disabled={busy === skill.key} onClick={() => void update(skill)}>{busy === skill.key ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Aktualizuj</button>}
                    {skill.removable && <button className="btn btn-ghost btn-xs btn-danger" onClick={() => void remove(skill)}><Trash2 size={12} /> Usuń</button>}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
      {open && <InstalledPreview skill={open} projectPath={projectPath} onClose={() => setOpen(null)} />}
    </div>
  );
}

function InstalledPreview({ skill, projectPath, onClose }: { skill: InstalledSkill; projectPath: string | null; onClose: () => void }) {
  const [data, setData] = useState<{ content: string; files: string[]; dir: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api.skillRead(skill.key, projectPath).then(setData).catch((e) => setError(errText(e))); }, [skill.key, projectPath]);
  return (
    <WideModal title={skill.name} onClose={onClose}>
      {skill.source && <p className="muted small">Źródło: {skill.source}</p>}
      {error && <p className="bad">{error}</p>}
      {!data && !error && <Loader2 size={14} className="spin" />}
      {data && (
        <div className="preview-split">
          <div className="preview-md"><Markdown text={data.content.replace(/^---[\s\S]*?\n---\n?/, "")} /></div>
          <aside className="preview-files"><strong className="small">Pliki</strong>{data.files.map((f) => <span key={f} className="mono ellipsis">{f}</span>)}</aside>
        </div>
      )}
    </WideModal>
  );
}

function FindTab({ onPreview, isInstalled }: { onPreview: (s: RemoteSkill) => void; isInstalled: (s: RemoteSkill) => boolean | undefined }) {
  const { snapshot, notify } = useApp();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SkillSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const search = useCallback(async (q: string) => {
    if (!inDesktopApp) { notify("Wyszukiwanie działa w aplikacji AgentOS na Macu.", "warn"); return; }
    setBusy(true);
    try { setResult(await api.skillSearch(q, snapshot.skillSources)); } catch (e) { notify(errText(e), "bad"); } finally { setBusy(false); }
  }, [notify, snapshot.skillSources]);
  useEffect(() => { void search(""); }, [search]);
  return (
    <div className="tab-body">
      <div className="search-row">
        <div className="search-box"><Search size={15} />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(query); }} placeholder="Czego ma się nauczyć agent? Np. pdf, excel, umowy, testy stron, prezentacje…" />
        </div>
        <button className="btn btn-primary" disabled={busy} onClick={() => void search(query)}>{busy ? <Loader2 size={14} className="spin" /> : <Search size={14} />} Szukaj</button>
      </div>
      <p className="muted small">Katalog: {snapshot.skillSources.join(", ") || "brak źródeł"}. Wpisane hasło przeszukuje też GitHub{result?.usedToken ? " (również pliki SKILL.md)" : ""}. <button className="link" onClick={() => setShowSources((s) => !s)}>Źródła i token</button></p>
      {showSources && <SourcesPanel />}
      {result?.errors.map((e) => <div key={e} className="inline-warn"><AlertTriangle size={13} /> {e}</div>)}
      {busy && !result && <div className="pad muted"><Loader2 size={14} className="spin" /> Szukam…</div>}
      {result && (
        <>
          <SkillSection title="Katalog" hint="Repozytoria z listy źródeł" skills={result.catalog} onPreview={onPreview} isInstalled={isInstalled} empty={query ? "W katalogu nic nie pasuje do tego hasła." : "Katalog jest pusty albo niedostępny."} />
          {result.community.length > 0 && <SkillSection title="Społeczność" hint="Pliki SKILL.md znalezione na GitHubie — sprawdź podgląd przed instalacją" skills={result.community} onPreview={onPreview} isInstalled={isInstalled} />}
          {result.repos.length > 0 && (
            <section>
              <div className="section-head"><h2><Globe size={14} /> Repozytoria na GitHubie</h2><span className="muted small">Mogą zawierać umiejętności — otwórz, aby sprawdzić</span></div>
              <div className="list">
                {result.repos.map((repo) => (
                  <div key={repo.repo} className="list-row">
                    <span className="list-main"><strong className="ellipsis">{repo.repo}</strong><small className="ellipsis">{repo.description || "Bez opisu"}</small></span>
                    <span className="muted small nowrap"><Star size={11} /> {repo.stars}</span>
                    <RepoOpenButton source={repo.repo} onPreview={onPreview} />
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
      {result === null && !busy && <EmptyState title="Wpisz hasło i naciśnij Szukaj" />}
    </div>
  );
}

function RepoOpenButton({ source, onPreview }: { source: string; onPreview: (s: RemoteSkill) => void }) {
  const { notify } = useApp();
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<RemoteSkill[] | null>(null);
  if (found) {
    return found.length === 1
      ? <button className="btn btn-xs" onClick={() => onPreview(found[0])}>Podgląd</button>
      : <select className="input input-xs" defaultValue="" onChange={(e) => { const s = found[Number(e.target.value)]; if (s) onPreview(s); }}>
          <option value="" disabled>{found.length} umiejętności…</option>
          {found.map((s, i) => <option key={s.dir} value={i}>{s.name}</option>)}
        </select>;
  }
  return (
    <button className="btn btn-xs" disabled={busy} onClick={async () => {
      setBusy(true);
      try { const r = await api.skillInspect(source); setFound(r); if (r.length === 1) onPreview(r[0]); } catch (e) { notify(errText(e), "warn"); } finally { setBusy(false); }
    }}>{busy ? <Loader2 size={12} className="spin" /> : null} Sprawdź</button>
  );
}

function SkillSection({ title, hint, skills, onPreview, isInstalled, empty }: { title: string; hint: string; skills: RemoteSkill[]; onPreview: (s: RemoteSkill) => void; isInstalled: (s: RemoteSkill) => boolean | undefined; empty?: string }) {
  return (
    <section>
      <div className="section-head"><h2>{title}</h2><span className="muted small">{hint}</span></div>
      {skills.length === 0 ? <p className="muted small">{empty}</p> : (
        <div className="skill-grid">
          {skills.map((s) => (
            <button key={`${s.repo}/${s.dir}`} className="skill-card skill-card-btn" onClick={() => onPreview(s)}>
              <div className="skill-card-top"><strong className="ellipsis">{s.name}</strong>{isInstalled(s) && <span className="badge badge-local">zainstalowana</span>}</div>
              <p className="skill-desc">{s.description || "Bez opisu."}</p>
              <div className="skill-meta"><span className="muted small ellipsis mono">{s.repo}</span>{s.hasScripts && <span className="muted small">· skrypty</span>}</div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function SourcesPanel() {
  const { snapshot, mutate, notify } = useApp();
  const [value, setValue] = useState("");
  const [tokenValue, setTokenValue] = useState("");
  return (
    <div className="panel">
      <h3>Źródła katalogu</h3>
      <p className="muted small">Repozytoria GitHub z umiejętnościami, które AgentOS przegląda zawsze. Domyślnie oficjalne repozytorium Anthropic.</p>
      <div className="memory">
        {snapshot.skillSources.map((src) => (
          <div key={src} className="memory-row"><span className="mono">{src}</span>
            <button className="icon-btn" title="Usuń źródło" onClick={() => mutate((s) => ({ ...s, skillSources: s.skillSources.filter((x) => x !== src) }))}><X size={13} /></button>
          </div>
        ))}
      </div>
      <div className="row">
        <input className="input grow" value={value} onChange={(e) => setValue(e.target.value)} placeholder="właściciel/repozytorium albo adres GitHub" />
        <button className="btn" disabled={!value.trim()} onClick={() => { const v = value.trim(); mutate((s) => ({ ...s, skillSources: s.skillSources.includes(v) ? s.skillSources : [...s.skillSources, v] })); setValue(""); }}>Dodaj źródło</button>
      </div>
      <h3><KeyRound size={14} /> Token GitHub (opcjonalnie)</h3>
      <p className="muted small">Bez tokenu GitHub pozwala na ok. 60 zapytań na godzinę i nie przeszukuje treści plików. Token (bez żadnych uprawnień, typu „fine-grained, public repositories”) podnosi limit i włącza wyszukiwanie plików SKILL.md. Zapisywany w pęku kluczy macOS.</p>
      <div className="row">
        <input className="input grow" type="password" value={tokenValue} onChange={(e) => setTokenValue(e.target.value)} placeholder="Token GitHub (fine-grained albo classic)" />
        <button className="btn" disabled={!tokenValue.trim()} onClick={async () => {
          try { await api.saveProvider({ id: "github", name: "GitHub", kind: "custom", model: "", endpoint: "https://api.github.com", hasKey: false }, tokenValue.trim()); setTokenValue(""); notify("Token GitHub zapisany w pęku kluczy."); }
          catch (e) { notify(errText(e), "bad"); }
        }}>Zapisz token</button>
      </div>
    </div>
  );
}

function AddTab({ onPreview, projectPath, onChanged, isInstalled }: { onPreview: (s: RemoteSkill) => void; projectPath: string | null; onChanged: () => Promise<void>; isInstalled: (s: RemoteSkill) => boolean | undefined }) {
  const { notify, confirmDialog } = useApp();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<RemoteSkill[] | null>(null);
  const [scope, setScope] = useState<"global" | "project">(projectPath ? "project" : "global");
  const inspect = async () => {
    setBusy(true);
    setFound(null);
    try { const r = await api.skillInspect(url.trim()); setFound(r); if (r.length === 1) onPreview(r[0]); }
    catch (e) { notify(errText(e), "bad"); } finally { setBusy(false); }
  };
  const importLocal = async () => {
    if (!inDesktopApp) { notify("Import z folderu działa w aplikacji AgentOS na Macu.", "warn"); return; }
    const selected = await open({ directory: true, multiple: false, title: "Wybierz folder umiejętności (z plikiem SKILL.md) albo folder z wieloma umiejętnościami" });
    if (!selected || Array.isArray(selected)) return;
    const run = async (overwrite: boolean) => {
      const result = await api.skillImportLocal(selected, scope, projectPath, overwrite);
      notify(`Zaimportowano: ${result.map((s) => s.name).join(", ")}.`);
      await onChanged();
    };
    try { await run(false); }
    catch (e) {
      const message = errText(e);
      if (message.startsWith("EXISTS:") && (await confirmDialog(`${message.replace("EXISTS: ", "")}\n\nZastąpić istniejące wersje?`, "Import umiejętności"))) {
        try { await run(true); } catch (err) { notify(errText(err), "bad"); }
      } else if (!message.startsWith("EXISTS:")) notify(message, "bad");
    }
  };
  return (
    <div className="tab-body">
      <section className="panel">
        <h3><Link2 size={14} /> Z adresu GitHub</h3>
        <p className="muted small">Repozytorium, folder umiejętności albo link do pliku SKILL.md. AgentOS pokaże treść, pliki i miejsca wymagające uwagi, zanim cokolwiek zainstaluje.</p>
        <div className="row">
          <input className="input grow" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) void inspect(); }} placeholder="https://github.com/właściciel/repo/tree/main/skills/nazwa" />
          <button className="btn btn-primary" disabled={!url.trim() || busy} onClick={() => void inspect()}>{busy ? <Loader2 size={14} className="spin" /> : null} Sprawdź</button>
        </div>
        {found && found.length > 1 && <SkillSection title={`Znaleziono ${found.length} umiejętności`} hint="Wybierz, którą obejrzeć" skills={found} onPreview={onPreview} isInstalled={isInstalled} />}
      </section>
      <section className="panel">
        <h3><FolderInput size={14} /> Z folderu na Macu</h3>
        <p className="muted small">Np. umiejętności z Claude Code (~/.claude/skills) albo pobrane archiwum po rozpakowaniu. Wskaż folder jednej umiejętności lub folder z wieloma.</p>
        <div className="row">
          <div className="segmented segmented-row compact">
            <button className={scope === "global" ? "on" : ""} onClick={() => setScope("global")}><strong>Dla wszystkich projektów</strong></button>
            <button className={scope === "project" ? "on" : ""} disabled={!projectPath} onClick={() => setScope("project")}><strong>Tylko w wybranym projekcie</strong></button>
          </div>
          <button className="btn" onClick={() => void importLocal()}><FolderInput size={14} /> Wybierz folder…</button>
        </div>
      </section>
    </div>
  );
}

function PreviewModal({ skill, projectName, projectPath, onClose, onInstalled }: { skill: RemoteSkill; projectName: string | null; projectPath: string | null; onClose: () => void; onInstalled: () => void }) {
  const { notify, confirmDialog } = useApp();
  const [data, setData] = useState<SkillPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { api.skillPreview(skill).then(setData).catch((e) => setError(errText(e))); }, [skill]);
  const install = async (scope: "global" | "project") => {
    setBusy(scope);
    const run = (overwrite: boolean) => api.skillInstall(data?.skill ?? skill, scope, projectPath, overwrite);
    try {
      let result;
      try { result = await run(false); }
      catch (e) {
        if (!errText(e).startsWith("EXISTS:")) throw e;
        if (!(await confirmDialog(`Umiejętność „${skill.name}” jest już zainstalowana w tym miejscu. Zastąpić ją tą wersją?`, "Instalacja umiejętności"))) return;
        result = await run(true);
      }
      notify(`Zainstalowano „${result.name}” ${scope === "global" ? "dla wszystkich projektów" : `w projekcie ${projectName}`}.`);
      onInstalled();
      onClose();
    } catch (e) { notify(errText(e), "bad"); } finally { setBusy(null); }
  };
  const scripts = data?.files.filter((f) => f.script) ?? [];
  return (
    <WideModal title={skill.name} onClose={onClose}>
      <div className="row muted small">
        <span className="mono">{skill.repo}{skill.dir ? `/${skill.dir}` : ""}</span>
        <a className="link" href={skill.url} target="_blank" rel="noreferrer"><ExternalLink size={12} /> GitHub</a>
      </div>
      {error && <div className="inline-warn bad"><AlertTriangle size={13} /> {error}</div>}
      {!data && !error && <div className="pad muted"><Loader2 size={14} className="spin" /> Pobieram podgląd i sprawdzam pliki…</div>}
      {data && (
        <>
          {data.blocked && <div className="inline-warn bad"><AlertTriangle size={13} /> {data.blocked}</div>}
          {data.risks.length > 0 && (
            <div className="risk-box">
              <strong><AlertTriangle size={13} /> Do sprawdzenia przed instalacją</strong>
              <span className="small">To nie musi oznaczać zagrożenia — wiele umiejętności legalnie pobiera dane lub uruchamia skrypty. Skrypty nigdy nie uruchamiają się same: agent musi poprosić o zgodę na każde polecenie.</span>
              <ul>{data.risks.map((r) => <li key={r} className="mono">{r}</li>)}</ul>
            </div>
          )}
          <div className="preview-split">
            <div className="preview-md"><Markdown text={data.content.replace(/^---[\s\S]*?\n---\n?/, "")} /></div>
            <aside className="preview-files">
              <strong className="small">{data.files.length} plików{scripts.length ? ` · ${scripts.length} skryptów` : ""}</strong>
              {data.files.slice(0, 200).map((f) => <span key={f.path} className={`mono ellipsis ${f.script ? "warn-text" : ""}`} title={`${f.size} B`}>{f.path}</span>)}
            </aside>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose}>Zamknij</button>
            <button className="btn" disabled={Boolean(data.blocked) || busy !== null} onClick={() => void install("global")}>{busy === "global" && <Loader2 size={13} className="spin" />} Zainstaluj dla wszystkich projektów</button>
            {projectPath && <button className="btn btn-primary" disabled={Boolean(data.blocked) || busy !== null} onClick={() => void install("project")}>{busy === "project" && <Loader2 size={13} className="spin" />} Zainstaluj w „{projectName}”</button>}
          </div>
        </>
      )}
    </WideModal>
  );
}

function WideModal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay overlay-wide" onMouseDown={onClose}>
      <div className="modal modal-wide" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Zamknij"><X size={15} /></button></div>
        {children}
      </div>
    </div>
  );
}
