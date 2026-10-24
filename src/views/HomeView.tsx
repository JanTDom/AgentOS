import { useState } from "react";
import { AppWindow, ArrowRight, FileSearch, FolderOpen, FolderPlus, Hammer, HardDrive, KeyRound, MessageSquare } from "lucide-react";
import { useApp, relativeTime } from "../context";
import { Composer, EmptyState, Modal, ModelPicker, StatusDot, StatusPill } from "../components";
import { isLocal, type Conversation } from "../types";

export function HomeView() {
  const { snapshot, go, usableProviders, defaultProvider, startConversation, addExistingProject, createNewProject, runner } = useApp();
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState<string | null>(snapshot.projects[0]?.id ?? null);
  const [choice, setChoice] = useState<{ providerId: string; model: string } | null>(null);
  const [buildOpen, setBuildOpen] = useState(false);
  const providerId = choice?.providerId ?? snapshot.projects.find((p) => p.id === projectId)?.providerId ?? defaultProvider?.id ?? "";
  const model = choice?.model ?? usableProviders.find((p) => p.id === providerId)?.model ?? "";

  const send = () => {
    if (!text.trim()) return;
    if (startConversation({ projectId, text: text.trim(), providerId, model })) setText("");
  };

  const pickFolder = async (prefill: string) => {
    const project = await addExistingProject();
    if (!project) return;
    setProjectId(project.id);
    setText(prefill);
    window.setTimeout(() => document.getElementById("home-composer")?.focus(), 30);
  };

  const waiting = snapshot.conversations.filter((c) => c.status === "waiting");
  const running = snapshot.conversations.filter((c) => runner.isActive(c.id) && c.status !== "waiting");
  const recent = snapshot.conversations.filter((c) => !waiting.includes(c) && !running.includes(c)).slice(0, 6);
  const noModel = usableProviders.length === 0;

  return (
    <div className="page home">
      <header className="home-head">
        <h1>Co chcesz zrobić?</h1>
        <p>Opisz cel zwykłym językiem. AgentOS przejrzy projekt, zaproponuje plan i pokaże każdą zmianę, zanim ją zapisze.</p>
      </header>

      {noModel && snapshot.providers.some((p) => (isLocal(p) ? p.status === "ok" : p.hasKey)) && (
        <div className="callout">
          <div>
            <strong>Wybierz model</strong>
            <span>Połączenie działa ({snapshot.providers.filter((p) => (isLocal(p) ? p.status === "ok" : p.hasKey)).map((p) => p.name).join(", ")}), ale nie wybrano modelu. Otwórz Modele i kliknij „Lista modeli”.</span>
          </div>
          <div className="row"><button className="btn btn-primary" onClick={() => go({ screen: "models" })}>Wybierz model</button></div>
        </div>
      )}
      {noModel && !snapshot.providers.some((p) => (isLocal(p) ? p.status === "ok" : p.hasKey)) && (
        <div className="callout">
          <div>
            <strong>Najpierw połącz AgentOS z modelem AI</strong>
            <span>Wystarczy jeden: lokalny (Ollama lub LM Studio — działa bez internetu, dane zostają na Macu) albo w chmurze z kluczem API.</span>
          </div>
          <div className="row">
            <button className="btn" onClick={() => go({ screen: "models" })}><HardDrive size={14} /> Model lokalny</button>
            <button className="btn btn-primary" onClick={() => go({ screen: "models" })}><KeyRound size={14} /> Dodaj klucz API</button>
          </div>
        </div>
      )}

      <Composer id="home-composer" autoFocus value={text} onChange={setText} onSend={send}
        placeholder={projectId ? "Np. „Dodaj eksport do CSV”, „Znajdź błąd w logowaniu”, „Streść dokumenty z folderu umowy”…" : "Zadaj pytanie albo wybierz projekt, aby agent mógł pracować na plikach…"}>
        <label className="chip chip-select" title="Projekt, w którym agent będzie pracował">
          <FolderOpen size={13} />
          <select value={projectId ?? ""} onChange={(e) => {
            if (e.target.value === "__add") { void pickFolder(text); return; }
            setProjectId(e.target.value || null);
          }}>
            <option value="">Bez projektu (sama rozmowa)</option>
            {snapshot.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="__add">+ Dodaj folder…</option>
          </select>
        </label>
        {!noModel && <ModelPicker providerId={providerId} model={model} onChange={(p, m) => setChoice({ providerId: p, model: m })} />}
      </Composer>

      <section className="starters">
        <button className="starter" onClick={() => setBuildOpen(true)}>
          <span className="starter-icon"><Hammer size={18} /></span>
          <strong>Zbuduj aplikację</strong>
          <span>Nowy folder, plan, pierwsza działająca wersja</span>
        </button>
        <button className="starter" onClick={() => void pickFolder("Przeczytaj dokumenty w tym folderze. Przygotuj streszczenie najważniejszych informacji, wskaż sprzeczności i podaj, z którego pliku pochodzi każda informacja.")}>
          <span className="starter-icon"><FileSearch size={18} /></span>
          <strong>Przeanalizuj dokumenty</strong>
          <span>PDF, DOCX, CSV, tekst — streszczenie ze źródłami</span>
        </button>
        <button className="starter" onClick={() => void pickFolder("Przejrzyj ten projekt. Wyjaśnij, co robi, jak jest zbudowany i co warto poprawić najpierw. Niczego jeszcze nie zmieniaj.")}>
          <span className="starter-icon"><AppWindow size={18} /></span>
          <strong>Popraw istniejący projekt</strong>
          <span>Wskaż folder — agent najpierw go pozna</span>
        </button>
      </section>

      {waiting.length > 0 && <ConvSection title="Czeka na Twoją decyzję" items={waiting} accent />}
      {running.length > 0 && <ConvSection title="W toku" items={running} />}

      <div className="home-grid">
        <section>
          <div className="section-head"><h2>Ostatnie rozmowy</h2></div>
          {recent.length === 0
            ? <EmptyState icon={<MessageSquare size={18} />} title="Jeszcze nic tu nie ma" text="Pierwsze zadanie pojawi się tutaj razem ze stanem pracy." />
            : <ConvList items={recent} />}
        </section>
        <section>
          <div className="section-head">
            <h2>Projekty</h2>
            <button className="btn btn-ghost" onClick={() => void addExistingProject()}><FolderPlus size={14} /> Dodaj folder</button>
          </div>
          {snapshot.projects.length === 0
            ? <EmptyState icon={<FolderOpen size={18} />} title="Brak projektów" text="Projekt to zwykły folder na Macu. Agent pracuje tylko w folderach, które tu dodasz." />
            : (
              <div className="project-tiles">
                {snapshot.projects.slice(0, 8).map((p) => {
                  const count = snapshot.conversations.filter((c) => c.projectId === p.id).length;
                  return (
                    <button key={p.id} className="tile" onClick={() => go({ screen: "project", projectId: p.id, tab: "chats" })}>
                      <strong className="ellipsis">{p.name}</strong>
                      <span className="ellipsis mono">{p.path.replace(/^\/Users\/[^/]+/, "~")}</span>
                      <small>{count ? `${count} rozmów` : "bez rozmów"}</small>
                    </button>
                  );
                })}
              </div>
            )}
        </section>
      </div>

      {buildOpen && <BuildModal onClose={() => setBuildOpen(false)} onCreate={async (name, goal) => {
        const project = await createNewProject(name);
        if (!project) return;
        setBuildOpen(false);
        startConversation({ projectId: project.id, text: `Zbuduj aplikację: ${goal}\n\nNajpierw doprecyzuj cel i zakres, potem przedstaw plan. Po zatwierdzeniu zbuduj pierwszą działającą wersję i sprawdź ją.`, providerId, model });
      }} />}
    </div>
  );
}

function ConvSection({ title, items, accent }: { title: string; items: Conversation[]; accent?: boolean }) {
  return (
    <section className={accent ? "accent-section" : ""}>
      <div className="section-head"><h2>{title}</h2></div>
      <ConvList items={items} />
    </section>
  );
}

function ConvList({ items }: { items: Conversation[] }) {
  const { snapshot, go, runner } = useApp();
  return (
    <div className="list">
      {items.map((c) => (
        <button key={c.id} className="list-row" onClick={() => go({ screen: "conversation", conversationId: c.id })}>
          <StatusDot status={c.status} />
          <span className="list-main">
            <strong className="ellipsis">{c.title}</strong>
            <small>{snapshot.projects.find((p) => p.id === c.projectId)?.name ?? "Bez projektu"} · {relativeTime(c.updatedAt)}</small>
          </span>
          <StatusPill status={c.status} stopping={runner.isStopping(c.id)} />
          <ArrowRight size={14} className="muted" />
        </button>
      ))}
    </div>
  );
}

function BuildModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, goal: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Zbuduj nową aplikację" onClose={onClose}>
      <label className="field">Co ma robić aplikacja?
        <textarea autoFocus rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Np. aplikacja do analizy portali medialnych: zbiera nagłówki z podanych adresów i pokazuje, o czym piszą najczęściej." />
      </label>
      <label className="field">Nazwa folderu projektu
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="np. analiza-portali" />
      </label>
      <p className="muted small">Za chwilę wybierzesz, gdzie utworzyć folder. Agent najpierw przedstawi plan — nic nie zapisze bez Twojej zgody.</p>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Anuluj</button>
        <button className="btn btn-primary" disabled={!name.trim() || !goal.trim() || busy} onClick={async () => { setBusy(true); await onCreate(name.trim(), goal.trim()); setBusy(false); }}>
          Wybierz miejsce i zacznij
        </button>
      </div>
    </Modal>
  );
}
