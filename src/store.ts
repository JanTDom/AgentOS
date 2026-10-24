// Wczytywanie, migracja i zapis stanu AgentOS.
import { api, inDesktopApp } from "./api";
import { defaultProviders, emptySnapshot, type Conversation, type ConversationItem, type Project, type Provider, type Snapshot } from "./types";

const LOCAL_KEY = "agentos-snapshot-v4";
const DEMO_PROJECT_IDS = new Set(["report", "research", "automation", "product"]);
const DEMO_RUN_IDS = new Set(["run-report", "run-market", "run-invoices"]);

export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const nowIso = () => new Date().toISOString();

type Legacy = Record<string, any>;

function mergeProviders(saved: Partial<Provider>[]): Provider[] {
  const result: Provider[] = defaultProviders.map((base) => {
    const match = saved.find((item) => item.id === base.id);
    if (!match) return base;
    // Stary format przechowywał wymyślone nazwy modeli — zachowujemy tylko zapisane przez użytkownika.
    const legacyDefaults = new Set(["gpt-5.6-sol", "claude-sonnet-4-6", "gemini-3-pro", "llama3.3", "auto"]);
    const model = match.model && !legacyDefaults.has(match.model) ? match.model : base.model;
    return { ...base, model, models: match.models, hasKey: Boolean(match.hasKey) && base.kind !== "ollama" && base.kind !== "lmstudio" };
  });
  for (const item of saved) {
    if (!item.id || result.some((p) => p.id === item.id)) continue;
    result.push({
      id: item.id,
      name: (item.name ?? "Dostawca").replace(" · katalog", ""),
      kind: (item.kind as Provider["kind"]) ?? "custom",
      model: item.model ?? "",
      endpoint: item.endpoint ?? "",
      hasKey: Boolean(item.hasKey),
    });
  }
  return result;
}

function migrateLegacy(old: Legacy): Snapshot {
  const knowledge: Record<string, Legacy> = old.knowledge ?? {};
  const projects: Project[] = (Array.isArray(old.projects) ? old.projects : [])
    .filter((p: Legacy) => p?.id && !DEMO_PROJECT_IDS.has(p.id) && p.path)
    .map((p: Legacy) => {
      const k = knowledge[p.id] ?? {};
      const memory = Array.isArray(k.memory) ? k.memory : [];
      return {
        id: p.id,
        name: p.name ?? "Projekt",
        path: p.path,
        createdAt: nowIso(),
        instructions: typeof k.instructions === "string" ? k.instructions : "",
        memory: memory.map((m: Legacy) => ({ id: m.id ?? uid("mem"), text: m.content ?? "", createdAt: m.updatedAt ?? nowIso(), source: m.source ?? "wpis użytkownika" })),
        accessMode: "ask",
        contextFiles: p.contextFiles ?? [],
      } satisfies Project;
    });
  const projectIds = new Set(projects.map((p) => p.id));
  const conversations: Conversation[] = (Array.isArray(old.runs) ? old.runs : [])
    .filter((r: Legacy) => r?.id && !DEMO_RUN_IDS.has(r.id))
    .map((r: Legacy) => {
      const messages: Legacy[] = Array.isArray(r.messages)
        ? r.messages
        : r.response ? [{ role: "user", content: r.title }, { role: "assistant", content: r.response }] : [{ role: "user", content: r.title }];
      const items: ConversationItem[] = messages.map((m) => ({
        id: uid("item"),
        kind: m.role === "user" ? "user" : "assistant",
        text: String(m.content ?? ""),
        at: nowIso(),
      }) as ConversationItem);
      items.push({ id: uid("item"), kind: "notice", text: "Rozmowa przeniesiona z poprzedniej wersji AgentOS.", at: nowIso() });
      return {
        id: r.id,
        projectId: projectIds.has(r.projectId) ? r.projectId : null,
        title: String(r.title ?? "Rozmowa").slice(0, 120),
        status: r.status === "failed" ? "failed" : "done",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        providerId: r.providerId ?? "anthropic",
        model: r.model ?? "",
        items,
        api: messages.map((m) => m.role === "user" ? { role: "user", text: String(m.content ?? "") } : { role: "assistant", text: String(m.content ?? ""), toolCalls: [] }),
        changes: [],
        usage: { input: 0, output: 0 },
      } satisfies Conversation;
    });
  return {
    ...emptySnapshot,
    projects,
    conversations,
    providers: mergeProviders(Array.isArray(old.providers) ? old.providers : []),
  };
}

export function normalize(raw: unknown): { snapshot: Snapshot; migrated: boolean } {
  if (!raw || typeof raw !== "object") return { snapshot: emptySnapshot, migrated: false };
  const value = raw as Legacy;
  if (value.version === 4) {
    return {
      snapshot: {
        ...emptySnapshot,
        ...value,
        providers: mergeProviders(value.providers ?? []),
        projects: value.projects ?? [],
        conversations: value.conversations ?? [],
      } as Snapshot,
      migrated: false,
    };
  }
  return { snapshot: migrateLegacy(value.snapshot ?? value), migrated: true };
}

/** Rozmowy przerwane zamknięciem aplikacji oznaczamy uczciwie jako zatrzymane. */
export function markInterrupted(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    conversations: snapshot.conversations.map((c) => {
      if (c.status !== "running" && c.status !== "waiting") return c;
      return {
        ...c,
        status: "stopped",
        items: [
          ...c.items.map((item) =>
            item.kind === "approval" && item.status === "pending" ? { ...item, status: "rejected" as const }
              : item.kind === "action" && item.status === "running" ? { ...item, status: "failed" as const }
              : item),
          { id: uid("item"), kind: "notice", text: "Praca została przerwana, bo AgentOS był zamknięty. Napisz „kontynuuj”, aby wznowić.", at: nowIso() },
        ],
      };
    }),
  };
}

export async function loadSnapshot(): Promise<Snapshot> {
  if (inDesktopApp) {
    const raw = await api.getSnapshot().catch(() => null);
    const { snapshot, migrated } = normalize(raw);
    if (migrated && raw) await api.backupSnapshot("v3-before-redesign").catch(() => false);
    return markInterrupted(snapshot);
  }
  try {
    return markInterrupted(normalize(JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? "null")).snapshot);
  } catch {
    return emptySnapshot;
  }
}

let timer: number | undefined;
export function saveSnapshotSoon(snapshot: Snapshot) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (inDesktopApp) void api.saveSnapshot(snapshot).catch(() => undefined);
    else {
      try { window.localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot)); } catch { /* brak miejsca w podglądzie */ }
    }
  }, 600);
}
