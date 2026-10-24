// Model danych AgentOS (format 4).

export type ProviderKind = "openai" | "anthropic" | "google" | "ollama" | "lmstudio" | "local" | "openrouter" | "custom";

export type Provider = {
  id: string;
  name: string;
  kind: ProviderKind;
  model: string;
  endpoint: string;
  hasKey: boolean;
  models?: string[];
  status?: "unknown" | "ok" | "offline" | "error";
  statusText?: string;
};

/** Ile agent może zrobić bez pytania. */
export type AccessMode = "read" | "ask" | "auto";

export type MemoryNote = { id: string; text: string; createdAt: string; source: string };

export type Project = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  instructions: string;
  memory: MemoryNote[];
  accessMode: AccessMode;
  providerId?: string;
  contextFiles?: string[];
};

export type ConversationStatus = "idle" | "running" | "waiting" | "done" | "warning" | "failed" | "stopped";

export type PlanStep = { title: string; status: "todo" | "doing" | "done" };

export type DiffLine = { kind: "same" | "add" | "del" | "gap"; text: string };

export type ConversationItem =
  | { id: string; kind: "user"; text: string; at: string }
  | { id: string; kind: "assistant"; text: string; at: string }
  | { id: string; kind: "plan"; goal: string; steps: PlanStep[]; decision: "pending" | "approved" | "changed"; at: string }
  | { id: string; kind: "action"; tool: string; title: string; status: "running" | "done" | "failed"; output?: string; at: string }
  | {
      id: string;
      kind: "approval";
      tool: "write_file" | "run_command" | "install_skill";
      title: string;
      detail: string;
      diff?: DiffLine[];
      added?: number;
      removed?: number;
      status: "pending" | "approved" | "rejected";
      at: string;
    }
  | { id: string; kind: "change"; changeId: string; path: string; change: "created" | "modified"; added: number; removed: number; at: string }
  | { id: string; kind: "error"; text: string; at: string }
  | { id: string; kind: "result"; text: string; warnings: string[]; at: string }
  | { id: string; kind: "notice"; text: string; at: string };

export type Change = {
  id: string;
  conversationId: string;
  path: string;
  kind: "created" | "modified";
  added: number;
  removed: number;
  at: string;
  undone: boolean;
  preview: DiffLine[];
};

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };

export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string; isError: boolean };

export type Conversation = {
  id: string;
  projectId: string | null;
  title: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  providerId: string;
  model: string;
  items: ConversationItem[];
  api: AgentMessage[];
  changes: Change[];
  usage: { input: number; output: number };
  toolsUnsupported?: boolean;
};

export type Theme = "system" | "light" | "dark";

export type Snapshot = {
  version: 4;
  projects: Project[];
  conversations: Conversation[];
  providers: Provider[];
  defaultProviderId: string;
  defaultAccessMode: AccessMode;
  theme: Theme;
  /** Repozytoria GitHub przeszukiwane jako katalog umiejętności. */
  skillSources: string[];
  /** Wyłączone umiejętności: "global/slug" albo "<projectId>|<location>/<slug>". */
  disabledSkills: string[];
};

export type Route =
  | { screen: "home" }
  | { screen: "project"; projectId: string; tab: "chats" | "files" | "changes" | "settings" }
  | { screen: "conversation"; conversationId: string }
  | { screen: "models" }
  | { screen: "skills" }
  | { screen: "settings" };

export const LOCAL_KINDS: ProviderKind[] = ["ollama", "lmstudio", "local"];
export const isLocal = (provider: Pick<Provider, "kind">) => LOCAL_KINDS.includes(provider.kind);

export const defaultProviders: Provider[] = [
  { id: "ollama", name: "Ollama", kind: "ollama", model: "", endpoint: "http://localhost:11434/v1/chat/completions", hasKey: false },
  { id: "lmstudio", name: "LM Studio", kind: "lmstudio", model: "", endpoint: "http://localhost:1234/v1/chat/completions", hasKey: false },
  { id: "anthropic", name: "Anthropic (Claude)", kind: "anthropic", model: "claude-sonnet-5-5", endpoint: "https://api.anthropic.com/v1/messages", hasKey: false },
  { id: "openai", name: "OpenAI", kind: "openai", model: "", endpoint: "https://api.openai.com/v1/chat/completions", hasKey: false },
  { id: "google", name: "Google (Gemini)", kind: "google", model: "", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", hasKey: false },
  { id: "openrouter", name: "OpenRouter", kind: "openrouter", model: "", endpoint: "https://openrouter.ai/api/v1/chat/completions", hasKey: false },
];

export const emptySnapshot: Snapshot = {
  version: 4,
  projects: [],
  conversations: [],
  providers: defaultProviders,
  defaultProviderId: "anthropic",
  defaultAccessMode: "ask",
  theme: "system",
  skillSources: ["anthropics/skills"],
  disabledSkills: [],
};

export const accessModeLabel: Record<AccessMode, { short: string; long: string }> = {
  read: { short: "Tylko odczyt", long: "Agent czyta pliki, ale niczego nie zmienia i nie uruchamia poleceń." },
  ask: { short: "Pytaj przed zmianą", long: "Każdy zapis pliku pokazuje podgląd i czeka na Twoją zgodę." },
  auto: { short: "Automatycznie w projekcie", long: "Agent zapisuje pliki w tym projekcie bez pytania. Każdą zmianę można cofnąć." },
};

export const statusLabel: Record<ConversationStatus, string> = {
  idle: "Zaplanowane",
  running: "W trakcie",
  waiting: "Oczekuje na decyzję",
  done: "Zakończone",
  warning: "Zakończone z ostrzeżeniem",
  failed: "Nieudane",
  stopped: "Zatrzymane",
};

export type InstalledSkill = {
  key: string;
  scope: "global" | "project";
  slug: string;
  name: string;
  description: string;
  dir: string;
  location: string;
  source?: string | null;
  repo?: string | null;
  gitRef?: string | null;
  repoPath?: string | null;
  fileCount: number;
  hasScripts: boolean;
  removable: boolean;
};

export type RemoteSkill = {
  repo: string;
  gitRef: string;
  dir: string;
  name: string;
  description: string;
  fileCount: number;
  totalBytes: number;
  hasScripts: boolean;
  url: string;
  origin: "catalog" | "community" | "url" | "preview";
};

export type SkillPreview = {
  skill: RemoteSkill;
  content: string;
  files: Array<{ path: string; size: number; script: boolean }>;
  risks: string[];
  blocked?: string | null;
};

export type SkillSearchResult = {
  catalog: RemoteSkill[];
  community: RemoteSkill[];
  repos: Array<{ repo: string; description: string; stars: number; url: string; updated: string }>;
  errors: string[];
  usedToken: boolean;
};

/** Klucz włączenia umiejętności — projektowe są rozróżniane per projekt. */
export const skillToggleId = (skill: Pick<InstalledSkill, "scope" | "key">, projectId: string | null) =>
  skill.scope === "global" ? skill.key : `${projectId ?? "-"}|${skill.key}`;
