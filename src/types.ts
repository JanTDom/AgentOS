export type View = "overview" | "activity" | "projects" | "run" | "models" | "workspace" | "computer" | "settings";
export type TaskScope = "chat" | "project" | "analysis";

export type Project = {
  id: string;
  name: string;
  path: string;
  kind: "folder" | "git" | "documents";
  status: "active" | "idle" | "attention";
  files: number;
  lastActivity: string;
  contextFiles?: string[];
};

export type Provider = {
  id: string;
  name: string;
  kind: "openai" | "anthropic" | "google" | "ollama" | "openrouter" | "custom";
  model: string;
  endpoint: string;
  hasKey: boolean;
  latency: string;
  tone: "cyan" | "violet" | "green" | "amber";
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  capabilities?: string[];
};

export type ProviderKeyStatus = {
  providerId: string;
  hasKey: boolean;
};

export type ModelOffer = {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  inputPrice: number;
  outputPrice: number;
  source: string;
  free: boolean;
  modalities: string[];
  checkedAt: string;
};

export type TimelineItem = {
  id: string;
  kind: "plan" | "agents" | "tests" | "evidence" | "approval";
  title: string;
  description?: string;
  status: "done" | "running" | "waiting" | "queued";
  time: string;
  details?: string[];
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type MemoryItem = {
  id: string;
  title: string;
  content: string;
  source: string;
  scope: "global" | "project";
  confidence: "high" | "medium" | "low";
  tags: string[];
  enabled: boolean;
  status?: "active" | "expired" | "conflict" | "disabled";
  verifiedAt?: string;
  supersedes?: string;
  updatedAt: string;
};

export type ProjectSource = {
  id: string;
  name: string;
  path: string;
  kind: "folder" | "file" | "url" | "note";
  addedAt: string;
  description?: string;
};

export type AgentDefinition = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  modelId: string;
  enabled: boolean;
};

export type ProjectKnowledge = {
  instructions: string;
  memory: MemoryItem[];
  sources: ProjectSource[];
  agents: AgentDefinition[];
};

export type RoutingPolicy = {
  mode: "economical" | "balanced" | "quality";
  autoSwitch: boolean;
  allowFallback: boolean;
  preferLocal: boolean;
  maxCostPerTask: number;
  dailyBudget: number;
};

export type UsageLedgerEntry = {
  id: string;
  runId: string;
  providerId: string;
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCost: number;
  reason: string;
  createdAt: string;
};

export type Run = {
  id: string;
  title: string;
  projectId: string;
  status: "running" | "waiting" | "done" | "failed";
  started: string;
  progress: number;
  timeline: TimelineItem[];
  response?: string;
  messages?: ChatMessage[];
  scope?: TaskScope;
  providerId?: string;
  model?: string;
  routingReason?: string;
  estimatedCost?: number;
  worktreePath?: string;
  checkpointPath?: string;
};

export type AppSnapshot = {
  projects: Project[];
  providers: Provider[];
  runs: Run[];
  activeProjectId: string;
  activeRunId: string;
  knowledge: Record<string, ProjectKnowledge>;
  globalMemory: MemoryItem[];
  routing: RoutingPolicy;
  usageLedger: UsageLedgerEntry[];
};

export type Profile = {
  displayName: string;
  plan: string;
};

export type PermissionState = {
  network: boolean;
  computer: boolean;
  redactSecrets: boolean;
  requireApproval: boolean;
  isolateSessions: boolean;
  eventLog: boolean;
};

export const defaultProfile: Profile = {
  displayName: "Gość",
  plan: "Profil lokalny",
};

export const defaultPermissions: PermissionState = {
  network: true,
  computer: true,
  redactSecrets: true,
  requireApproval: true,
  isolateSessions: true,
  eventLog: true,
};

export const defaultSnapshot: AppSnapshot = {
  projects: [
    {
      id: "report",
      name: "Raport kwartalny",
      path: "/Users/macbookpro/PROJEKTY/raport",
      kind: "git",
      status: "active",
      files: 148,
      lastActivity: "teraz",
    },
    {
      id: "research",
      name: "Badanie rynku",
      path: "/Users/macbookpro/PROJEKTY/badanie-rynku",
      kind: "documents",
      status: "idle",
      files: 62,
      lastActivity: "wczoraj",
    },
    {
      id: "automation",
      name: "Automatyzacja faktur",
      path: "/Users/macbookpro/PROJEKTY/faktury",
      kind: "folder",
      status: "attention",
      files: 37,
      lastActivity: "2 dni temu",
    },
    {
      id: "product",
      name: "Strona produktu",
      path: "/Users/macbookpro/PROJEKTY/strona-produktu",
      kind: "git",
      status: "idle",
      files: 203,
      lastActivity: "5 dni temu",
    },
  ],
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      kind: "openai",
      model: "gpt-5.6-sol",
      endpoint: "https://api.openai.com/v1/chat/completions",
      hasKey: false,
      latency: "szybki",
      tone: "cyan",
    },
    {
      id: "anthropic",
      name: "Anthropic",
      kind: "anthropic",
      model: "claude-sonnet-4-6",
      endpoint: "https://api.anthropic.com/v1/messages",
      hasKey: false,
      latency: "głęboki",
      tone: "violet",
    },
    {
      id: "google",
      name: "Google AI",
      kind: "google",
      model: "gemini-3-pro",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      hasKey: false,
      latency: "duży kontekst",
      tone: "green",
    },
    {
      id: "ollama",
      name: "Lokalne modele",
      kind: "ollama",
      model: "llama3.3",
      endpoint: "http://localhost:11434/v1/chat/completions",
      hasKey: true,
      latency: "prywatny",
      tone: "amber",
    },
    {
      id: "openrouter",
      name: "OpenRouter · katalog",
      kind: "openrouter",
      model: "auto",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      hasKey: false,
      latency: "auto-routing",
      tone: "cyan",
    },
  ],
  runs: [
    {
      id: "run-report",
      title: "Ulepsz stronę raportu",
      projectId: "report",
      status: "waiting",
      started: "10:14",
      progress: 78,
      timeline: [
        {
          id: "plan",
          kind: "plan",
          title: "Plan",
          status: "done",
          time: "10:14",
          details: [
            "Przejrzyj obecną stronę raportu",
            "Zaproponuj 2 warianty zmian",
            "Zaimplementuj wybrany wariant",
            "Uruchom testy",
            "Przygotuj dowody i poproś o zatwierdzenie",
          ],
        },
        {
          id: "agents",
          kind: "agents",
          title: "2 warianty",
          description: "Dwa agenty pracują w izolowanych środowiskach",
          status: "done",
          time: "10:17",
          details: ["Agent A · nowy układ sekcji raportu", "Agent B · uproszczona nawigacja"],
        },
        {
          id: "tests",
          kind: "tests",
          title: "Testy przeszły",
          description: "12/12 testów · brak błędów",
          status: "done",
          time: "10:22",
        },
        {
          id: "evidence",
          kind: "evidence",
          title: "Dowody",
          description: "Diff, screenshot i raport dostępności gotowe",
          status: "done",
          time: "10:24",
        },
        {
          id: "approval",
          kind: "approval",
          title: "Wymaga decyzji",
          description: "Zatwierdź zakres sieci i sterowania komputerem",
          status: "waiting",
          time: "teraz",
        },
      ],
    },
    {
      id: "run-market",
      title: "Zbierz porównanie konkurencji",
      projectId: "research",
      status: "running",
      started: "09:42",
      progress: 46,
      timeline: [],
    },
    {
      id: "run-invoices",
      title: "Sprawdź błędy importu faktur",
      projectId: "automation",
      status: "failed",
      started: "wczoraj",
      progress: 31,
      timeline: [],
    },
  ],
  activeProjectId: "report",
  activeRunId: "run-report",
  knowledge: {},
  globalMemory: [],
  routing: {
    mode: "balanced",
    autoSwitch: true,
    allowFallback: true,
    preferLocal: true,
    maxCostPerTask: 0.25,
    dailyBudget: 5,
  },
  usageLedger: [],
};
