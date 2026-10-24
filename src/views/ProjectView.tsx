import { useEffect, useState } from "react";
import { ArrowRight, Rocket, Brain, File, FileEdit, FilePlus, Folder, FolderOpen, History, Loader2, MessageSquare, Plus, RotateCcw, Settings2, Terminal, Trash2, Undo2 } from "lucide-react";
import { api } from "../api";
import { useApp, relativeTime } from "../context";
import { Composer, DiffView, EmptyState, ModelPicker, StatusDot, StatusPill } from "../components";
import { uid, nowIso } from "../store";
import { accessModeLabel, type AccessMode, type Project, type Route } from "../types";
import { useUndo } from "./useUndo";
import { PublishTab } from "./PublishTab";

type Tab = Extract<Route, { screen: "project" }>["tab"];

export function ProjectView({ projectId, tab }: { projectId: string; tab: Tab }) {
  const { snapshot, go, notify } = useApp();
  const project = snapshot.projects.find((p) => p.id === projectId);
  if (!project) return <div className="page"><p className="muted">Projekt został usunięty z listy.</p></div>;
  const changeCount = snapshot.conversations.filter((c) => c.projectId === project.id).flatMap((c) => c.changes).filter((c) => !c.undone).length;
  const tabs: Array<[Tab, string, typeof MessageSquare]> = [
    ["chats", "Rozmowy", MessageSquare],
    ["files", "Pliki", Folder],
    ["changes", changeCount ? `Zmiany (${changeCount})` : "Zmiany", History],
    ["publish", "Publikacja", Rocket],
    ["settings", "Ustawienia projektu", Settings2],
  ];
  const open = (mode: "finder" | "terminal") => api.openInSystem(project.path, mode).catch((e) => notify(String(e instanceof Error ? e.message : e), "bad"));
  return (
    <div className="page project-page">
      <header className="page-head">
        <div>
          <h1>{project.name}</h1>
          <p className="mono muted small">{project.path.replace(/^\/Users\/[^/]+/, "~")}</p>
        </div>
        <div className="row">
          <button className="btn btn-ghost" onClick={() => void open("finder")}><FolderOpen size={14} /> Pokaż w Finderze</button>
          <button className="btn btn-ghost" onClick={() => void open("terminal")}><Terminal size={14} /> Terminal</button>
        </div>
      </header>
      <nav className="tabs">
        {tabs.map(([id, label, Icon]) => (
          <button key={id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => go({ screen: "project", projectId: project.id, tab: id })}><Icon size={14} /> {label}</button>
        ))}
      </nav>
      {tab === "chats" && <ChatsTab project={project} />}
      {tab === "files" && <FilesTab project={project} />}
      {tab === "changes" && <ChangesTab project={project} />}
      {tab === "publish" && <PublishTab project={project} />}
      {tab === "settings" && <SettingsTab project={project} />}
    </div>
  );
}

function ChatsTab({ project }: { project: Project }) {
  const { snapshot, go, startConversation, runner, defaultProvider, usableProviders } = useApp();
  const [text, setText] = useState("");
  const providerId = project.providerId && usableProviders.some((p) => p.id === project.providerId) ? project.providerId : defaultProvider?.id ?? "";
  const [choice, setChoice] = useState<{ providerId: string; model: string } | null>(null);
  const model = choice?.model ?? usableProviders.find((p) => p.id === (choice?.providerId ?? providerId))?.model ?? "";
  const convs = snapshot.conversations.filter((c) => c.projectId === project.id);
  return (
    <div className="tab-body">
      <Composer value={text} onChange={setText} placeholder={`Nowe zadanie w „${project.name}”…`} onSend={() => {
        if (startConversation({ projectId: project.id, text: text.trim(), providerId: choice?.providerId ?? providerId, model })) setText("");
      }}>
        {usableProviders.length > 0 && <ModelPicker providerId={choice?.providerId ?? providerId} model={model} onChange={(p, m) => setChoice({ providerId: p, model: m })} />}
        <span className="chip chip-static" title={accessModeLabel[project.accessMode].long}>{accessModeLabel[project.accessMode].short}</span>
      </Composer>
      {convs.length === 0
        ? <EmptyState icon={<MessageSquare size={18} />} title="Brak rozmów w tym projekcie" text="Opisz pierwsze zadanie powyżej. Agent najpierw przejrzy pliki projektu." />
        : (
          <div className="list">
            {convs.map((c) => (
              <button key={c.id} className="list-row" onClick={() => go({ screen: "conversation", conversationId: c.id })}>
                <StatusDot status={c.status} />
                <span className="list-main"><strong className="ellipsis">{c.title}</strong><small>{relativeTime(c.updatedAt)}{c.changes.length ? ` · ${c.changes.filter((x) => !x.undone).length} zmian w plikach` : ""}</small></span>
                <StatusPill status={c.status} stopping={runner.isStopping(c.id)} />
                <ArrowRight size={14} className="muted" />
              </button>
            ))}
          </div>
        )}
    </div>
  );
}

function FilesTab({ project }: { project: Project }) {
  const { notify } = useApp();
  const [entries, setEntries] = useState<Array<{ path: string; kind: "dir" | "file"; size: number }> | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    api.listFiles(project.path, "", 4).then(setEntries).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [project.path]);
  const openFile = async (path: string) => {
    setSelected(path);
    setLoading(true);
    try { setContent(await api.readFile(project.path, path)); }
    catch (e) { setContent(""); notify(e instanceof Error ? e.message : String(e), "warn"); }
    finally { setLoading(false); }
  };
  if (error) return <EmptyState title="Nie można odczytać folderu" text={error} />;
  if (!entries) return <div className="muted pad"><Loader2 size={14} className="spin" /> Wczytywanie plików…</div>;
  if (entries.length === 0) return <EmptyState icon={<Folder size={18} />} title="Folder jest pusty" text="Poproś agenta w zakładce Rozmowy, aby utworzył pierwsze pliki." />;
  return (
    <div className="files">
      <div className="file-tree">
        {entries.map((e) => {
          const depth = e.path.split("/").length - 1;
          const name = e.path.split("/").pop();
          return (
            <button key={e.path} className={`tree-row ${selected === e.path ? "on" : ""}`} style={{ paddingLeft: 10 + depth * 14 }} disabled={e.kind === "dir"} onClick={() => void openFile(e.path)}>
              {e.kind === "dir" ? <Folder size={13} /> : <File size={13} />}<span className="ellipsis">{name}</span>
            </button>
          );
        })}
        {entries.length >= 600 && <p className="muted small pad">Pokazano pierwsze 600 pozycji.</p>}
      </div>
      <div className="file-preview">
        {!selected ? <EmptyState title="Wybierz plik" text="Podgląd tekstu, kodu, PDF i DOCX." /> : (
          <>
            <div className="preview-head">
              <span className="mono ellipsis">{selected}</span>
              <button className="btn btn-ghost btn-xs" onClick={() => void api.openInSystem(project.path, "default", selected).catch((e) => notify(String(e), "bad"))}>Otwórz w aplikacji</button>
            </div>
            {loading ? <div className="pad"><Loader2 size={14} className="spin" /></div> : <pre className="preview-body">{content}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

function ChangesTab({ project }: { project: Project }) {
  const { snapshot, go } = useApp();
  const { undo, undoAll } = useUndo();
  const [openId, setOpenId] = useState<string | null>(null);
  const convs = snapshot.conversations.filter((c) => c.projectId === project.id && c.changes.length > 0);
  if (convs.length === 0) return <EmptyState icon={<History size={18} />} title="Brak zmian" text="Każdy plik zapisany przez agenta pojawi się tutaj z podglądem i możliwością cofnięcia." />;
  return (
    <div className="tab-body">
      {convs.map((c) => {
        const live = c.changes.filter((x) => !x.undone);
        return (
          <section key={c.id} className="change-group">
            <div className="section-head">
              <button className="link h3" onClick={() => go({ screen: "conversation", conversationId: c.id })}>{c.title}</button>
              <span className="muted small">{relativeTime(c.updatedAt)}</span>
              {live.length > 0 && <button className="btn btn-ghost btn-xs" onClick={() => void undoAll(live)}><RotateCcw size={12} /> Cofnij wszystkie ({live.length})</button>}
            </div>
            <div className="list">
              {[...c.changes].reverse().map((ch) => (
                <div key={ch.id} className={`change-row ${ch.undone ? "undone" : ""}`}>
                  <button className="change-row-main" onClick={() => setOpenId(openId === ch.id ? null : ch.id)}>
                    {ch.kind === "created" ? <FilePlus size={13} /> : <FileEdit size={13} />}
                    <span className="mono ellipsis">{ch.path}</span>
                    <small className="adds">+{ch.added}</small><small className="dels">−{ch.removed}</small>
                    <small className="muted">{relativeTime(ch.at)}</small>
                  </button>
                  {ch.undone ? <small className="muted">cofnięto</small> : <button className="btn btn-ghost btn-xs" onClick={() => void undo(ch)}><Undo2 size={12} /> Cofnij</button>}
                  {openId === ch.id && <div className="change-diff"><DiffView lines={ch.preview} /></div>}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function SettingsTab({ project }: { project: Project }) {
  const { mutate, go, notify, confirmDialog, usableProviders, snapshot } = useApp();
  const [memoryText, setMemoryText] = useState("");
  const update = (patch: Partial<Project>) => mutate((s) => ({ ...s, projects: s.projects.map((p) => (p.id === project.id ? { ...p, ...patch } : p)) }));
  const remove = async () => {
    if (!(await confirmDialog(`Usunąć „${project.name}” z listy AgentOS? Pliki na dysku pozostaną bez zmian. Rozmowy tego projektu zostaną usunięte z AgentOS.`, "Usuń projekt z listy"))) return;
    mutate((s) => ({ ...s, projects: s.projects.filter((p) => p.id !== project.id), conversations: s.conversations.filter((c) => c.projectId !== project.id) }));
    notify("Projekt usunięto z listy. Pliki na dysku są nietknięte.");
    go({ screen: "home" });
  };
  return (
    <div className="tab-body settings-stack">
      <section className="panel">
        <h3>Co agent może robić w tym projekcie</h3>
        <div className="segmented">
          {(Object.keys(accessModeLabel) as AccessMode[]).map((mode) => (
            <button key={mode} className={project.accessMode === mode ? "on" : ""} onClick={() => update({ accessMode: mode })}>
              <strong>{accessModeLabel[mode].short}</strong><span>{accessModeLabel[mode].long}</span>
            </button>
          ))}
        </div>
        <p className="muted small">Agent nigdy nie usuwa plików, nie wychodzi poza ten folder i nie pisze do .git. Polecenia terminala zawsze wymagają Twojej zgody.</p>
      </section>
      <section className="panel">
        <h3>Domyślny model projektu</h3>
        {usableProviders.length === 0
          ? <p className="muted small">Brak gotowych modeli. <button className="link" onClick={() => go({ screen: "models" })}>Podłącz model</button></p>
          : <ModelPicker providerId={project.providerId ?? snapshot.defaultProviderId} model={usableProviders.find((p) => p.id === project.providerId)?.model ?? ""} onChange={(providerId) => update({ providerId })} />}
      </section>
      <section className="panel">
        <h3>Instrukcje dla agenta</h3>
        <p className="muted small">Stałe zasady tego projektu: styl, język, czego nie ruszać, jak sprawdzać wynik. Pliki AGENTS.md, CLAUDE.md i PROJECT_CONTEXT.md z folderu są dołączane automatycznie{project.contextFiles?.length ? ` (znalezione: ${project.contextFiles.join(", ")})` : ""}.</p>
        <textarea className="text-area" rows={7} value={project.instructions} onChange={(e) => update({ instructions: e.target.value })} placeholder="Np. Pisz po polsku. Nie zmieniaj plików w folderze /legacy. Po każdej zmianie uruchom npm test." />
      </section>
      <section className="panel">
        <h3><Brain size={15} /> Pamięć projektu</h3>
        <p className="muted small">Fakty i decyzje, które agent ma pamiętać w każdej rozmowie tego projektu.</p>
        <div className="memory">
          {project.memory.map((m) => (
            <div key={m.id} className="memory-row">
              <span>{m.text}</span>
              <button className="icon-btn" title="Usuń z pamięci" onClick={() => update({ memory: project.memory.filter((x) => x.id !== m.id) })}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
        <div className="row">
          <input className="input grow" value={memoryText} onChange={(e) => setMemoryText(e.target.value)} placeholder="Np. Klient akceptuje tylko pliki PDF." onKeyDown={(e) => {
            if (e.key === "Enter" && memoryText.trim()) { update({ memory: [...project.memory, { id: uid("mem"), text: memoryText.trim(), createdAt: nowIso(), source: "wpis użytkownika" }] }); setMemoryText(""); }
          }} />
          <button className="btn" disabled={!memoryText.trim()} onClick={() => { update({ memory: [...project.memory, { id: uid("mem"), text: memoryText.trim(), createdAt: nowIso(), source: "wpis użytkownika" }] }); setMemoryText(""); }}><Plus size={14} /> Dodaj</button>
        </div>
      </section>
      <section className="panel">
        <h3>Nazwa i lista</h3>
        <div className="row">
          <input className="input grow" value={project.name} onChange={(e) => update({ name: e.target.value })} />
          <button className="btn btn-danger" onClick={() => void remove()}><Trash2 size={14} /> Usuń z listy</button>
        </div>
      </section>
    </div>
  );
}
