import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronRight, CircleX, ExternalLink, FileEdit, FilePlus, FileText, FolderTree, Loader2, Puzzle, GitBranch, UploadCloud, Rocket, Database, RotateCcw, Search, Terminal, Undo2, X, Trash2 } from "lucide-react";
import { useApp } from "../context";
import { Composer, DiffView, ModelPicker, StatusPill } from "../components";
import { Markdown } from "../Markdown";
import { accessModeLabel, isLocal, type Change, type Conversation, type ConversationItem } from "../types";
import { useUndo } from "./useUndo";
import { api } from "../api";
import { trashChat } from "../chatTrash";
import { flushSnapshot } from "../store";

export function ConversationView({ conversationId }: { conversationId: string }) {
  const { snapshot, go, runner, mutate, notify, confirmDialog } = useApp();
  const conversation = snapshot.conversations.find((c) => c.id === conversationId);
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { undoAll } = useUndo();

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [conversation?.items.length, conversation?.items[conversation.items.length - 1]]);

  if (!conversation) {
    return <div className="page"><p className="muted">Ta rozmowa nie istnieje.</p><button className="btn" onClick={() => go({ screen: "home" })}>Wróć na Start</button></div>;
  }
  const project = snapshot.projects.find((p) => p.id === conversation.projectId) ?? null;
  const provider = snapshot.providers.find((p) => p.id === conversation.providerId);
  const active = runner.isActive(conversation.id);
  const pendingId = conversation.items.find((i) => (i.kind === "approval" && i.status === "pending") || (i.kind === "plan" && i.decision === "pending"))?.id;
  const waiting = active && conversation.status === "waiting" && pendingId;
  const lastAction = [...conversation.items].reverse().find((i) => i.kind === "action" && i.status === "running");

  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    stick.current = true;
    if (waiting && pendingId) runner.decide(pendingId, { approved: false, feedback: value });
    else void runner.send(conversation.id, value);
  };

  const changes = conversation.changes;
  const liveChanges = changes.filter((c) => !c.undone);

  return (
    <div className="conv">
      <header className="conv-head">
        <div className="conv-title">
          <div className="crumbs">
            {project
              ? <button className="link" onClick={() => go({ screen: "project", projectId: project.id, tab: "chats" })}>{project.name}</button>
              : <span>Bez projektu</span>}
            <ChevronRight size={12} />
            <span>Rozmowa</span>
          </div>
          <h1 className="ellipsis">{conversation.title}</h1>
        </div>
        <div className="conv-meta">
          {project && (snapshot.approveAll && project.accessMode !== "read"
            ? <span className="chip chip-static" title="Ustawienia → Zgoda na wszystko: agent nie czeka na zatwierdzenie.">Zgoda na wszystko</span>
            : <span className="chip chip-static" title={accessModeLabel[project.accessMode].long}>{accessModeLabel[project.accessMode].short}</span>)}
          <ModelPicker compact providerId={conversation.providerId} model={conversation.model}
            onChange={(providerId, model) => void (async () => {
              const previous = snapshot.providers.find(p => p.id === conversation.providerId);
              const next = snapshot.providers.find(p => p.id === providerId);
              if (previous && next && isLocal(previous) && !isLocal(next) && conversation.api.length && !await confirmDialog(`Przełączyć na ${next.name}? Wcześniejsza historia rozmowy, wyniki narzędzi i odczytane fragmenty plików zostaną wysłane do tego dostawcy.`, 'Dane opuszczą Maca')) return;
              mutate(s => ({ ...s, conversations: s.conversations.map(c => c.id === conversation.id ? { ...c, providerId, model, toolsUnsupported: false } : c) }));
            })()} />
          <button className="icon-btn" disabled={active} title={active ? "Najpierw zatrzymaj rozmowę" : "Przenieś czat do kosza"} aria-label="Usuń czat" onClick={() => void (async () => {
            if (!await confirmDialog('Przenieść ten czat do kosza? Pliki projektu i wykonane operacje pozostaną bez zmian.', 'Usuń czat')) return;
            try { mutate(s => trashChat(s, conversation.id, runner.isActive(conversation.id))); await flushSnapshot(); go({ screen: 'home' }); notify('Rozmowa przeniesiona do kosza.'); } catch (e) { notify(String(e), 'bad'); }
          })()}><Trash2 size={14} /></button>
          <StatusPill status={conversation.status} stopping={runner.isStopping(conversation.id)} />
        </div>
      </header>

      <div className="conv-body">
        <div className="stream" ref={scrollRef} onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}>
          <div className="stream-inner">
            {conversation.items.map((item) => <Item key={item.id} item={item} conversation={conversation} />)}
            {active && conversation.status === "running" && (
              <div className="working">
                <Loader2 size={14} className="spin" />
                {runner.isStopping(conversation.id) ? "Zatrzymuję po bieżącym kroku…" : lastAction && lastAction.kind === "action" ? lastAction.title : "AgentOS myśli…"}
              </div>
            )}
          </div>
        </div>
        <SidePanel conversation={conversation} changes={changes} onUndoAll={() => void undoAll(liveChanges)} />
      </div>

      <div className="conv-composer">
        <Composer value={text} onChange={setText} onSend={send} busy={active && !waiting} onStop={() => runner.stop(conversation.id)}
          disabled={active && !waiting}
          placeholder={waiting ? "Napisz uwagi — agent uwzględni je zamiast tej propozycji…" : active ? "Agent pracuje. Możesz go zatrzymać." : conversation.status === "stopped" || conversation.status === "failed" ? "Napisz „kontynuuj” albo nowe polecenie…" : "Napisz kolejne polecenie lub pytanie…"}
          hint={provider ? (isLocal(provider) ? "Model lokalny — dane zostają na tym Macu" : `Treść trafia do: ${provider.name}`) : undefined} />
      </div>
    </div>
  );
}

function SidePanel({ conversation, changes, onUndoAll }: { conversation: Conversation; changes: Change[]; onUndoAll: () => void }) {
  const { undo } = useUndo();
  const plan = [...conversation.items].reverse().find((i) => i.kind === "plan");
  const done = plan && plan.kind === "plan" ? plan.steps.filter((s) => s.status === "done").length : 0;
  const live = changes.filter((c) => !c.undone);
  if (!plan && changes.length === 0) {
    return (
      <aside className="conv-side">
        <div className="side-card">
          <strong>Jak to działa</strong>
          <ol className="howto">
            <li>Opisz cel.</li>
            <li>Agent przegląda pliki i proponuje plan.</li>
            <li>Zatwierdzasz plan i każdą zmianę.</li>
            <li>Każdą zmianę możesz cofnąć.</li>
          </ol>
        </div>
        <Usage conversation={conversation} />
      </aside>
    );
  }
  return (
    <aside className="conv-side">
      {plan && plan.kind === "plan" && (
        <div className="side-card">
          <div className="side-card-head"><strong>Plan</strong><small>{done}/{plan.steps.length}</small></div>
          <div className="progress"><span style={{ width: `${plan.steps.length ? (done / plan.steps.length) * 100 : 0}%` }} /></div>
          <ol className="steps">
            {plan.steps.map((s, i) => <li key={i} className={`step-${s.status}`}>{s.status === "done" ? <Check size={13} /> : s.status === "doing" ? <Loader2 size={13} className="spin" /> : <span className="step-num">{i + 1}</span>}<span>{s.title}</span></li>)}
          </ol>
        </div>
      )}
      {changes.length > 0 && (
        <div className="side-card">
          <div className="side-card-head"><strong>Zmienione pliki</strong><small>{live.length}</small></div>
          <div className="file-changes">
            {changes.map((c) => (
              <div key={c.id} className={`file-change ${c.undone ? "undone" : ""}`}>
                {c.kind === "created" ? <FilePlus size={13} /> : <FileEdit size={13} />}
                <span className="ellipsis mono" title={c.path}>{c.path}</span>
                <small className="adds">+{c.added}</small><small className="dels">−{c.removed}</small>
                {c.undone ? <small className="muted">cofnięto</small> : <button className="icon-btn" title="Cofnij tę zmianę" onClick={() => void undo(c)}><Undo2 size={13} /></button>}
              </div>
            ))}
          </div>
          {live.length > 1 && <button className="btn btn-ghost wide" onClick={onUndoAll}><RotateCcw size={13} /> Cofnij wszystkie</button>}
        </div>
      )}
      <Usage conversation={conversation} />
    </aside>
  );
}

function Usage({ conversation }: { conversation: Conversation }) {
  if (!conversation.usage.input && !conversation.usage.output) return null;
  return (
    <div className="side-note">
      Zużycie: {conversation.usage.input.toLocaleString("pl-PL")} tokenów wejścia · {conversation.usage.output.toLocaleString("pl-PL")} wyjścia
    </div>
  );
}

const approveLabel: Record<string, string> = {
  write_file: "Zapisz zmianę", run_command: "Uruchom", install_skill: "Zainstaluj", git_commit: "Zatwierdź zmiany", git_push: "Wypchnij",
  github_pr: "Utwórz pull request", vercel_deploy: "Wdróż", supabase_sql: "Wykonaj w bazie", mcp: "Użyj narzędzia",
};

const toolIcon: Record<string, typeof FileText> = { list_files: FolderTree, read_file: FileText, search_files: Search, run_command: Terminal, use_skill: Puzzle, read_skill_file: Puzzle, find_skills: Search, install_skill: Puzzle, git_status: GitBranch, git_commit: GitBranch, git_branch: GitBranch, git_push: UploadCloud, github_create_pr: GitBranch, vercel_deploy: Rocket, vercel_logs: Rocket, supabase_schema: Database, supabase_sql: Database };

function Item({ item, conversation }: { item: ConversationItem; conversation: Conversation }) {
  const { runner, snapshot, notify } = useApp();
  const { undo, undoAll } = useUndo();
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const waitingHere = runner.isActive(conversation.id);

  switch (item.kind) {
    case "user":
      return <div className="msg msg-user"><div className="msg-label">Ty</div><div className="msg-body">{item.text}</div></div>;
    case "assistant":
      return <div className="msg msg-agent"><div className="msg-label">AgentOS</div><Markdown text={item.text} /></div>;
    case "notice":
      return <div className="notice-line">{item.text}</div>;
    case "action": {
      const Icon = toolIcon[item.tool] ?? FileText;
      return (
        <div className={`action action-${item.status}`}>
          <button className="action-row" onClick={() => setExpanded((e) => !e)} disabled={!item.output}>
            <Icon size={13} />
            <span className="ellipsis">{item.title}</span>
            {item.status === "running" ? <Loader2 size={13} className="spin" /> : item.status === "done" ? <Check size={13} className="ok" /> : <CircleX size={13} className="bad" />}
            {item.output && <ChevronRight size={12} className={`chev ${expanded ? "open" : ""}`} />}
          </button>
          {expanded && item.output && <pre className="action-output">{item.output}</pre>}
        </div>
      );
    }
    case "plan": {
      const pending = item.decision === "pending" && waitingHere;
      return (
        <div className={`card card-plan ${pending ? "card-attention" : ""}`}>
          <div className="card-kicker">{item.decision === "pending" ? "Proponowany plan · czeka na decyzję" : item.decision === "approved" ? "Plan zatwierdzony" : "Plan do poprawy"}</div>
          <strong className="card-title">{item.goal}</strong>
          <ol className="plan-steps">{item.steps.map((s, i) => <li key={i} className={`step-${s.status}`}>{s.title}</li>)}</ol>
          {pending && (
            <>
              {showFeedback && <textarea className="inline-input" rows={2} autoFocus value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Co zmienić w planie?" />}
              <div className="card-actions">
                <button className="btn btn-primary" onClick={() => runner.decide(item.id, { approved: true })}><Check size={14} /> Zatwierdź i wykonaj</button>
                {showFeedback
                  ? <button className="btn" disabled={!feedback.trim()} onClick={() => runner.decide(item.id, { approved: false, feedback: feedback.trim() })}>Wyślij uwagi</button>
                  : <button className="btn btn-ghost" onClick={() => setShowFeedback(true)}>Zmień plan</button>}
              </div>
            </>
          )}
        </div>
      );
    }
    case "approval": {
      const pending = item.status === "pending" && waitingHere;
      const long = (item.diff?.length ?? 0) > 24;
      return (
        <div className={`card card-approval ${pending ? "card-attention" : ""} ${item.danger && pending ? "card-danger" : ""}`}>
          {item.danger && pending && <div className="danger-note"><AlertTriangle size={13} /> Operacja publiczna albo trudna do cofnięcia — sprawdź szczegóły.</div>}
          <div className="card-kicker">{item.status === "pending" ? (pending ? "Wymaga Twojej zgody" : "Przerwano") : item.status === "approved" ? "Zatwierdzono" : "Odrzucono"}</div>
          <strong className="card-title">{item.title}</strong>
          {item.tool === "run_command"
            ? <pre className="command">{item.detail}</pre>
            : item.tool !== "write_file" ? <div className="approval-detail">{item.detail}</div>
            : <span className="muted small">{item.detail}</span>}
          {item.diff && (
            <div className={`diff-wrap ${long && !expanded ? "clamped" : ""}`}>
              <DiffView lines={item.diff} />
              {long && <button className="link diff-more" onClick={() => setExpanded((e) => !e)}>{expanded ? "Zwiń" : "Pokaż całą zmianę"}</button>}
            </div>
          )}
          {pending && (
            <div className="card-actions">
              <button className={`btn ${item.danger ? "btn-danger-solid" : "btn-primary"}`} onClick={() => runner.decide(item.id, { approved: true })}><Check size={14} /> {approveLabel[item.tool] ?? "Zatwierdź"}</button>
              <button className="btn btn-ghost" onClick={() => runner.decide(item.id, { approved: false })}><X size={14} /> Odrzuć</button>
            </div>
          )}
        </div>
      );
    }
    case "change": {
      const change = conversation.changes.find((c) => c.id === item.changeId);
      return (
        <div className="change-line">
          {item.change === "created" ? <FilePlus size={13} /> : <FileEdit size={13} />}
          <span>{item.change === "created" ? "Utworzono" : "Zmieniono"} <span className="mono">{item.path}</span></span>
          <small className="adds">+{item.added}</small><small className="dels">−{item.removed}</small>
          {change && (change.undone ? <small className="muted">cofnięto</small> : <button className="btn btn-ghost btn-xs" onClick={() => void undo(change)}><Undo2 size={12} /> Cofnij</button>)}
        </div>
      );
    }
    case "error":
      return (
        <div className="card card-error">
          <div className="card-kicker"><AlertTriangle size={13} /> Coś poszło nie tak</div>
          <p>{item.text}</p>
          {!runner.isActive(conversation.id) && (
            <div className="card-actions">
              <button className="btn" onClick={() => void runner.send(conversation.id, "Spróbuj ponownie.")}><RotateCcw size={13} /> Spróbuj ponownie</button>
            </div>
          )}
        </div>
      );
    case "result": {
      const live = conversation.changes.filter((c) => !c.undone);
      const project = snapshot.projects.find((p) => p.id === conversation.projectId);
      const htmlEntry = live.map((c) => c.path).find((p) => /(^|\/)index\.html$/.test(p));
      return (
        <div className={`card card-result ${item.warnings.length ? "card-warn" : ""}`}>
          <div className="card-kicker">{item.warnings.length ? "Gotowe, z ostrzeżeniami" : "Gotowe"}</div>
          <Markdown text={item.text} />
          {item.warnings.length > 0 && <ul className="warnings">{item.warnings.map((w, i) => <li key={i}><AlertTriangle size={12} /> {w}</li>)}</ul>}
          {(live.length > 0 || htmlEntry) && (
            <div className="card-actions">
              {htmlEntry && project && <button className="btn" onClick={() => void api.openInSystem(project.path, "default", htmlEntry).catch((e) => notify(String(e), "bad"))}><ExternalLink size={13} /> Otwórz podgląd</button>}
              {live.length > 0 && <button className="btn btn-ghost" onClick={() => void undoAll(live)}><RotateCcw size={13} /> Cofnij zmiany ({live.length})</button>}
            </div>
          )}
        </div>
      );
    }
  }
}
