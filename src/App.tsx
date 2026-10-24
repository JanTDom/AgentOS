import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { Cable, Cpu, FolderPlus, Home, Loader2, Plus, Puzzle, Search, Settings, X } from "lucide-react";
import { AgentRunner } from "./agent";
import { api, inDesktopApp } from "./api";
import { AppContext, isUsable, useApp, type AppApi, type Tone } from "./context";
import { loadSnapshot, nowIso, saveSnapshotSoon, uid } from "./store";
import { emptySnapshot, isLocal, type Conversation, type Project, type Route, type Snapshot } from "./types";
import { StatusDot } from "./components";
import { HomeView } from "./views/HomeView";
import { ProjectView } from "./views/ProjectView";
import { ConversationView } from "./views/ConversationView";
import { ModelsView } from "./views/ModelsView";
import { SettingsView } from "./views/SettingsView";
import { SkillsView } from "./views/SkillsView";
import { IntegrationsView } from "./views/IntegrationsView";

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [loaded, setLoaded] = useState(false);
  const [route, setRoute] = useState<Route>({ screen: "home" });
  const [toast, setToast] = useState<{ text: string; tone: Tone } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [, setTick] = useState(0);
  const stateRef = useRef<Snapshot>(emptySnapshot);

  const mutate = useCallback((fn: (s: Snapshot) => Snapshot) => {
    const next = fn(stateRef.current);
    stateRef.current = next;
    setSnapshot(next);
    saveSnapshotSoon(next);
  }, []);

  const runner = useMemo(
    () =>
      new AgentRunner(
        {
          conversation: (id) => stateRef.current.conversations.find((c) => c.id === id),
          project: (id) => (id ? stateRef.current.projects.find((p) => p.id === id) ?? null : null),
          provider: (id) => stateRef.current.providers.find((p) => p.id === id),
          update: (id, fn) => mutate((s) => ({ ...s, conversations: s.conversations.map((c) => (c.id === id ? fn(c) : c)) })),
          settings: () => ({ skillSources: stateRef.current.skillSources, disabledSkills: stateRef.current.disabledSkills, mcpServers: stateRef.current.mcpServers, accounts: stateRef.current.accounts }),
          saveProject: (id, patch) => mutate((s) => ({ ...s, projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
        },
        () => setTick((t) => t + 1),
      ),
    [mutate],
  );

  const notify = useCallback((text: string, tone: Tone = "good") => {
    setToast({ text, tone });
    window.setTimeout(() => setToast((current) => (current?.text === text ? null : current)), tone === "bad" ? 9000 : 4500);
  }, []);

  const refreshLocalModels = useCallback(async () => {
    const locals = stateRef.current.providers.filter(isLocal);
    await Promise.all(
      locals.map(async (provider) => {
        try {
          const models = await api.listModels(provider);
          mutate((s) => ({
            ...s,
            providers: s.providers.map((p) => p.id === provider.id
              ? { ...p, models, status: "ok", statusText: models.length ? `${models.length} modeli` : "działa, brak pobranych modeli", model: p.model && models.includes(p.model) ? p.model : models[0] ?? "" }
              : p),
          }));
        } catch {
          mutate((s) => ({ ...s, providers: s.providers.map((p) => (p.id === provider.id ? { ...p, status: "offline", statusText: "nie uruchomiono" } : p)) }));
        }
      }),
    );
  }, [mutate]);

  useEffect(() => {
    void (async () => {
      const initial = await loadSnapshot();
      stateRef.current = initial;
      setSnapshot(initial);
      setLoaded(true);
      if (!inDesktopApp) return;
      try {
        const statuses = await api.keyStatuses(initial.providers.filter((p) => !isLocal(p)).map((p) => p.id));
        const byId = new Map(statuses.map((s) => [s.providerId, s.hasKey]));
        mutate((s) => ({ ...s, providers: s.providers.map((p) => (byId.has(p.id) ? { ...p, hasKey: byId.get(p.id)! } : p)) }));
        for (const provider of stateRef.current.providers.filter((p) => !isLocal(p) && p.hasKey && !p.model)) {
          void api.listModels(provider).then((models) => mutate((s) => ({
            ...s,
            providers: s.providers.map((p) => (p.id === provider.id ? { ...p, models, model: p.model || models[0] || "" } : p)),
          }))).catch(() => undefined);
        }
      } catch { /* Keychain niedostępny — pokażemy brak klucza */ }
      await refreshLocalModels();
    })();
  }, [mutate, refreshLocalModels]);

  // Motyw: system / jasny / ciemny.
  useEffect(() => {
    document.documentElement.dataset.theme = snapshot.theme;
  }, [snapshot.theme]);

  const usableProviders = snapshot.providers.filter(isUsable);
  const defaultProvider = usableProviders.find((p) => p.id === snapshot.defaultProviderId) ?? usableProviders[0];

  const startConversation: AppApi["startConversation"] = ({ projectId, text, providerId, model }) => {
    const project = projectId ? stateRef.current.projects.find((p) => p.id === projectId) : undefined;
    const provider = usableProviders.find((p) => p.id === (providerId ?? project?.providerId)) ?? defaultProvider;
    if (!provider) {
      notify("Najpierw podłącz model — lokalny albo z kluczem API.", "warn");
      setRoute({ screen: "models" });
      return null;
    }
    const conversation: Conversation = {
      id: uid("conv"),
      projectId: project?.id ?? null,
      title: text.replace(/\s+/g, " ").trim().slice(0, 80) || "Nowa rozmowa",
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      providerId: provider.id,
      model: model ?? provider.model,
      items: [],
      api: [],
      changes: [],
      usage: { input: 0, output: 0 },
    };
    mutate((s) => ({ ...s, conversations: [conversation, ...s.conversations] }));
    setRoute({ screen: "conversation", conversationId: conversation.id });
    void runner.send(conversation.id, text);
    return conversation;
  };

  const registerProject = async (path: string, nameOverride?: string): Promise<Project | null> => {
    const existing = stateRef.current.projects.find((p) => p.path === path);
    if (existing) {
      notify(`Projekt „${existing.name}” jest już na liście.`, "warn");
      return existing;
    }
    let name = nameOverride ?? path.split("/").filter(Boolean).pop() ?? "Projekt";
    let contextFiles: string[] = [];
    try {
      const info = await api.inspectProject(path);
      name = nameOverride ?? info.name;
      contextFiles = info.contextFiles;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "bad");
      return null;
    }
    const project: Project = { id: uid("proj"), name, path, createdAt: nowIso(), instructions: "", memory: [], accessMode: stateRef.current.defaultAccessMode, contextFiles };
    mutate((s) => ({ ...s, projects: [project, ...s.projects] }));
    notify(`Dodano projekt „${project.name}”.`);
    return project;
  };

  const addExistingProject = async () => {
    if (!inDesktopApp) { notify("Wybór folderu działa w aplikacji AgentOS na Macu.", "warn"); return null; }
    const selected = await open({ directory: true, multiple: false, title: "Wybierz folder projektu" });
    if (!selected || Array.isArray(selected)) return null;
    return registerProject(selected);
  };

  const createNewProject = async (name: string) => {
    if (!inDesktopApp) { notify("Tworzenie folderu działa w aplikacji AgentOS na Macu.", "warn"); return null; }
    const parent = await open({ directory: true, multiple: false, title: `Gdzie utworzyć folder „${name}”?` });
    if (!parent || Array.isArray(parent)) return null;
    try {
      const path = await api.createProjectFolder(parent, name);
      return registerProject(path, name);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "bad");
      return null;
    }
  };

  const confirmDialog = async (text: string, title = "AgentOS") => {
    if (inDesktopApp) return ask(text, { title, kind: "warning", okLabel: "Tak", cancelLabel: "Anuluj" });
    return window.confirm(text);
  };

  // Skróty: ⌘K wyszukiwanie, ⌘N nowe zadanie, ⌘. zatrzymanie agenta.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key === "k") { event.preventDefault(); setPaletteOpen((o) => !o); }
      if (event.key === "n") { event.preventDefault(); setRoute({ screen: "home" }); window.setTimeout(() => document.getElementById("home-composer")?.focus(), 30); }
      if (event.key === "." && route.screen === "conversation") { event.preventDefault(); runner.stop(route.conversationId); }
      if (event.key === ",") { event.preventDefault(); setRoute({ screen: "settings" }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route, runner]);

  const value: AppApi = {
    snapshot, route, go: setRoute, mutate, runner, notify, usableProviders, defaultProvider,
    startConversation, addExistingProject, createNewProject, refreshLocalModels, confirmDialog,
  };

  if (!loaded) {
    return <div className="boot"><Loader2 className="spin" size={20} /> Wczytywanie AgentOS…</div>;
  }

  return (
    <AppContext.Provider value={value}>
      <div className="shell">
        <Sidebar onSearch={() => setPaletteOpen(true)} />
        <main className="main">
          {route.screen === "home" && <HomeView />}
          {route.screen === "project" && <ProjectView key={route.projectId} projectId={route.projectId} tab={route.tab} />}
          {route.screen === "conversation" && <ConversationView key={route.conversationId} conversationId={route.conversationId} />}
          {route.screen === "models" && <ModelsView />}
          {route.screen === "skills" && <SkillsView />}
          {route.screen === "integrations" && <IntegrationsView />}
          {route.screen === "settings" && <SettingsView />}
        </main>
        {toast && (
          <div className={`toast toast-${toast.tone}`} role="status">
            <span>{toast.text}</span>
            <button className="icon-btn" onClick={() => setToast(null)} aria-label="Zamknij"><X size={14} /></button>
          </div>
        )}
        {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
      </div>
    </AppContext.Provider>
  );
}

function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { snapshot, route, go, runner, addExistingProject } = useApp();
  const projectOf = (c: Conversation) => c.projectId;
  const isRoute = (screen: Route["screen"], id?: string) =>
    route.screen === screen && (!id || ("projectId" in route && route.projectId === id) || ("conversationId" in route && route.conversationId === id));
  const loose = snapshot.conversations.filter((c) => !c.projectId).slice(0, 6);
  const activeProjectId = route.screen === "project" ? route.projectId
    : route.screen === "conversation" ? snapshot.conversations.find((c) => c.id === route.conversationId)?.projectId ?? null : null;
  return (
    <aside className="sidebar">
      <div className="sidebar-top" data-tauri-drag-region>
        <div className="brand"><img src="/agentos-badge.png" alt="" /><span>AgentOS</span></div>
      </div>
      <button className="btn btn-primary new-task" onClick={() => { go({ screen: "home" }); window.setTimeout(() => document.getElementById("home-composer")?.focus(), 30); }}>
        <Plus size={16} /> Nowe zadanie <kbd>⌘N</kbd>
      </button>
      <nav className="side-nav">
        <button className={`side-link ${isRoute("home") ? "on" : ""}`} onClick={() => go({ screen: "home" })}><Home size={16} /> Start</button>
        <button className="side-link" onClick={onSearch}><Search size={16} /> Szukaj <kbd>⌘K</kbd></button>
      </nav>
      <div className="side-section">
        <div className="side-label"><span>Projekty</span><button className="icon-btn" title="Dodaj folder projektu" onClick={() => void addExistingProject().then((p) => p && go({ screen: "project", projectId: p.id, tab: "chats" }))}><FolderPlus size={14} /></button></div>
        {snapshot.projects.length === 0 && <p className="side-empty">Brak projektów. Dodaj folder na ekranie Start.</p>}
        {snapshot.projects.map((project) => {
          const convs = snapshot.conversations.filter((c) => projectOf(c) === project.id);
          const busy = convs.some((c) => runner.isActive(c.id));
          const waiting = convs.some((c) => c.status === "waiting");
          const open = activeProjectId === project.id;
          return (
            <div key={project.id} className="side-project">
              <button className={`side-link ${isRoute("project", project.id) ? "on" : ""}`} onClick={() => go({ screen: "project", projectId: project.id, tab: "chats" })}>
                <span className="folder-glyph" aria-hidden>▸</span>
                <span className="ellipsis">{project.name}</span>
                {waiting ? <StatusDot status="waiting" /> : busy ? <StatusDot status="running" /> : null}
              </button>
              {open && convs.slice(0, 6).map((c) => (
                <button key={c.id} className={`side-sub ${isRoute("conversation", c.id) ? "on" : ""}`} onClick={() => go({ screen: "conversation", conversationId: c.id })}>
                  <StatusDot status={runner.isActive(c.id) && c.status !== "waiting" ? "running" : c.status} />
                  <span className="ellipsis">{c.title}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      {loose.length > 0 && (
        <div className="side-section">
          <div className="side-label"><span>Rozmowy bez projektu</span></div>
          {loose.map((c) => (
            <button key={c.id} className={`side-sub flush ${isRoute("conversation", c.id) ? "on" : ""}`} onClick={() => go({ screen: "conversation", conversationId: c.id })}>
              <StatusDot status={c.status} /><span className="ellipsis">{c.title}</span>
            </button>
          ))}
        </div>
      )}
      <div className="side-bottom">
        <button className={`side-link ${isRoute("skills") ? "on" : ""}`} onClick={() => go({ screen: "skills" })}><Puzzle size={16} /> Umiejętności</button>
        <button className={`side-link ${isRoute("integrations") ? "on" : ""}`} onClick={() => go({ screen: "integrations" })}><Cable size={16} /> Integracje</button>
        <button className={`side-link ${isRoute("models") ? "on" : ""}`} onClick={() => go({ screen: "models" })}><Cpu size={16} /> Modele</button>
        <button className={`side-link ${isRoute("settings") ? "on" : ""}`} onClick={() => go({ screen: "settings" })}><Settings size={16} /> Ustawienia</button>
      </div>
    </aside>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const { snapshot, go } = useApp();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const q = query.toLowerCase().trim();
  const entries = [
    ...snapshot.projects.map((p) => ({ id: p.id, label: p.name, hint: "Projekt", run: () => go({ screen: "project", projectId: p.id, tab: "chats" }) })),
    ...snapshot.conversations.map((c) => ({ id: c.id, label: c.title, hint: snapshot.projects.find((p) => p.id === c.projectId)?.name ?? "Rozmowa", run: () => go({ screen: "conversation", conversationId: c.id }) })),
    { id: "go-models", label: "Modele", hint: "Ekran", run: () => go({ screen: "models" }) },
    { id: "go-skills", label: "Umiejętności", hint: "Ekran", run: () => go({ screen: "skills" }) },
    { id: "go-integrations", label: "Integracje (GitHub, Vercel, Supabase, MCP)", hint: "Ekran", run: () => go({ screen: "integrations" }) },
    { id: "go-settings", label: "Ustawienia", hint: "Ekran", run: () => go({ screen: "settings" }) },
  ].filter((e) => !q || e.label.toLowerCase().includes(q) || e.hint.toLowerCase().includes(q)).slice(0, 12);
  const choose = (i: number) => { entries[i]?.run(); onClose(); };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input"><Search size={16} />
          <input autoFocus value={query} placeholder="Szukaj projektów, rozmów i ekranów…" onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, entries.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
              if (e.key === "Enter") choose(index);
            }} />
        </div>
        <div className="palette-list">
          {entries.length === 0 && <p className="muted pad">Nic nie znaleziono.</p>}
          {entries.map((entry, i) => (
            <button key={entry.id} className={`palette-item ${i === index ? "on" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => choose(i)}>
              <span className="ellipsis">{entry.label}</span><small>{entry.hint}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

