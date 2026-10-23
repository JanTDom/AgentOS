import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Code2,
  Command,
  Cpu,
  Download,
  Folder,
  FolderOpen,
  Globe2,
  KeyRound,
  Laptop,
  LayoutDashboard,
  LockKeyhole,
  MessageSquare,
  MoreHorizontal,
  Network,
  Play,
  Plus,
  Pencil,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Timer,
  Trash2,
  Upload,
  Users,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import {
  AppSnapshot,
  AgentDefinition,
  defaultSnapshot,
  MemoryItem,
  EvidenceArtifact,
  SkillDefinition,
  Project,
  ProjectKnowledge,
  ProjectSource,
  Provider,
  Run,
  TimelineItem,
  View,
  ModelOffer,
  defaultPermissions,
  defaultProfile,
  PermissionState,
  Profile,
  ProviderKeyStatus,
  RoutingPolicy,
  UsageLedgerEntry,
  TaskScope,
  ChatMessage,
} from "./types";

type Notice = { tone: "good" | "warn" | "bad"; text: string } | null;

const SNAPSHOT_STORAGE_KEY = "agentos-snapshot";
const SNAPSHOT_STORAGE_VERSION = 3;
const SELECTED_PROVIDER_STORAGE_KEY = "agentos-selected-provider-id";

const emptyKnowledge: ProjectKnowledge = {
  instructions: "",
  memory: [],
  sources: [],
  agents: [],
};

const toneClass: Record<Provider["tone"], string> = {
  cyan: "tone-cyan",
  violet: "tone-violet",
  green: "tone-green",
  amber: "tone-amber",
};

async function tryInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    return await invoke<T>(command, args);
  } catch {
    return null;
  }
}

function saveLocal(snapshot: AppSnapshot) {
  window.localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify({
    version: SNAPSHOT_STORAGE_VERSION,
    snapshot,
  }));
}

function loadLocal(): AppSnapshot {
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if (!raw) return defaultSnapshot;
    const parsed = JSON.parse(raw) as Partial<AppSnapshot> & { snapshot?: Partial<AppSnapshot>; version?: number };
    if ((parsed.version ?? 1) < SNAPSHOT_STORAGE_VERSION) {
      window.localStorage.setItem(`agentos-snapshot-backup-${Date.now()}`, raw);
    }
    const candidate = parsed.snapshot ?? parsed;
    const savedProviders = Array.isArray(candidate.providers) ? candidate.providers : [];
    const defaultProviderIds = new Set(defaultSnapshot.providers.map((provider) => provider.id));
    const providers = [
      ...defaultSnapshot.providers.map((defaultProvider) => {
        const saved = savedProviders.find((provider) => provider.id === defaultProvider.id);
        return saved ? { ...defaultProvider, ...saved } : defaultProvider;
      }),
      ...savedProviders.filter((provider) => !defaultProviderIds.has(provider.id)),
    ];
    return {
      ...defaultSnapshot,
      ...candidate,
      providers,
      projects: Array.isArray(candidate.projects) ? candidate.projects : defaultSnapshot.projects,
      runs: Array.isArray(candidate.runs) ? candidate.runs : defaultSnapshot.runs,
      knowledge: candidate.knowledge && typeof candidate.knowledge === "object" ? candidate.knowledge : defaultSnapshot.knowledge,
      globalMemory: Array.isArray(candidate.globalMemory) ? candidate.globalMemory : defaultSnapshot.globalMemory,
      routing: candidate.routing ? { ...defaultSnapshot.routing, ...candidate.routing } : defaultSnapshot.routing,
      usageLedger: Array.isArray(candidate.usageLedger) ? candidate.usageLedger : defaultSnapshot.usageLedger,
    } as AppSnapshot;
  } catch {
    return defaultSnapshot;
  }
}

function loadLocalValue<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveLocalValue<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function conversationPrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => `${message.role === "user" ? "Użytkownik" : "AgentOS"}: ${message.content}`)
    .join("\n\n");
}

function projectKnowledge(snapshot: AppSnapshot, projectId: string): ProjectKnowledge {
  return snapshot.knowledge?.[projectId] ?? emptyKnowledge;
}

function providerCanHandle(provider: Provider, scope: TaskScope): boolean {
  if (!provider.capabilities || provider.capabilities.length === 0) return true;
  if (scope === "analysis") return provider.capabilities.includes("text") || provider.capabilities.includes("long_context");
  return provider.capabilities.includes("text");
}

function chooseProvider(
  providers: Provider[],
  selectedProvider: Provider | undefined,
  offers: ModelOffer[],
  routing: AppSnapshot["routing"],
  scope: TaskScope,
  prompt: string,
): { provider: Provider | undefined; reason: string; estimatedCost: number } {
  const compatible = providers.filter((provider) => providerCanHandle(provider, scope));
  if (!routing.autoSwitch || compatible.length === 0) {
    return { provider: selectedProvider, reason: "ręcznie wybrany dostawca", estimatedCost: 0 };
  }
  const local = compatible.find((provider) => provider.kind === "ollama");
  const priced = compatible.map((provider) => {
    const offer = offers.find((item) => item.id === provider.model);
    const input = provider.inputPricePerMillion ?? offer?.inputPrice ?? 0;
    const output = provider.outputPricePerMillion ?? offer?.outputPrice ?? 0;
    const estimatedCost = ((prompt.length / 4) * input + 500 * output) / 1_000_000;
    return { provider, estimatedCost };
  });
  if (routing.preferLocal && local && prompt.length < 12000 && (routing.mode !== "quality" || !selectedProvider)) {
    return { provider: local, reason: "lokalny model: brak kosztu i dane pozostają na Macu", estimatedCost: 0 };
  }
  const sorted = priced.sort((left, right) => {
    const qualityBias = routing.mode === "quality" ? (right.provider.kind === "anthropic" ? 0.05 : 0) : 0;
    const leftScore = left.estimatedCost - qualityBias;
    const rightScore = right.estimatedCost - (routing.mode === "quality" && right.provider.kind === "anthropic" ? 0.05 : 0);
    return routing.mode === "quality" ? leftScore - rightScore : left.estimatedCost - right.estimatedCost;
  });
  const candidate = routing.mode === "quality" && selectedProvider ? selectedProvider : sorted[0]?.provider ?? selectedProvider;
  const chosenCost = priced.find((item) => item.provider.id === candidate?.id)?.estimatedCost ?? 0;
  if (candidate && chosenCost <= routing.maxCostPerTask) {
    return {
      provider: candidate,
      estimatedCost: chosenCost,
      reason: routing.mode === "economical" ? "najniższy przewidywany koszt w limicie" : "najlepszy dostępny kompromis kosztu i możliwości",
    };
  }
  return { provider: selectedProvider, estimatedCost: 0, reason: "limit kosztu wymusił ręcznie wybranego dostawcę" };
}

function buildTaskPrompt(prompt: string, knowledge: ProjectKnowledge, globalMemory: MemoryItem[], projectPath: string, mode: TaskScope): string {
  const enabledMemory = [...globalMemory, ...knowledge.memory].filter((item) => item.enabled).slice(0, 40);
  const enabledAgents = orderAgents(knowledge.agents.filter((agent) => agent.enabled));
  const trustedSkills = (knowledge.skills ?? []).filter((skill) => skill.enabled && skill.trusted);
  const context = [
    `Projekt: ${projectPath || "brak aktywnego katalogu"}`,
    `Tryb: ${mode}`,
    knowledge.instructions ? `Instrukcje projektu:\n${knowledge.instructions}` : "",
    enabledMemory.length ? `Pamięć z pochodzeniem:\n${enabledMemory.map((item) => `- ${item.title} [${item.source}${item.status === "conflict" ? "; KONFLIKT — nie rozstrzygaj samodzielnie" : ""}]: ${item.content}`).join("\n")}` : "",
    knowledge.sources.length ? `Źródła dostępne w projekcie:\n${knowledge.sources.map((source) => `- ${source.name}: ${source.path}`).join("\n")}` : "",
    enabledAgents.length ? `Role agentów do uwzględnienia:\n${enabledAgents.map((agent) => `- ${agent.name} (${agent.role}): ${agent.instructions}`).join("\n")}` : "",
    trustedSkills.length ? `Zaufane skille projektu (opisowe, bez automatycznego wykonywania):\n${trustedSkills.map((skill) => `- ${skill.name} ${skill.version}: ${skill.description}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return `${context}\n\nZadanie użytkownika:\n${prompt}`;
}

function orderAgents(agents: AgentDefinition[]): AgentDefinition[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const ordered: AgentDefinition[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (agent: AgentDefinition) => {
    if (visited.has(agent.id)) return;
    if (visiting.has(agent.id)) throw new Error(`Cykl w grafie agentów przy ${agent.name}`);
    visiting.add(agent.id);
    for (const dependency of agent.dependsOn ?? []) {
      const parent = byId.get(dependency);
      if (parent) visit(parent);
    }
    visiting.delete(agent.id);
    visited.add(agent.id);
    ordered.push(agent);
  };
  for (const agent of agents) visit(agent);
  return ordered;
}

const emptyProject: Project = {
  id: "no-project",
  name: "Brak aktywnego projektu",
  path: "",
  kind: "folder",
  status: "idle",
  files: 0,
  lastActivity: "—",
};

const emptyRun: Run = {
  id: "no-run",
  title: "Brak aktywnej sesji",
  projectId: emptyProject.id,
  status: "done",
  started: "—",
  progress: 0,
  timeline: [],
};

function statusLabel(status: Run["status"] | Project["status"]): string {
  return {
    running: "działa",
    waiting: "wymaga decyzji",
    done: "gotowe",
    failed: "błąd",
    active: "aktywne",
    idle: "spokojne",
    attention: "uwaga",
  }[status];
}

function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(() => loadLocal());
  const [profile, setProfile] = useState<Profile>(() => {
    const stored = loadLocalValue<Profile | null>("agentos-profile", null);
    return stored && stored.displayName !== "Anna Kowalska" ? stored : defaultProfile;
  });
  const [permissions, setPermissions] = useState<PermissionState>(() => loadLocalValue("agentos-permissions", defaultPermissions));
  const [view, setView] = useState<View>("overview");
  const [taskScope, setTaskScope] = useState<TaskScope>("chat");
  const [task, setTask] = useState("");
  const [followUpTask, setFollowUpTask] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [networkUrl, setNetworkUrl] = useState("https://example.com");
  const [networkResult, setNetworkResult] = useState("");
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState(() => loadLocalValue(SELECTED_PROVIDER_STORAGE_KEY, "openai"));
  const [modelOffers, setModelOffers] = useState<ModelOffer[]>(() => loadLocalValue("agentos-model-offers", []));
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [providerDraft, setProviderDraft] = useState({
    name: "Nowy dostawca",
    kind: "custom" as Provider["kind"],
    model: "",
    endpoint: "",
    key: "",
  });
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const queuedTaskRef = useRef<Array<{ title: string; scope: TaskScope }>>([]);
  const [autoLaunchQueuedTask, setAutoLaunchQueuedTask] = useState(false);

  useEffect(() => {
    void tryInvoke<AppSnapshot>("get_snapshot").then((remote) => {
      if (remote) setSnapshot(remote);
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void tryInvoke<ProviderKeyStatus[]>("get_provider_key_statuses", {
      providerIds: snapshot.providers.map((provider) => provider.id),
    }).then((statuses) => {
      if (!statuses || cancelled) return;
      const statusById = new Map(statuses.map((status) => [status.providerId, status.hasKey]));
      setSnapshot((current) => ({
        ...current,
        providers: current.providers.map((provider) => statusById.has(provider.id)
          ? { ...provider, hasKey: statusById.get(provider.id) ?? false }
          : provider),
      }));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveLocal(snapshot);
    void tryInvoke("save_snapshot", { snapshot });
  }, [snapshot, hydrated]);

  useEffect(() => {
    saveLocalValue("agentos-profile", profile);
  }, [profile]);

  useEffect(() => {
    saveLocalValue("agentos-permissions", permissions);
  }, [permissions]);

  useEffect(() => {
    saveLocalValue("agentos-model-offers", modelOffers);
  }, [modelOffers]);

  useEffect(() => {
    saveLocalValue(SELECTED_PROVIDER_STORAGE_KEY, selectedProviderId);
  }, [selectedProviderId]);

  useEffect(() => {
    if (snapshot.providers.length > 0 && !snapshot.providers.some((provider) => provider.id === selectedProviderId)) {
      setSelectedProviderId(snapshot.providers[0].id);
    }
  }, [snapshot.providers, selectedProviderId]);

  const activeProject = snapshot.projects.find((project) => project.id === snapshot.activeProjectId) ?? snapshot.projects[0] ?? emptyProject;
  const activeKnowledge = projectKnowledge(snapshot, activeProject.id);
  const activeRun = snapshot.runs.find((run) => run.id === snapshot.activeRunId) ?? snapshot.runs[0] ?? emptyRun;
  const activeProvider = snapshot.providers.find((provider) => provider.id === selectedProviderId) ?? snapshot.providers[0];

  const updateSnapshot = (next: AppSnapshot) => setSnapshot(next);

  const updateActiveKnowledge = (next: ProjectKnowledge) => {
    setSnapshot((current) => ({
      ...current,
      knowledge: { ...current.knowledge, [activeProject.id]: next },
    }));
  };

  const addProjectSource = async () => {
    try {
      const selected = await open({ multiple: true, directory: false, title: "Dodaj źródła do projektu" });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const current = projectKnowledge(snapshot, activeProject.id);
      const sources: ProjectSource[] = paths.map((path) => ({
        id: `source-${Date.now()}-${path}`,
        name: path.split("/").filter(Boolean).pop() ?? path,
        path,
        kind: "file",
        addedAt: new Date().toISOString(),
      }));
      updateActiveKnowledge({ ...current, sources: [...sources, ...current.sources] });
      notify({ tone: "good", text: `Dodano ${sources.length} źródeł do projektu.` });
    } catch {
      notify({ tone: "warn", text: "Dodawanie źródła wymaga uruchomionej aplikacji macOS." });
    }
  };

  const addMemory = (scope: "global" | "project") => {
    const content = window.prompt(scope === "global" ? "Wpisz wiedzę wspólną dla wszystkich projektów:" : "Wpisz pamięć tego projektu:");
    if (!content?.trim()) return;
    const normalized = content.trim().toLocaleLowerCase().replace(/\s+/g, " ");
    const currentKnowledge = projectKnowledge(snapshot, activeProject.id);
    const allMemory = [...snapshot.globalMemory, ...currentKnowledge.memory];
    const existing = allMemory.find((item) => item.content.toLocaleLowerCase().replace(/\s+/g, " ") === normalized);
    if (existing) {
      notify({ tone: "warn", text: `Ta wiedza już istnieje (${existing.scope === "global" ? "globalnie" : "w projekcie"}). Nie utworzono duplikatu.` });
      return;
    }
    const title = content.trim().slice(0, 64);
    const conflicts = allMemory.filter((memory) => memory.title.toLocaleLowerCase() === title.toLocaleLowerCase() && memory.content.toLocaleLowerCase().replace(/\s+/g, " ") !== normalized);
    const item: MemoryItem = {
      id: `memory-${Date.now()}`,
      title,
      content: content.trim(),
      source: "wpis użytkownika",
      scope,
      confidence: "high",
      tags: [],
      enabled: true,
      status: conflicts.length ? "conflict" : "active",
      verifiedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (scope === "global") {
      updateSnapshot({ ...snapshot, globalMemory: [item, ...snapshot.globalMemory.map((memory) => conflicts.some((conflict) => conflict.id === memory.id) ? { ...memory, status: "conflict" as const } : memory)] });
    } else {
      updateActiveKnowledge({ ...currentKnowledge, memory: [item, ...currentKnowledge.memory.map((memory) => conflicts.some((conflict) => conflict.id === memory.id) ? { ...memory, status: "conflict" as const } : memory)] });
    }
    notify({ tone: conflicts.length ? "warn" : "good", text: conflicts.length ? "Zapisano wpis jako konflikt — AgentOS nie wybierze sam jednej wersji." : "Pamięć została zapisana lokalnie z oznaczeniem źródła." });
  };

  const addAgent = () => {
    const current = projectKnowledge(snapshot, activeProject.id);
    const agent: AgentDefinition = {
      id: `agent-${Date.now()}`,
      name: `Agent ${current.agents.length + 1}`,
      role: "specjalista",
      instructions: "Opisz tutaj zakres odpowiedzialności tego agenta.",
      modelId: selectedProviderId,
      enabled: true,
      dependsOn: [],
    };
    updateActiveKnowledge({ ...current, agents: [...current.agents, agent] });
    notify({ tone: "good", text: "Dodano agenta do projektu. Jego instrukcje możesz teraz doprecyzować." });
  };

  const exportProjectContext = () => {
    const payload = { format: "agentos-project-context", version: 1, exportedAt: new Date().toISOString(), project: activeProject, knowledge: activeKnowledge, globalMemory: snapshot.globalMemory, routing: snapshot.routing };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeProject.name.replace(/[^a-z0-9ąćęłńóśźż_-]+/gi, "-")}-agentos-context.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify({ tone: "good", text: "Wyeksportowano przenośny kontekst projektu." });
  };

  const exportRunEvidence = (run: Run) => {
    const payload = { format: "agentos-run-evidence", version: 1, exportedAt: new Date().toISOString(), run, project: activeProject, knowledge: activeKnowledge, globalMemory: snapshot.globalMemory, routing: snapshot.routing, usage: snapshot.usageLedger.filter((entry) => entry.runId === run.id) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${run.id}-agentos-evidence.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify({ tone: "good", text: "Wyeksportowano pakiet dowodowy sesji." });
  };

  const importProjectContext = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text()) as { knowledge?: ProjectKnowledge; globalMemory?: MemoryItem[] };
      if (!payload.knowledge) throw new Error("Brak sekcji knowledge");
      setSnapshot((current) => ({ ...current, knowledge: { ...current.knowledge, [activeProject.id]: { ...emptyKnowledge, ...payload.knowledge } }, globalMemory: payload.globalMemory ?? current.globalMemory }));
      notify({ tone: "good", text: "Zaimportowano kontekst projektu bez nadpisywania plików." });
    } catch (error) {
      notify({ tone: "bad", text: `Nie udało się zaimportować kontekstu: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const notify = (next: Notice) => {
    setNotice(next);
    window.setTimeout(() => setNotice(null), 4600);
  };

  const updatePermission = (key: keyof PermissionState) => {
    setPermissions((current) => ({ ...current, [key]: !current[key] }));
  };

  const updateProfile = (next: Profile) => {
    const displayName = next.displayName.trim();
    if (!displayName) {
      notify({ tone: "warn", text: "Nazwa profilu nie może być pusta." });
      return false;
    }
    setProfile({ ...next, displayName });
    notify({ tone: "good", text: "Profil zapisany lokalnie." });
    return true;
  };

  const removeProfile = () => {
    setProfile({ displayName: "Gość", plan: "Profil lokalny usunięty" });
    notify({ tone: "good", text: "Profil Anny został usunięty z tego urządzenia." });
  };

  const chooseProject = async () => {
    setIsBusy(true);
    try {
      const selected = await open({ directory: true, multiple: false, title: "Wybierz katalog projektu" });
      if (!selected || Array.isArray(selected)) return;
      const inspected = await tryInvoke<Project>("inspect_project", { path: selected });
      const contextFiles = await tryInvoke<Array<{ name: string; path: string; content: string }>>("read_project_context", { path: selected });
      const project: Project = inspected ?? {
        id: `project-${Date.now()}`,
        name: selected.split("/").filter(Boolean).pop() ?? "Nowy projekt",
        path: selected,
        kind: "folder",
        status: "active",
        files: 0,
        lastActivity: "teraz",
      };
      const importedInstructions = contextFiles?.map((file) => `## ${file.name}\n\n${file.content}`).join("\n\n") ?? "";
      const importedKnowledge = importedInstructions ? { ...emptyKnowledge, instructions: importedInstructions, sources: contextFiles?.map((file) => ({ id: `source-${file.name}`, name: file.name, path: file.path, kind: "file" as const, addedAt: new Date().toISOString() })) ?? [] } : emptyKnowledge;
      const next = { ...snapshot, projects: [project, ...snapshot.projects], activeProjectId: project.id, knowledge: { ...snapshot.knowledge, [project.id]: importedKnowledge } };
      updateSnapshot(next);
      notify({ tone: "good", text: `Dodano projekt „${project.name}”.` });
    } catch {
      notify({ tone: "warn", text: "Wybór katalogu wymaga uruchomienia aplikacji AgentOS, nie podglądu Vite." });
    } finally {
      setIsBusy(false);
    }
  };

  const startTask = async () => {
    if (taskScope === "project" && !snapshot.projects.length) {
      notify({ tone: "warn", text: "Najpierw dodaj projekt, aby uruchomić zadanie." });
      setView("projects");
      return;
    }
    if (!activeProvider) {
      notify({ tone: "warn", text: "Najpierw dodaj albo wykryj dostawcę modelu." });
      setView("models");
      return;
    }
    const title = task.trim() || (
      taskScope === "chat"
        ? "Odpowiedz na pytanie użytkownika"
        : taskScope === "analysis"
          ? "Przeanalizuj materiały i przedstaw najważniejsze wnioski"
          : "Przeanalizuj projekt i zaproponuj następny krok"
    );
    const activeTaskCount = snapshot.runs.filter((run) => run.status === "running").length;
    if (activeTaskCount >= Math.max(1, snapshot.routing.maxParallelTasks ?? 4)) {
      queuedTaskRef.current.push({ title, scope: taskScope });
      setTask("");
      notify({ tone: "warn", text: `Zadanie dodano do kolejki. Uruchomi się po zwolnieniu miejsca (${snapshot.routing.maxParallelTasks ?? 4} równoległe sesje).` });
      setView("activity");
      return;
    }
    const route = chooseProvider(snapshot.providers, activeProvider, modelOffers, snapshot.routing, taskScope, title);
    const routedProvider = route.provider;
    if (!routedProvider) {
      notify({ tone: "warn", text: "Nie ma dostawcy zgodnego z tym zadaniem. Podłącz model albo zmień politykę routingu." });
      setView("models");
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const spentToday = snapshot.usageLedger.filter((entry) => entry.createdAt.slice(0, 10) === today).reduce((sum, entry) => sum + entry.estimatedCost, 0);
    if (routedProvider.kind !== "ollama" && snapshot.routing.dailyBudget > 0 && spentToday + route.estimatedCost > snapshot.routing.dailyBudget) {
      notify({ tone: "warn", text: `Budżet dzienny zostałby przekroczony (${spentToday.toFixed(4)} + ${route.estimatedCost.toFixed(4)} USD). AgentOS nie uruchomił płatnego zadania.` });
      setView("models");
      return;
    }
    const initialMessages: ChatMessage[] = [{ role: "user", content: title }];
    const newRun: Run = {
      id: `run-${Date.now()}`,
      title,
      projectId: activeProject.id,
      status: "running",
      started: "teraz",
      progress: 12,
      timeline: [{
        id: "new-plan",
        kind: "plan",
        title: taskScope === "chat" ? "Przygotowanie odpowiedzi" : taskScope === "analysis" ? "Plan analizy" : "Plan pracy nad projektem",
        description: "AgentOS dobiera kontekst, model i uprawnienia do tego zadania",
        status: "running",
        time: "teraz",
      }],
      messages: initialMessages,
      scope: taskScope,
      providerId: routedProvider.id,
      model: routedProvider.model,
      routingReason: route.reason,
      estimatedCost: route.estimatedCost,
    };
    let isolatedWorktree: string | null = null;
    if (taskScope === "project" && permissions.isolateSessions) {
      isolatedWorktree = await tryInvoke<string>("prepare_worktree", { projectPath: activeProject.path, runId: newRun.id });
    }
    if (isolatedWorktree) newRun.worktreePath = isolatedWorktree;
    const checkpoint = taskScope === "project"
      ? await tryInvoke<{ runId: string; projectPath: string }>("create_checkpoint", { projectPath: activeProject.path, runId: newRun.id, worktreePath: isolatedWorktree })
      : null;
    if (checkpoint) newRun.checkpointPath = `${activeProject.path}/.agentos/checkpoints/${newRun.id}.json`;
    const next = { ...snapshot, runs: [newRun, ...snapshot.runs], activeRunId: newRun.id };
    updateSnapshot(next);
    setTask("");
    setView("run");
    notify({ tone: "good", text: "Uruchomiono zadanie w izolowanej sesji." });

    try {
      const modelResult = await invoke<string>("run_model", {
        providerId: routedProvider.id,
        model: routedProvider.model,
        endpoint: routedProvider.endpoint,
        providerKind: routedProvider.kind,
        prompt: buildTaskPrompt(title, activeKnowledge, snapshot.globalMemory, taskScope === "project" ? activeProject.path : "", taskScope),
        projectPath: taskScope === "project" ? activeProject.path : "",
        mode: taskScope,
      });
      setSnapshot((current) => ({
        ...current,
        runs: current.runs.map((run) =>
          run.id === newRun.id && run.status === "running"
            ? {
                ...run,
                status: "done",
                progress: 100,
                response: modelResult,
                messages: [...initialMessages, { role: "assistant", content: modelResult }],
                evidence: [
                  { id: `evidence-${newRun.id}-response`, kind: "response", title: "Odpowiedź modelu", detail: `${modelResult.length} znaków z ${routedProvider.name}`, createdAt: new Date().toISOString() },
                  ...(run.checkpointPath ? [{ id: `evidence-${newRun.id}-checkpoint`, kind: "checkpoint" as const, title: "Checkpoint sesji", detail: run.checkpointPath, createdAt: new Date().toISOString() }] : []),
                  ...(run.worktreePath ? [{ id: `evidence-${newRun.id}-worktree`, kind: "worktree" as const, title: "Izolowany worktree", detail: run.worktreePath, createdAt: new Date().toISOString() }] : []),
                ] satisfies EvidenceArtifact[],
                timeline: run.timeline.map((item) =>
                  item.id === "new-plan"
                    ? { ...item, status: "done", description: "Odpowiedź jest gotowa." }
                    : item,
                ),
              }
            : run,
        ),
      }));
      setSnapshot((current) => ({
        ...current,
        usageLedger: current.runs.some((run) => run.id === newRun.id && run.status === "done") ? [{
          id: `usage-${Date.now()}`,
          runId: newRun.id,
          providerId: routedProvider.id,
          model: routedProvider.model,
          estimatedInputTokens: Math.ceil(title.length / 4),
          estimatedOutputTokens: Math.ceil(modelResult.length / 4),
          estimatedCost: route.estimatedCost,
          reason: route.reason,
          createdAt: new Date().toISOString(),
        }, ...current.usageLedger].slice(0, 500) : current.usageLedger,
      }));
      notify({ tone: "good", text: `Odpowiedź otrzymana z ${routedProvider.name}. ${route.reason}.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingKey = message.includes("Brak klucza API") || message.includes("No entry");
      const fallbackProvider = snapshot.routing.allowFallback
        ? snapshot.providers.find((provider) => provider.id !== routedProvider.id && (provider.kind === "ollama" || provider.hasKey))
        : undefined;
      if (fallbackProvider) {
        try {
          const fallbackResult = await invoke<string>("run_model", {
            providerId: fallbackProvider.id,
            model: fallbackProvider.model,
            endpoint: fallbackProvider.endpoint,
            providerKind: fallbackProvider.kind,
            prompt: buildTaskPrompt(title, activeKnowledge, snapshot.globalMemory, taskScope === "project" ? activeProject.path : "", taskScope),
            projectPath: taskScope === "project" ? activeProject.path : "",
            mode: taskScope,
          });
          setSnapshot((current) => ({
            ...current,
            runs: current.runs.map((run) => run.id === newRun.id && run.status === "running" ? {
              ...run,
              status: "done",
              progress: 100,
              response: fallbackResult,
              providerId: fallbackProvider.id,
              model: fallbackProvider.model,
              routingReason: `fallback po błędzie ${routedProvider.name}`,
              messages: [...initialMessages, { role: "assistant", content: fallbackResult }],
              timeline: run.timeline.map((item) => item.id === "new-plan" ? { ...item, status: "done", description: `Odpowiedź z fallbacku: ${fallbackProvider.name}.` } : item),
            } : run),
          }));
          notify({ tone: "warn", text: `${routedProvider.name} nie odpowiedział. AgentOS użył fallbacku ${fallbackProvider.name}.` });
          return;
        } catch {
          // Continue with the original error so the user sees the actual failure.
        }
      }
      setSnapshot((current) => ({
        ...current,
        runs: current.runs.map((run) => run.id === newRun.id && run.status === "running"
          ? {
              ...run,
              status: "failed",
              progress: 12,
              timeline: run.timeline.map((item) => item.id === "new-plan"
                ? { ...item, status: "waiting", description: message }
                : item),
            }
          : run),
      }));
      notify({
        tone: "bad",
        text: missingKey
          ? `${activeProvider.name} nie ma dostępnego klucza w Keychain. Otwórz Modele, zapisz klucz ponownie i zostaw tego dostawcę wybranego.`
          : `Nie udało się wywołać ${activeProvider.name}: ${message}`,
      });
    }
  };

  useEffect(() => {
    const queued = queuedTaskRef.current[0];
    const activeTaskCount = snapshot.runs.filter((run) => run.status === "running").length;
    if (!queued || activeTaskCount >= Math.max(1, snapshot.routing.maxParallelTasks ?? 4)) return;
    queuedTaskRef.current.shift();
    setTaskScope(queued.scope);
    setTask(queued.title);
    setAutoLaunchQueuedTask(true);
  }, [snapshot.runs, snapshot.routing.maxParallelTasks]);

  useEffect(() => {
    if (!autoLaunchQueuedTask) return;
    setAutoLaunchQueuedTask(false);
    void startTask();
  }, [autoLaunchQueuedTask, task, taskScope]);

  const sendFollowUp = async () => {
    const followUp = followUpTask.trim();
    if (!followUp || !activeRun || !activeProvider || activeRun.id === emptyRun.id) return;
    const previousMessages = activeRun.messages ?? (activeRun.response
      ? [{ role: "user", content: activeRun.title }, { role: "assistant", content: activeRun.response }]
      : []);
    const nextMessages: ChatMessage[] = [...previousMessages, { role: "user", content: followUp }];
    setFollowUpTask("");
    setSnapshot((current) => ({
      ...current,
      runs: current.runs.map((run) => run.id === activeRun.id
        ? { ...run, status: "running", progress: 55, messages: nextMessages }
        : run),
    }));
    try {
      const modelResult = await invoke<string>("run_model", {
        providerId: activeProvider.id,
        model: activeProvider.model,
        endpoint: activeProvider.endpoint,
        providerKind: activeProvider.kind,
        prompt: buildTaskPrompt(conversationPrompt(nextMessages), activeKnowledge, snapshot.globalMemory, activeRun.scope === "project" ? activeProject.path : "", activeRun.scope ?? "chat"),
        projectPath: activeRun.scope === "project" ? activeProject.path : "",
        mode: activeRun.scope ?? "chat",
      });
      setSnapshot((current) => ({
        ...current,
        runs: current.runs.map((run) => run.id === activeRun.id && run.status === "running"
          ? {
              ...run,
              status: "done",
              progress: 100,
              response: modelResult,
              providerId: activeProvider.id,
              model: activeProvider.model,
              routingReason: "model wybrany dla kolejnego pytania",
              messages: [...nextMessages, { role: "assistant", content: modelResult }],
              timeline: run.timeline.map((item) => item.id === "new-plan"
                ? { ...item, status: "done", description: "Odpowiedź jest gotowa. Możesz dopytać ponownie." }
                : item),
            }
          : run),
      }));
      notify({ tone: "good", text: `Odpowiedź otrzymana z ${activeProvider.name}.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSnapshot((current) => ({
        ...current,
        runs: current.runs.map((run) => run.id === activeRun.id && run.status === "running"
          ? { ...run, status: "failed", progress: 55, messages: nextMessages }
          : run),
      }));
      notify({ tone: "bad", text: `Nie udało się dopytać modelu: ${message}` });
    }
  };

  const fetchNetwork = async () => {
    if (!permissions.network) {
      notify({ tone: "warn", text: "Dostęp do sieci jest wyłączony. Włącz go w przełączniku uprawnień." });
      return;
    }
    setIsBusy(true);
    const result = await tryInvoke<string>("web_fetch", { url: networkUrl });
    setNetworkResult(result ?? "Nie udało się pobrać adresu. Uruchom aplikację Tauri i sprawdź politykę adresu.");
    notify({ tone: result ? "good" : "warn", text: result ? "Odebrano odpowiedź z sieci." : "Fetch nie został wykonany — backend Tauri odrzucił lub nie obsłużył żądania." });
    setIsBusy(false);
  };

  const runComputerAction = async (action: string, target?: string) => {
    if (!permissions.computer) {
      notify({ tone: "warn", text: "Dostęp do komputera jest wyłączony. Włącz go w przełączniku uprawnień." });
      return;
    }
    setIsBusy(true);
    const result = await tryInvoke<string>("computer_action", { action, target: target ?? "", approved: true });
    notify({ tone: result ? "good" : "warn", text: result ?? "Akcja będzie dostępna po uruchomieniu zbudowanej aplikacji macOS." });
    setIsBusy(false);
  };

  const addProvider = async () => {
    if (!providerDraft.name || !providerDraft.model || !providerDraft.endpoint) {
      notify({ tone: "warn", text: "Uzupełnij nazwę, model i endpoint." });
      return;
    }
    const existing = editingProviderId ? snapshot.providers.find((item) => item.id === editingProviderId) : undefined;
    const provider: Provider = {
      id: editingProviderId ?? (providerDraft.kind === "openrouter" ? "openrouter" : `custom-${Date.now()}`),
      name: providerDraft.name,
      kind: providerDraft.kind,
      model: providerDraft.model,
      endpoint: providerDraft.endpoint,
      hasKey: Boolean(providerDraft.key) || Boolean(existing?.hasKey),
      latency: existing?.latency ?? "do oceny",
      tone: existing?.tone ?? "cyan",
    };
    const providers = snapshot.providers.some((item) => item.id === provider.id)
      ? snapshot.providers.map((item) => item.id === provider.id ? provider : item)
      : [...snapshot.providers, provider];
    let keyStatus: ProviderKeyStatus;
    try {
      keyStatus = await invoke<ProviderKeyStatus>("save_provider", { provider, apiKey: providerDraft.key });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify({ tone: "bad", text: `Nie zapisano konfiguracji ${provider.name}: ${message}` });
      return;
    }
    const persistedProvider = { ...provider, hasKey: keyStatus.hasKey };
    const persistedProviders = providers.map((item) => item.id === provider.id ? persistedProvider : item);
    updateSnapshot({ ...snapshot, providers: persistedProviders });
    setSelectedProviderId(provider.id);
    setEditingProviderId(null);
    setProviderDraft({ name: "Nowy dostawca", kind: "custom", model: "", endpoint: "", key: "" });
    setShowProviderForm(false);
    notify({ tone: "good", text: keyStatus.hasKey ? `Podłączono ${provider.name}. Klucz jest zapisany w macOS Keychain.` : `Zapisano ${provider.name} bez klucza.` });
  };

  const configureProvider = (provider: Provider) => {
    setEditingProviderId(provider.id);
    setSelectedProviderId(provider.id);
    setProviderDraft({
      name: provider.name.replace(" · katalog", ""),
      kind: provider.kind,
      model: provider.model,
      endpoint: provider.endpoint,
      key: "",
    });
    setShowProviderForm(true);
  };

  const discoverModelOffers = async () => {
    setDiscoveringModels(true);
    const offers = await tryInvoke<ModelOffer[]>("discover_model_offers");
    if (!offers) {
      notify({ tone: "warn", text: "Nie udało się pobrać katalogu live. W aplikacji macOS dodaj klucz OpenRouter, aby odblokować katalog cen i modeli." });
    } else {
      setModelOffers(offers);
      notify({ tone: "good", text: `Znaleziono ${offers.length} ofert modeli. Posortowano od najtańszych.` });
    }
    setDiscoveringModels(false);
  };

  const useModelOffer = (offer: ModelOffer) => {
    const openrouter = snapshot.providers.find((provider) => provider.id === "openrouter");
    const nextProviders = openrouter
      ? snapshot.providers.map((provider) => provider.id === "openrouter" ? { ...provider, model: offer.id, name: `OpenRouter · ${offer.name}`, inputPricePerMillion: offer.inputPrice, outputPricePerMillion: offer.outputPrice, capabilities: offer.modalities } : provider)
      : [...snapshot.providers, {
          id: "openrouter",
          name: `OpenRouter · ${offer.name}`,
          kind: "openrouter" as const,
          model: offer.id,
          endpoint: "https://openrouter.ai/api/v1/chat/completions",
          hasKey: false,
          latency: "auto-routing",
          tone: "cyan" as const,
          inputPricePerMillion: offer.inputPrice,
          outputPricePerMillion: offer.outputPrice,
          capabilities: offer.modalities,
        }];
    updateSnapshot({ ...snapshot, providers: nextProviders });
    setSelectedProviderId("openrouter");
    notify({ tone: "good", text: `Router użyje teraz ${offer.name}.` });
  };

  const selectProject = async (project: Project) => {
    const contextFiles = await tryInvoke<Array<{ name: string; path: string; content: string }>>("read_project_context", { path: project.path });
    const current = projectKnowledge(snapshot, project.id);
    const importedInstructions = contextFiles?.map((file) => `## ${file.name}\n\n${file.content}`).join("\n\n") ?? "";
    const importedSources = contextFiles?.map((file) => ({ id: `source-${file.name}`, name: file.name, path: file.path, kind: "file" as const, addedAt: new Date().toISOString() })) ?? [];
    const next = { ...snapshot, activeProjectId: project.id, knowledge: { ...snapshot.knowledge, [project.id]: importedInstructions ? { ...current, instructions: importedInstructions, sources: [...importedSources, ...current.sources.filter((source) => !importedSources.some((item) => item.path === source.path))] } : current } };
    updateSnapshot(next);
    notify({ tone: "good", text: `Aktywny projekt: ${project.name}. Wczytano przenośny kontekst.` });
  };

  const renameProject = (projectId: string, name: string) => {
    const nextName = name.trim();
    if (!nextName) {
      notify({ tone: "warn", text: "Nazwa projektu nie może być pusta." });
      return;
    }
    updateSnapshot({
      ...snapshot,
      projects: snapshot.projects.map((project) => project.id === projectId ? { ...project, name: nextName } : project),
    });
    notify({ tone: "good", text: "Nazwa projektu została zmieniona." });
  };

  const deleteProject = (project: Project) => {
    if (!window.confirm(`Usunąć projekt „${project.name}” z AgentOS? Pliki na dysku pozostaną bez zmian.`)) return;
    const projects = snapshot.projects.filter((item) => item.id !== project.id);
    const nextActiveProjectId = snapshot.activeProjectId === project.id ? (projects[0]?.id ?? "") : snapshot.activeProjectId;
    updateSnapshot({ ...snapshot, projects, activeProjectId: nextActiveProjectId });
    notify({ tone: "good", text: `Usunięto „${project.name}” z listy AgentOS. Pliki nie zostały skasowane.` });
  };

  const selectRun = (run: Run) => {
    const next = { ...snapshot, activeRunId: run.id, activeProjectId: run.projectId };
    updateSnapshot(next);
    setView("run");
  };

  const recoverRun = async (run: Run) => {
    if (!run.checkpointPath || !activeProject.path) {
      notify({ tone: "warn", text: "Ta sesja nie ma checkpointu projektu do odzyskania." });
      return;
    }
    const recovered = await tryInvoke<{ runId: string; projectPath: string; worktreePath?: string }>("recover_checkpoint", { projectPath: activeProject.path, runId: run.id });
    notify(recovered ? { tone: "good", text: recovered.worktreePath ? `Checkpoint jest gotowy w izolowanym worktree: ${recovered.worktreePath}` : "Checkpoint jest poprawny i gotowy do odzyskania." } : { tone: "bad", text: "Nie udało się zweryfikować checkpointu. Pliki nie zostały zmienione." });
  };

  const stopRun = (runId: string) => {
    updateSnapshot({ ...snapshot, runs: snapshot.runs.map((run) => run.id === runId && run.status === "running" ? { ...run, status: "failed", progress: Math.min(run.progress, 99), timeline: run.timeline.map((item) => item.status === "running" ? { ...item, status: "waiting", description: "Zatrzymano przez użytkownika." } : item) } : run) });
    notify({ tone: "warn", text: "Sesja została zatrzymana przez użytkownika." });
  };

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        projects={snapshot.projects}
        activeProjectId={activeProject.id}
        onView={setView}
        onProject={selectProject}
        onNewProject={chooseProject}
        profile={profile}
        onProfileSave={updateProfile}
        onProfileDelete={removeProfile}
      />
      <main className="main-column">
        <header className="topbar">
          <div className="breadcrumb">
            <div className="crumb-icon"><Folder size={15} /></div>
            <span>{activeProject.name}</span>
            <ChevronDown size={14} className="muted" />
          </div>
          <div className="topbar-actions">
            <div className="secure-state"><ShieldCheck size={14} /> lokalnie kontrolowane</div>
            <button className="icon-button" aria-label="Szukaj"><Search size={17} /></button>
            <button className="icon-button" aria-label="Więcej"><MoreHorizontal size={18} /></button>
            <div className="avatar">AK</div>
          </div>
        </header>

        {notice && <div className={`notice notice-${notice.tone}`}><span>{notice.text}</span><button onClick={() => setNotice(null)}><X size={14} /></button></div>}
        {view === "run" && activeRun.checkpointPath && <RecoveryBanner run={activeRun} onRecover={() => void recoverRun(activeRun)} onExportEvidence={() => exportRunEvidence(activeRun)} />}

        {view === "overview" && (
          <Overview
            snapshot={snapshot}
            activeProject={activeProject}
            activeRun={activeRun}
            task={task}
            setTask={setTask}
            taskScope={taskScope}
            setTaskScope={setTaskScope}
            startTask={startTask}
            selectRun={selectRun}
            setView={setView}
          />
        )}
        {view === "activity" && <ActivityView runs={snapshot.runs} projects={snapshot.projects} onSelect={selectRun} />}
        {view === "run" && (
          <RunView
            run={activeRun}
            project={activeProject}
            onStart={startTask}
            onStop={() => stopRun(activeRun.id)}
            onView={setView}
            onComputer={() => setView("computer")}
            followUpTask={followUpTask}
            setFollowUpTask={setFollowUpTask}
            onFollowUp={() => void sendFollowUp()}
            providers={snapshot.providers}
            selectedProviderId={selectedProviderId}
            onProviderChange={setSelectedProviderId}
            onRecover={() => void recoverRun(activeRun)}
            onExportEvidence={() => exportRunEvidence(activeRun)}
          />
        )}
        {view === "projects" && (
          <ProjectsView projects={snapshot.projects} activeProjectId={activeProject.id} onProject={selectProject} onNew={chooseProject} onRename={renameProject} onDelete={deleteProject} />
        )}
        {view === "models" && (
          <ModelsView
            providers={snapshot.providers}
            selectedProviderId={selectedProviderId}
            setSelectedProviderId={setSelectedProviderId}
            showForm={showProviderForm}
            setShowForm={setShowProviderForm}
            draft={providerDraft}
            setDraft={setProviderDraft}
            addProvider={addProvider}
            offers={modelOffers}
            discoverOffers={discoverModelOffers}
            discovering={discoveringModels}
            onUseOffer={useModelOffer}
            onConfigureProvider={configureProvider}
            routing={snapshot.routing}
            usageLedger={snapshot.usageLedger}
            onRoutingChange={(routing) => setSnapshot((current) => ({ ...current, routing }))}
          />
        )}
        {view === "workspace" && <WorkspaceView project={activeProject} knowledge={activeKnowledge} globalMemory={snapshot.globalMemory} providers={snapshot.providers} onKnowledgeChange={updateActiveKnowledge} onAddSource={() => void addProjectSource()} onAddMemory={addMemory} onAddAgent={addAgent} onExport={exportProjectContext} onImport={(file) => void importProjectContext(file)} />}
        {view === "workspace" && <SkillImportBar project={activeProject} onImported={(skill) => updateActiveKnowledge({ ...activeKnowledge, skills: [...(activeKnowledge.skills ?? []).filter((item) => item.id !== skill.id), skill] })} />}
        {view === "workspace" && <SkillPanel project={activeProject} skills={activeKnowledge.skills ?? []} onChange={(skills) => updateActiveKnowledge({ ...activeKnowledge, skills })} />}
        {view === "workspace" && <PortableContextPanel project={activeProject} knowledge={activeKnowledge} />}
        {view === "computer" && <ComputerView activeProject={activeProject} runAction={runComputerAction} busy={isBusy} enabled={permissions.computer} onToggle={() => updatePermission("computer")} />}
        {view === "settings" && (
          <SettingsView
            networkUrl={networkUrl}
            setNetworkUrl={setNetworkUrl}
            networkResult={networkResult}
            fetchNetwork={fetchNetwork}
            busy={isBusy}
            permissions={permissions}
            onToggle={updatePermission}
          />
        )}
      </main>
      <aside className="right-rail">
        <EvidenceRail run={activeRun} setView={setView} permissions={permissions} onToggle={updatePermission} />
      </aside>
    </div>
  );
}

function Sidebar({ view, projects, activeProjectId, onView, onProject, onNewProject, profile, onProfileSave, onProfileDelete }: { view: View; projects: Project[]; activeProjectId: string; onView: (view: View) => void; onProject: (project: Project) => void; onNewProject: () => void; profile: Profile; onProfileSave: (profile: Profile) => boolean; onProfileDelete: () => void }) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [draft, setDraft] = useState(profile);
  const nav: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
    { id: "overview", label: "Centrum pracy", icon: LayoutDashboard },
    { id: "activity", label: "Zadania w tle", icon: Activity },
    { id: "projects", label: "Projekty", icon: FolderOpen },
    { id: "models", label: "Modele i routing", icon: Cpu },
    { id: "workspace", label: "Wiedza i agenci", icon: Brain },
    { id: "computer", label: "Komputer", icon: Laptop },
    { id: "settings", label: "Ustawienia", icon: Settings },
  ];
  return (
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark" src="/agentos-badge.png" alt="AgentOS" /><span className="brand-agent">Agent</span><span className="brand-os">OS</span><div className="brand-pulse" /></div>
      <div className="sidebar-head"><span>Przestrzeń robocza</span><button className="icon-button small" onClick={onNewProject} aria-label="Dodaj projekt"><Plus size={15} /></button></div>
      <nav className="nav-list">
        {nav.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id ? "selected" : ""}`} onClick={() => onView(id)}><Icon size={17} /><span>{label}</span>{id === "computer" && <span className="nav-status-dot" />}</button>)}
      </nav>
      <div className="sidebar-section-label"><span>Projekty</span><button className="plain-button" onClick={onNewProject}><Plus size={14} /></button></div>
      <div className="project-list">
        {projects.map((project) => <button key={project.id} className={`project-item ${activeProjectId === project.id ? "active" : ""}`} onClick={() => onProject(project)}><span className="folder-mark"><Folder size={16} /></span><span className="project-name">{project.name}</span><span className={`project-dot ${project.status}`} /></button>)}
      </div>
      <div className="sidebar-bottom">
        <div className="local-card"><div className="local-card-icon"><LockKeyhole size={15} /></div><div><strong>Tryb lokalny</strong><span>klucze nie opuszczają Maca</span></div></div>
        <div className="sidebar-user-wrap">
          <button className="sidebar-user" onClick={() => { setDraft(profile); setProfileOpen((open) => !open); }} aria-expanded={profileOpen}>
            <div className="avatar">{profile.displayName.slice(0, 2).toUpperCase()}</div>
            <div><strong>{profile.displayName}</strong><span>{profile.plan}</span></div>
            <MoreHorizontal size={16} className="muted" />
          </button>
          {profileOpen && <div className="profile-panel">
            <div className="profile-panel-head"><strong>Profil lokalny</strong><button className="icon-button small" onClick={() => setProfileOpen(false)} aria-label="Zamknij profil"><X size={14} /></button></div>
            <label>Nazwa wyświetlana<input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
            <label>Opis<input value={draft.plan} onChange={(event) => setDraft({ ...draft, plan: event.target.value })} /></label>
            <div className="profile-actions"><button className="primary-button small-button" onClick={() => { if (onProfileSave(draft)) setProfileOpen(false); }}><Check size={13} /> Zapisz</button><button className="danger-button" onClick={() => { onProfileDelete(); setProfileOpen(false); }}><Trash2 size={13} /> Usuń profil</button></div>
          </div>}
        </div>
      </div>
    </aside>
  );
}

function Overview({ snapshot, activeProject, activeRun, task, setTask, taskScope, setTaskScope, startTask, selectRun, setView }: { snapshot: AppSnapshot; activeProject: Project; activeRun: Run; task: string; setTask: (value: string) => void; taskScope: TaskScope; setTaskScope: (value: TaskScope) => void; startTask: () => void; selectRun: (run: Run) => void; setView: (view: View) => void }) {
  const currentRuns = snapshot.runs.slice(0, 3);
  return (
    <div className="content overview-content">
      <section className="hero-block"><div><span className="eyebrow"><Sparkles size={13} /> centrum intencji</span><h1>Co chcesz dzisiaj<br /><em>doprowadzić do końca?</em></h1><p>Opisz rezultat. AgentOS dobierze model, narzędzia i poziom autonomii, a potem pokaże Ci dowody zamiast obietnic.</p></div><div className="hero-orbit"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit-core"><Command size={22} /></div><span className="orbit-label">intencja</span><span className="orbit-label label-two">dowód</span></div></section>
      <section className="intent-box"><div className="intent-mode"><button className={taskScope === "chat" ? "active" : ""} onClick={() => setTaskScope("chat")}><MessageSquare size={14} /> Zapytaj</button><button className={taskScope === "project" ? "active" : ""} onClick={() => setTaskScope("project")}><Folder size={14} /> Zbuduj</button><button className={taskScope === "analysis" ? "active" : ""} onClick={() => setTaskScope("analysis")}><Search size={14} /> Przeanalizuj</button></div><div className="intent-icon"><Zap size={19} /></div><textarea value={task} onChange={(event) => setTask(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void startTask(); }} placeholder={taskScope === "chat" ? "Zapytaj o cokolwiek — np. ile jest 2 × 2?" : taskScope === "analysis" ? "Opisz, co mam przeanalizować: dane, tekst, kod, źródła lub problem..." : "Opisz, co mam zbudować albo zmienić w projekcie..."} rows={2} /><button className="primary-button intent-submit" onClick={() => void startTask()}><Play size={15} fill="currentColor" /> {taskScope === "chat" ? "Wyślij wiadomość" : taskScope === "analysis" ? "Uruchom analizę" : "Uruchom budowę"}</button><div className="intent-meta"><span>{taskScope === "chat" ? <><MessageSquare size={13} /> bez projektu</> : <><Folder size={13} /> {activeProject.name}</>}</span><span><SlidersHorizontal size={13} /> router automatyczny</span><span><ShieldCheck size={13} /> zatwierdzanie działań</span><kbd>⌘ ↵</kbd></div></section>
      <section className="quick-grid"><button onClick={() => { setTask("Zbadaj najnowsze informacje w sieci i przygotuj źródłowy brief"); void startTask(); }}><div className="quick-icon cyan"><Globe2 size={17} /></div><div><strong>Research z dowodami</strong><span>Sieć · źródła · synteza</span></div><ArrowUpRight size={15} className="quick-arrow" /></button><button onClick={() => { setTask("Przejrzyj projekt i znajdź najważniejsze ryzyko regresji"); void startTask(); }}><div className="quick-icon violet"><Code2 size={17} /></div><div><strong>Audyt projektu</strong><span>Pliki · testy · warianty</span></div><ArrowUpRight size={15} className="quick-arrow" /></button><button onClick={() => setView("computer")}><div className="quick-icon amber"><Laptop size={17} /></div><div><strong>Sterowanie komputerem</strong><span>Akcje z zatwierdzeniem</span></div><ArrowUpRight size={15} className="quick-arrow" /></button></section>
      <section className="section-heading"><div><span className="eyebrow">pulpit</span><h2>Ostatnia praca</h2></div><button className="ghost-button" onClick={() => setView("run")}>Zobacz aktywne <ArrowUpRight size={14} /></button></section>
      <section className="run-list">{currentRuns.map((run) => <button className="run-row" key={run.id} onClick={() => selectRun(run)}><div className={`run-status ${run.status}`}><Activity size={15} /></div><div className="run-main"><strong>{run.title}</strong><span>{snapshot.projects.find((project) => project.id === run.projectId)?.name} · start {run.started}</span></div><div className="run-progress"><div className="progress-track"><div className={`progress-fill ${run.status}`} style={{ width: `${run.progress}%` }} /></div><span>{run.status === "failed" ? "Błąd" : `${run.progress}%`}</span></div><span className={`status-text ${run.status}`}>{statusLabel(run.status)}</span><ArrowUpRight size={15} className="muted" /></button>)}</section>
      <section className="bottom-stat-grid"><MiniStat icon={<Timer size={16} />} label="Zaoszczędzony czas" value="4h 26m" detail="w tym tygodniu" tone="cyan" /><MiniStat icon={<Network size={16} />} label="Modele aktywne" value={`${snapshot.providers.length}`} detail="4 dostawców" tone="violet" /><MiniStat icon={<ShieldCheck size={16} />} label="Zadania z dowodem" value="92%" detail="ostatnie 30 dni" tone="green" /></section>
    </div>
  );
}

function ActivityView({ runs, projects, onSelect }: { runs: Run[]; projects: Project[]; onSelect: (run: Run) => void }) {
  const active = runs.filter((run) => run.status === "running" || run.status === "waiting");
  return <div className="content page-content activity-content"><div className="page-header"><div><span className="eyebrow"><Activity size={13} /> praca równoległa</span><h1>Zadania w tle</h1><p>Każda sesja działa niezależnie. Możesz przełączać projekty i otwierać inne zadania bez zatrzymywania pracy w tle.</p></div><div className="permission-state"><Activity size={14} /> {active.length} aktywnych</div></div><div className="activity-summary"><div><strong>{active.length}</strong><span>aktywnych lub oczekujących</span></div><div><strong>{runs.filter((run) => run.status === "done").length}</strong><span>ukończonych sesji</span></div><div><strong>{runs.filter((run) => run.status === "failed").length}</strong><span>z błędem</span></div></div><section className="background-run-list">{runs.map((run) => { const project = projects.find((item) => item.id === run.projectId); return <button className="background-run" key={run.id} onClick={() => onSelect(run)}><div className={`background-run-icon ${run.status}`}><Activity size={16} /></div><div className="background-run-main"><strong>{run.title}</strong><span>{project?.name ?? "Bez projektu"} · {run.model ?? "router automatyczny"}</span><small>{run.routingReason ?? "sesja lokalna"}</small></div><div className="background-run-progress"><span className={`status-text ${run.status}`}>{statusLabel(run.status)}</span><div className="progress-track"><div className={`progress-fill ${run.status}`} style={{ width: `${run.progress}%` }} /></div><small>{run.progress}% · {run.estimatedCost ? `$${run.estimatedCost.toFixed(4)}` : "lokalnie"}</small></div><ArrowUpRight size={15} className="muted" /></button> })}{runs.length === 0 && <EmptyInline icon={<Activity size={20} />} title="Nie ma jeszcze zadań" description="Uruchom intencję z Centrum pracy, a sesja pojawi się tutaj." />}</section></div>;
}

function RunView({ run, project, onStart: startAction, onStop, onView, onComputer, followUpTask, setFollowUpTask, onFollowUp, providers, selectedProviderId, onProviderChange, onRecover, onExportEvidence }: { run: Run; project: Project; onStart: () => void; onStop: () => void; onView: (view: View) => void; onComputer: () => void; followUpTask: string; setFollowUpTask: (value: string) => void; onFollowUp: () => void; providers: Provider[]; selectedProviderId: string; onProviderChange: (value: string) => void; onRecover: () => void; onExportEvidence: () => void }) {
  const messages = run.messages ?? (run.response
    ? [{ role: "user" as const, content: run.title }, { role: "assistant" as const, content: run.response }]
    : []);
  const onStart = run.status === "running" ? onStop : startAction;
  return (
    <div className="content run-content"><div className="run-header"><div><div className="run-kicker"><span className={`project-dot ${project.status}`} /> {run.scope === "chat" ? "zapytanie" : run.scope === "analysis" ? "analiza" : project.name} <span className="slash">/</span> sesja {run.started}</div><h1>{run.title}</h1><p>{run.response ? "Odpowiedź jest gotowa. Możesz zadać kolejne pytanie w tej samej rozmowie." : "AgentOS przygotowuje odpowiedź i dobiera model do Twojego celu."}</p></div><div className="run-actions"><button className="icon-button"><MoreHorizontal size={18} /></button>{run.status === "running" && <button className="secondary-button" onClick={onStart}><Square size={14} fill="currentColor" /> Zatrzymaj</button>}</div></div><div className="stage-bar"><Stage state={run.status === "failed" ? "waiting" : "done"} label="Plan" /><span className="stage-line done" /><Stage state={run.status === "running" ? "running" : run.status === "failed" ? "waiting" : "done"} label="Odpowiedź" /><span className={`stage-line ${run.response ? "done" : ""}`} /><Stage state={run.response ? "done" : "queued"} label="Dowody" /></div><div className="run-layout"><div className="timeline">{messages.length > 0 && <div className="conversation-thread">{messages.map((message, index) => <article className={`conversation-message ${message.role}`} key={`${message.role}-${index}`}><div className="conversation-message-label">{message.role === "user" ? "Ty" : "AgentOS"}</div><div className="conversation-message-body">{message.content}</div></article>)}</div>}<div className="conversation-composer"><div className="composer-topline"><label>Model kolejnej odpowiedzi<select value={selectedProviderId} onChange={(event) => onProviderChange(event.target.value)} disabled={run.status === "running"}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}{provider.kind === "ollama" ? " · lokalny" : ""}</option>)}</select></label><span>{run.model ? `Ostatnio: ${run.model}` : "Router wybierze model automatycznie"}</span></div><textarea value={followUpTask} onChange={(event) => setFollowUpTask(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onFollowUp(); } }} placeholder="Napisz kolejne pytanie w tej rozmowie..." rows={2} disabled={run.status === "running"} /><button className="primary-button" onClick={onFollowUp} disabled={!followUpTask.trim() || run.status === "running"}><Send size={14} /> Wyślij</button><span>⌘ ↵ · wcześniejsze wiadomości zostają w kontekście tej sesji</span></div>{run.timeline.length === 0 ? <EmptyState title="Brak śladów tej sesji" description="Uruchom zadanie, aby AgentOS przygotował odpowiedź." action={onStart} /> : run.timeline.map((item, index) => <TimelineCard item={item} key={item.id} index={index} />)}</div><div className="run-side-summary"><div className="summary-title"><span>Stan wykonania</span><span className={`status-chip ${run.status}`}>{statusLabel(run.status)}</span></div><div className="big-progress"><span>{run.progress}%</span><div className="progress-track"><div className={`progress-fill ${run.status}`} style={{ width: `${run.progress}%` }} /></div></div><div className="summary-list"><SummaryRow icon={<Folder size={15} />} label="Projekt" value={project.name} /><SummaryRow icon={<Cpu size={15} />} label="Routing" value={run.routingReason ?? "automatyczny"} /><SummaryRow icon={<Globe2 size={15} />} label="Sieć" value="wymaga zgody" warn /><SummaryRow icon={<Laptop size={15} />} label="Komputer" value="wymaga zgody" warn /></div><button className="secondary-button wide" onClick={onComputer}><Laptop size={14} /> Zarządzaj uprawnieniami</button><button className="ghost-button wide" onClick={() => onView("models")}>Zmień strategię modeli <ArrowUpRight size={14} /></button></div></div></div>
  );
}

function TimelineCard({ item, index }: { item: TimelineItem; index: number }) {
  const Icon = item.kind === "plan" ? Check : item.kind === "agents" ? Network : item.kind === "tests" ? CircleCheck : item.kind === "evidence" ? Upload : CircleAlert;
  return <div className={`timeline-entry ${item.status}`}><div className={`timeline-marker marker-${item.kind}`}><Icon size={16} /></div><div className="timeline-card"><div className="timeline-top"><div><strong>{item.title}</strong>{item.description && <span>{item.description}</span>}</div><time>{item.time}</time></div>{item.details && <div className="timeline-details">{item.details.map((detail) => <div key={detail}><Check size={13} /> {detail}</div>)}</div>}</div></div>;
}

function RecoveryBanner({ run, onRecover, onExportEvidence }: { run: Run; onRecover: () => void; onExportEvidence?: () => void }) {
  return <section className="recovery-banner"><div><span className="eyebrow"><ShieldCheck size={13} /> odzyskiwanie sesji</span><strong>Checkpoint zapisany</strong><small>{run.worktreePath ? `Izolowany worktree: ${run.worktreePath}` : "Możesz sprawdzić integralność checkpointu przed wznowieniem."}</small></div><div className="page-header-actions"><button className="secondary-button" onClick={onRecover}><ShieldCheck size={14} /> Sprawdź checkpoint</button>{onExportEvidence && <button className="secondary-button" onClick={onExportEvidence}><Download size={14} /> Eksportuj dowody</button>}</div></section>;
}

function LegacyEvidenceRail({ run, setView, permissions, onToggle }: { run: Run; setView: (view: View) => void; permissions: PermissionState; onToggle: (key: keyof PermissionState) => void }) {
  return <div className="evidence-rail"><div className="rail-tabs"><button className="active">Dowody</button><button>Wymaga decyzji <span className="tab-count">1</span></button></div><div className="rail-body"><div className="rail-section"><div className="rail-section-head"><strong>Screenshot</strong><button className="icon-button small"><ArrowUpRight size={14} /></button></div><div className="screenshot-mock"><div className="mock-sidebar" /><div className="mock-content"><span /><span /><div className="mock-chart"><i /><i /><i /><i /><i /><i /></div><div className="mock-lines"><b /><b /><b /></div></div><div className="mock-cursor" /></div><small>raport-variant-a.png · 1440×1024</small></div><div className="rail-section"><div className="rail-section-head"><strong><Code2 size={15} /> Diff</strong><span className="diff-stat">+18 −7</span></div><div className="code-diff"><span className="code-path">src/pages/ReportPage.tsx</span><span>112  112  &lt;div className=&quot;header&quot;&gt;</span><span className="removed">113  − &lt;h1&gt;Raport&lt;/h1&gt;</span><span className="added">113  + &lt;h1 className=&quot;text-2xl&quot;&gt;Raport&lt;/h1&gt;</span><span>114  114  &lt;p className=&quot;text-gray&quot;&gt;</span><span className="removed">115  − Podsumowanie aktywności</span><span className="added">115  + Najnowsze dane i wnioski</span></div></div><div className="rail-section decision-box"><div className="decision-head"><CircleAlert size={16} /><strong>Wymaga decyzji</strong></div><p>Te zgody są teraz lokalne i naprawdę zmieniają dostęp agenta.</p><PermissionRow icon={<Globe2 size={15} />} label="Sieć" detail="Dostęp do stron internetowych" enabled={permissions.network} onToggle={() => onToggle("network")} /><PermissionRow icon={<Laptop size={15} />} label="Komputer" detail="Otwieranie aplikacji i plików" enabled={permissions.computer} onToggle={() => onToggle("computer")} /><button className="primary-button approval-button" onClick={() => setView("computer")}>Zarządzaj dostępem <ArrowUpRight size={15} /></button></div><div className="rail-footer"><ShieldCheck size={14} /> Dowody są podpisane przez lokalną sesję <span>·</span> {run.progress}% gotowe</div></div></div>;
}

function LegacyMockEvidenceRail({ run, setView, permissions, onToggle }: { run: Run; setView: (view: View) => void; permissions: PermissionState; onToggle: (key: keyof PermissionState) => void }) {
  return <div className="evidence-rail"><div className="rail-tabs"><button className="active">Sesja</button><button>Uprawnienia</button></div><div className="rail-body"><div className="rail-section"><div className="rail-section-head"><strong>Źródło odpowiedzi</strong><span className={`status-chip ${run.response ? "done" : run.status}`}>{run.response ? "gotowe" : statusLabel(run.status)}</span></div>{run.response ? <pre className="rail-response">{run.response}</pre> : <p className="rail-empty">Po otrzymaniu odpowiedzi pojawi się tu jej podgląd. AgentOS nie pokazuje makiet ani przykładowych artefaktów jako wyników pracy.</p>}</div><div className="rail-section decision-box"><div className="decision-head"><CircleAlert size={16} /><strong>Uprawnienia sesji</strong></div><p>Sieć i działania na komputerze są kontrolowane osobnymi przełącznikami.</p><PermissionRow icon={<Globe2 size={15} />} label="Sieć" detail="Dostęp do stron internetowych" enabled={permissions.network} onToggle={() => onToggle("network")} /><PermissionRow icon={<Laptop size={15} />} label="Komputer" detail="Otwieranie aplikacji i plików" enabled={permissions.computer} onToggle={() => onToggle("computer")} /><button className="primary-button approval-button" onClick={() => setView("computer")}>Zarządzaj dostępem <ArrowUpRight size={15} /></button></div><div className="rail-footer"><ShieldCheck size={14} /> Brak fikcyjnych dowodów · {run.progress}% gotowe</div></div></div>;
}

function EvidenceRail({ run, setView, permissions, onToggle }: { run: Run; setView: (view: View) => void; permissions: PermissionState; onToggle: (key: keyof PermissionState) => void }) {
  const evidence = run.evidence ?? [];
  return <div className="evidence-rail"><div className="rail-tabs"><button className="active">Sesja</button><button>Uprawnienia</button></div><div className="rail-body"><div className="rail-section"><div className="rail-section-head"><strong>Rzeczywiste dowody</strong><span className={`status-chip ${run.response ? "done" : run.status}`}>{run.response ? `${evidence.length} artefaktów` : statusLabel(run.status)}</span></div>{run.response ? <><pre className="rail-response">{run.response}</pre><div className="evidence-list">{evidence.map((item) => <div className="evidence-item" key={item.id}><strong>{item.title}</strong><span>{item.detail}</span></div>)}</div></> : <p className="rail-empty">Po otrzymaniu odpowiedzi pojawią się tu rzeczywiste artefakty sesji. AgentOS nie pokazuje przykładowych screenshotów ani fikcyjnych diffów.</p>}</div><div className="rail-section decision-box"><div className="decision-head"><CircleAlert size={16} /><strong>Uprawnienia sesji</strong></div><p>Sieć i działania na komputerze są kontrolowane osobnymi przełącznikami.</p><PermissionRow icon={<Globe2 size={15} />} label="Sieć" detail="Dostęp do stron internetowych" enabled={permissions.network} onToggle={() => onToggle("network")} /><PermissionRow icon={<Laptop size={15} />} label="Komputer" detail="Otwieranie aplikacji i plików" enabled={permissions.computer} onToggle={() => onToggle("computer")} /><button className="primary-button approval-button" onClick={() => setView("computer")}>Zarządzaj dostępem <ArrowUpRight size={15} /></button></div><div className="rail-footer"><ShieldCheck size={14} /> Tylko rzeczywiste artefakty · {run.progress}% gotowe</div></div></div>;
}

function ProjectsView({ projects, activeProjectId, onProject, onNew, onRename, onDelete }: { projects: Project[]; activeProjectId: string; onProject: (project: Project) => void; onNew: () => void; onRename: (projectId: string, name: string) => void; onDelete: (project: Project) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const beginRename = (project: Project) => {
    setEditingId(project.id);
    setDraftName(project.name);
  };

  return <div className="content page-content"><div className="page-header"><div><span className="eyebrow"><FolderOpen size={13} /> katalogi pracy</span><h1>Twoje projekty</h1><p>Każdy projekt ma własny kontekst, pamięć, zasady bezpieczeństwa i historię dowodów. Usunięcie z tej listy nie kasuje plików na dysku.</p></div><button className="primary-button" onClick={onNew}><Plus size={15} /> Dodaj katalog</button></div><div className="project-card-grid">{projects.map((project) => <article className={`project-card ${activeProjectId === project.id ? "active" : ""}`} key={project.id}>
    <button className="project-card-main" onClick={() => onProject(project)}>
      <div className="project-card-top"><div className="project-card-icon"><Folder size={20} /></div><span className={`status-chip ${project.status}`}>{statusLabel(project.status)}</span></div>
      {editingId === project.id ? <input className="project-name-input" autoFocus value={draftName} onChange={(event) => setDraftName(event.target.value)} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Enter") { onRename(project.id, draftName); setEditingId(null); } if (event.key === "Escape") setEditingId(null); }} /> : <strong>{project.name}</strong>}
      <span className="project-path">{project.path}</span><div className="project-card-meta"><span>{project.files} plików</span><span>ostatnio {project.lastActivity}</span></div>
    </button>
    <div className="project-card-actions">{editingId === project.id ? <><button className="ghost-button" onClick={() => { onRename(project.id, draftName); setEditingId(null); }}><Check size={13} /> Zapisz</button><button className="ghost-button" onClick={() => setEditingId(null)}>Anuluj</button></> : <button className="ghost-button" onClick={() => beginRename(project)}><Pencil size={13} /> Zmień nazwę</button>}<button className="ghost-button danger-text" onClick={() => onDelete(project)}><Trash2 size={13} /> Usuń z listy</button></div>
  </article>)}{projects.length === 0 && <div className="empty-projects"><FolderOpen size={24} /><strong>Nie ma tu jeszcze żadnego projektu</strong><span>Dodaj własny katalog — przykładowe projekty można bezpiecznie usuwać.</span><button className="primary-button" onClick={onNew}><Plus size={14} /> Dodaj katalog</button></div>}<button className="project-card add-card" onClick={onNew}><Plus size={20} /><strong>Dodaj nowy projekt</strong><span>Wybierz katalog na Macu</span></button></div></div>;
}

function WorkspaceView({ project, knowledge, globalMemory, providers, onKnowledgeChange, onAddSource, onAddMemory, onAddAgent, onExport, onImport }: { project: Project; knowledge: ProjectKnowledge; globalMemory: MemoryItem[]; providers: Provider[]; onKnowledgeChange: (knowledge: ProjectKnowledge) => void; onAddSource: () => void; onAddMemory: (scope: "global" | "project") => void; onAddAgent: () => void; onExport: () => void; onImport: (file: File) => void }) {
  const [tab, setTab] = useState<"instructions" | "memory" | "sources" | "agents">("instructions");
  const [sourceUrl, setSourceUrl] = useState("");
  const updateAgent = (agentId: string, patch: Partial<AgentDefinition>) => onKnowledgeChange({ ...knowledge, agents: knowledge.agents.map((agent) => agent.id === agentId ? { ...agent, ...patch } : agent) });
  const removeAgent = (agentId: string) => onKnowledgeChange({ ...knowledge, agents: knowledge.agents.filter((agent) => agent.id !== agentId) });
  const addUrlSource = () => {
    const url = sourceUrl.trim();
    if (!url) return;
    onKnowledgeChange({ ...knowledge, sources: [{ id: `source-${Date.now()}`, name: url, path: url, kind: "url", addedAt: new Date().toISOString() }, ...knowledge.sources] });
    setSourceUrl("");
  };
  return <div className="content page-content workspace-content"><div className="page-header"><div><span className="eyebrow"><Brain size={13} /> kontekst projektu</span><h1>Wiedza i agenci</h1><p>{project.name} ma własne instrukcje, źródła, pamięć i role agentów. Pamięć globalna może zasilać każdy projekt, ale zawsze pokazujemy jej pochodzenie.</p></div><span className="permission-state"><ShieldCheck size={15} /> zapis lokalny</span></div><div className="workspace-tabs">{([ ["instructions", "Instrukcje", BookOpen], ["memory", "Pamięć", Brain], ["sources", "Źródła", FolderOpen], ["agents", "Agenci", Users] ] as const).map(([id, label, Icon]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon size={15} /> {label}<span>{id === "memory" ? knowledge.memory.length + globalMemory.length : id === "sources" ? knowledge.sources.length : id === "agents" ? knowledge.agents.length : ""}</span></button>)}</div>{tab === "instructions" && <section className="knowledge-panel"><div className="panel-heading"><div><strong>Instrukcje projektu</strong><span>To jest stały kontekst dla planowania i każdej rozmowy w projekcie.</span></div><span className="status-chip active">aktywne</span></div><textarea className="knowledge-editor" value={knowledge.instructions} onChange={(event) => onKnowledgeChange({ ...knowledge, instructions: event.target.value })} placeholder="Napisz szerokie zasady projektu: styl, zakres, zakazane działania, definicję ukończenia, sposób cytowania źródeł i preferowany język..." rows={12} /><div className="knowledge-hint"><ShieldCheck size={14} /> Instrukcje są kontekstem, nie uprawnieniem. Polityka bezpieczeństwa aplikacji ma pierwszeństwo.</div></section>}{tab === "memory" && <section className="knowledge-panel"><div className="panel-heading"><div><strong>Pamięć z pochodzeniem</strong><span>Wiedza może być globalna albo przypisana tylko do tego projektu.</span></div><div className="page-header-actions"><button className="secondary-button" onClick={() => onAddMemory("global")}><Plus size={14} /> Dodaj globalną</button><button className="primary-button" onClick={() => onAddMemory("project")}><Plus size={14} /> Dodaj projektową</button></div></div><div className="memory-list">{[...globalMemory, ...knowledge.memory].map((item) => <article className={`memory-item ${item.enabled ? "" : "disabled"}`} key={item.id}><div className="memory-item-top"><span className={`status-chip ${item.scope === "global" ? "active" : "running"}`}>{item.scope === "global" ? "globalna" : "projektowa"}</span><span>{new Date(item.updatedAt).toLocaleDateString("pl-PL")}</span></div><strong>{item.title}</strong><p>{item.content}</p><small>Źródło: {item.source} · zaufanie: {item.confidence}</small></article>)}{globalMemory.length + knowledge.memory.length === 0 && <EmptyInline icon={<Brain size={20} />} title="Pamięć jest pusta" description="Dodaj decyzje, preferencje i sprawdzone rozwiązania — zawsze z jawnym źródłem." />}</div></section>}{tab === "sources" && <section className="knowledge-panel"><div className="panel-heading"><div><strong>Źródła i dokumenty projektu</strong><span>Pliki pozostają na dysku; AgentOS zapamiętuje ich położenie i opis, nie kopiuje ich bez potrzeby.</span></div><button className="primary-button" onClick={onAddSource}><Upload size={14} /> Dodaj pliki</button></div><div className="source-url-row"><input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://adres-źródła.pl lub link do dokumentu" /><button className="secondary-button" onClick={addUrlSource}>Dodaj link</button></div><div className="source-list">{knowledge.sources.map((source) => <article className="source-item" key={source.id}><div className="source-icon"><FolderOpen size={16} /></div><div><strong>{source.name}</strong><span>{source.path}</span><small>Dodano {new Date(source.addedAt).toLocaleDateString("pl-PL")}</small></div></article>)}{knowledge.sources.length === 0 && <EmptyInline icon={<FolderOpen size={20} />} title="Nie ma jeszcze źródeł" description="Dodaj katalog, pliki lub adresy, które agent ma brać pod uwagę." />}</div></section>}{tab === "agents" && <section className="knowledge-panel"><div className="panel-heading"><div><strong>Agenci projektu</strong><span>Każda rola ma własne instrukcje i może korzystać z innego modelu.</span></div><button className="primary-button" onClick={onAddAgent}><Plus size={14} /> Dodaj agenta</button></div><div className="agent-list">{knowledge.agents.map((agent) => <article className="agent-editor" key={agent.id}><div className="agent-editor-head"><div><input value={agent.name} onChange={(event) => updateAgent(agent.id, { name: event.target.value })} /><span>{agent.enabled ? "agent aktywny" : "agent wyłączony"}</span></div><button className="ghost-button danger-text" onClick={() => removeAgent(agent.id)}><Trash2 size={13} /> Usuń</button></div><div className="agent-form-grid"><label>Rola<input value={agent.role} onChange={(event) => updateAgent(agent.id, { role: event.target.value })} /></label><label>Model<select value={agent.modelId} onChange={(event) => updateAgent(agent.id, { modelId: event.target.value })}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}</select></label></div><textarea value={agent.instructions} onChange={(event) => updateAgent(agent.id, { instructions: event.target.value })} rows={4} placeholder="Zakres odpowiedzialności, format wyniku, kryteria jakości..." /><button className={`ghost-button ${agent.enabled ? "" : "danger-text"}`} onClick={() => updateAgent(agent.id, { enabled: !agent.enabled })}>{agent.enabled ? "Wyłącz agenta" : "Włącz agenta"}</button></article>)}{knowledge.agents.length === 0 && <EmptyInline icon={<Users size={20} />} title="Nie ma jeszcze agentów" description="Dodaj analityka, implementera, testera, recenzenta albo własną rolę." />}</div></section>}</div>;
}

function PortableContextPanel({ project, knowledge }: { project: Project; knowledge: ProjectKnowledge }) {
  const [message, setMessage] = useState("");
  const sync = async () => {
    const result = await tryInvoke<string>("write_project_context", { path: project.path, content: knowledge.instructions });
    setMessage(result ? `Zapisano ${result}` : "Nie udało się zapisać PROJECT_CONTEXT.md.");
  };
  return <section className="knowledge-panel portable-context-panel"><div className="panel-heading"><div><strong>Przenośny kontekst</strong><span>Zapisz instrukcje do PROJECT_CONTEXT.md, aby Claude, Codex i Antigravity widziały ten sam kontekst.</span></div><button className="secondary-button" onClick={() => void sync()}><Download size={14} /> Zapisz w projekcie</button></div>{message && <div className="knowledge-hint"><ShieldCheck size={14} /> {message}</div>}</section>;
}

function SkillPanel({ project, skills, onChange }: { project: Project; skills: SkillDefinition[]; onChange: (skills: SkillDefinition[]) => void }) {
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const loadSkills = async () => {
    const result = await tryInvoke<SkillDefinition[]>("list_project_skills", { projectPath: project.path });
    if (!result) { setMessage("Brak katalogu .agentos/skills albo manifesty są nieprawidłowe."); return; }
    onChange(result);
    setLoaded(true);
    setMessage(result.length ? `Wczytano ${result.length} manifestów.` : "Nie znaleziono manifestów skillów.");
  };
  const toggleSkill = (id: string) => onChange(skills.map((skill) => skill.id === id ? { ...skill, trusted: skill.trusted || !skill.enabled, enabled: skill.trusted ? !skill.enabled : true } : skill));
  return <section className="knowledge-panel skill-panel"><div className="panel-heading"><div><strong>Skille projektu</strong><span>Manifesty są tylko opisem dopuszczonego kontekstu. AgentOS nie wykonuje pobranego kodu automatycznie.</span></div><button className="secondary-button" onClick={() => void loadSkills}><RefreshCw size={14} /> {loaded ? "Odśwież" : "Wczytaj manifesty"}</button></div><div className="skill-list">{skills.map((skill) => <article className="skill-item" key={skill.id}><div><strong>{skill.name} <small>v{skill.version}</small></strong><span>{skill.description}</span><small>{skill.source}</small></div><div className="skill-item-actions"><span className={`status-chip ${skill.trusted ? "active" : "waiting"}`}>{skill.trusted ? "zaufany" : "wymaga zaufania"}</span><button className={`ghost-button ${skill.enabled ? "" : "danger-text"}`} onClick={() => toggleSkill(skill.id)}>{skill.enabled ? "Wyłącz" : "Włącz"}</button></div></article>)}{skills.length === 0 && <EmptyInline icon={<Zap size={20} />} title="Nie ma jeszcze skillów" description="Dodaj manifest JSON do katalogu .agentos/skills i wczytaj go jawnie." />}</div>{message && <div className="knowledge-hint"><ShieldCheck size={14} /> {message}</div>}</section>;
}

function SkillImportBar({ project, onImported }: { project: Project; onImported: (skill: SkillDefinition) => void }) {
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  const importRemote = async () => {
    const result = await tryInvoke<SkillDefinition>("download_skill_manifest", { projectPath: project.path, url: url.trim() });
    setMessage(result ? `Pobrano ${result.name}; skill pozostaje wyłączony i niezaufany.` : "Import odrzucony. Użyj HTTPS z GitHub i poprawnego manifestu JSON.");
    if (result) { onImported(result); setUrl(""); }
  };
  return <section className="knowledge-panel skill-import-panel"><div className="panel-heading"><div><strong>Import bezpiecznego skillu</strong><span>Dozwolone są tylko manifesty HTTPS z GitHub. Kod nie jest wykonywany.</span></div><button className="secondary-button" onClick={() => void importRemote} disabled={!url.trim()}><Download size={14} /> Importuj manifest</button></div><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://raw.githubusercontent.com/.../skill.json" />{message && <div className="knowledge-hint"><ShieldCheck size={14} /> {message}</div>}</section>;
}

function EmptyInline({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return <div className="empty-inline"><div>{icon}</div><strong>{title}</strong><span>{description}</span></div>;
}

function offerPriceLabel(offer: ModelOffer): string {
  if (offer.free) return "darmowy";
  const input = offer.inputPrice.toFixed(2);
  const output = offer.outputPrice.toFixed(2);
  return `$${input} / $${output} za 1M tokenów`;
}

type ModelsViewProps = {
  providers: Provider[];
  selectedProviderId: string;
  setSelectedProviderId: (value: string) => void;
  showForm: boolean;
  setShowForm: (value: boolean) => void;
  draft: { name: string; kind: Provider["kind"]; model: string; endpoint: string; key: string };
  setDraft: (value: { name: string; kind: Provider["kind"]; model: string; endpoint: string; key: string }) => void;
  addProvider: () => void;
  offers: ModelOffer[];
  discoverOffers: () => Promise<void>;
  discovering: boolean;
  onUseOffer: (offer: ModelOffer) => void;
  onConfigureProvider: (provider: Provider) => void;
  routing: RoutingPolicy;
  usageLedger: UsageLedgerEntry[];
  onRoutingChange: (routing: RoutingPolicy) => void;
};

function ModelsView({ providers, selectedProviderId, setSelectedProviderId, showForm, setShowForm, draft, setDraft, addProvider, offers, discoverOffers, discovering, onUseOffer, onConfigureProvider, routing, usageLedger, onRoutingChange }: ModelsViewProps) {
  const selected = providers.find((provider) => provider.id === selectedProviderId);

  return (
    <div className="content page-content">
      <section className="parallel-policy"><div><strong>Równoległe sesje</strong><span>Limit chroni komputer i budżet, a aktywne zadania pozostają niezależne.</span></div><label>Maksymalnie równolegle<input type="number" min="1" max="32" value={routing.maxParallelTasks} onChange={(event) => onRoutingChange({ ...routing, maxParallelTasks: Math.max(1, Math.min(32, Number(event.target.value) || 1)) })} /></label></section>
      <div className="page-header">
        <div><span className="eyebrow"><Cpu size={13} /> inteligentny routing</span><h1>Modele i routing</h1><p>Podłącz dostawców, a AgentOS dobierze model do trudności, prywatności, kosztu i czasu.</p></div>
        <div className="page-header-actions"><button className="secondary-button" onClick={() => void discoverOffers()} disabled={discovering}><Network size={14} /> {discovering ? "Szukam ofert..." : "Znajdź tanie modele"}</button><button className="primary-button" onClick={() => setShowForm(!showForm)}><Plus size={15} /> Podłącz model</button></div>
      </div>
      <div className="router-card"><div className="router-icon"><SlidersHorizontal size={19} /></div><div><strong>Strategia: najlepszy wynik w ramach limitu</strong><span>Dla planowania preferuj głębokie modele, dla prostych akcji lokalny model, dla researchu router sprawdza źródła i koszt.</span></div><div className="router-pill"><span className="router-dot" /> {selected ? `${selected.name} · ${selected.model}` : "aktywny"}</div></div>
      <section className="routing-policy"><div><strong>Polityka automatycznego oszczędzania</strong><span>AgentOS może wybrać tańszy lub lokalny model dla konkretnego zadania. Zmiana jest widoczna w osi czasu.</span></div><div className="routing-controls"><label>Tryb<select value={routing.mode} onChange={(event) => onRoutingChange({ ...routing, mode: event.target.value as RoutingPolicy["mode"] })}><option value="economical">Oszczędny</option><option value="balanced">Zbalansowany</option><option value="quality">Najlepszy wynik</option></select></label><label>Limit zadania ($)<input type="number" min="0" step="0.01" value={routing.maxCostPerTask} onChange={(event) => onRoutingChange({ ...routing, maxCostPerTask: Number(event.target.value) || 0 })} /></label><label>Budżet dzienny ($)<input type="number" min="0" step="0.5" value={routing.dailyBudget} onChange={(event) => onRoutingChange({ ...routing, dailyBudget: Number(event.target.value) || 0 })} /></label><SettingToggle label="Automatycznie zmieniaj model" enabled={routing.autoSwitch} onToggle={() => onRoutingChange({ ...routing, autoSwitch: !routing.autoSwitch })} /><SettingToggle label="Preferuj modele lokalne" enabled={routing.preferLocal} onToggle={() => onRoutingChange({ ...routing, preferLocal: !routing.preferLocal })} /><SettingToggle label="Fallback po błędzie" enabled={routing.allowFallback} onToggle={() => onRoutingChange({ ...routing, allowFallback: !routing.allowFallback })} /></div><div className="usage-summary"><span>Szacowany koszt zapisanych sesji</span><strong>${usageLedger.reduce((sum, entry) => sum + entry.estimatedCost, 0).toFixed(4)}</strong><small>{usageLedger.length} wpisów · lokalny ledger</small></div></section>
      {offers.length > 0 && <section className="model-offer-section"><div className="model-offer-head"><div><span className="eyebrow"><Wifi size={13} /> katalog live</span><h2>Tanie i darmowe oferty</h2><p>Ceny są odczytane z katalogu OpenRouter. „Darmowy” oznacza cenę 0, nie brak limitów.</p></div><span className="catalog-stamp">{offers.length} ofert</span></div><div className="model-offer-grid">{offers.slice(0, 12).map((offer) => <article className="model-offer-card" key={offer.id}><div className="model-offer-top"><span className={`offer-badge ${offer.free ? "free" : "cheap"}`}>{offer.free ? "DARMOWY" : "TANI"}</span><span className="offer-context">{offer.contextLength.toLocaleString("pl-PL")} kontekstu</span></div><strong>{offer.name}</strong><code>{offer.id}</code><p>{offer.description}</p><div className="model-offer-meta"><span>{offerPriceLabel(offer)}</span><span>{offer.modalities.join(" · ")}</span></div><button className="ghost-button" onClick={() => onUseOffer(offer)}><Zap size={13} /> Użyj w routerze</button></article>)}</div></section>}
      <div className="provider-grid">{providers.map((provider) => <div className={`provider-card ${selectedProviderId === provider.id ? "selected" : ""}`} key={provider.id}>
        <div className={`provider-mark ${toneClass[provider.tone]}`}>{provider.kind === "ollama" ? <Terminal size={18} /> : provider.kind === "anthropic" ? <Sparkles size={18} /> : provider.kind === "google" ? <Globe2 size={18} /> : provider.kind === "openrouter" ? <Network size={18} /> : <Zap size={18} />}</div>
        <div className="provider-name"><strong>{provider.name}</strong><span>{provider.model}</span></div>
        <div className="provider-meta"><span><Wifi size={13} /> {provider.latency}</span><span className={provider.hasKey ? "key-ok" : "key-missing"}><KeyRound size={13} /> {provider.hasKey ? "klucz zapisany" : "brak klucza"}</span></div>
        <div className="provider-endpoint">{provider.endpoint}</div>
        <button className="ghost-button provider-action" onClick={() => onConfigureProvider(provider)}>{provider.hasKey ? <><Check size={14} /> Zmień konfigurację</> : <>Podłącz teraz <ArrowUpRight size={14} /></>}</button>
      </div>)}</div>
      {showForm && <div className="provider-form"><div className="form-head"><div><strong>Podłącz dostawcę modelu</strong><span>Klucz API trafi do magazynu systemowego, nie do historii projektu.</span></div><button className="icon-button" onClick={() => setShowForm(false)}><X size={16} /></button></div><div className="form-grid"><label>Nazwa<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>Typ<select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as Provider["kind"] })}><option value="custom">OpenAI-compatible</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google AI</option><option value="ollama">Ollama / lokalny</option><option value="openrouter">OpenRouter</option></select></label><label>Model<input value={draft.model} placeholder="np. gpt-5.6-sol" onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label><label>Endpoint<input value={draft.endpoint} placeholder="https://.../v1/chat/completions" onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} /></label><label className="full-field">Klucz API<input type="password" value={draft.key} placeholder="wklej klucz API" onChange={(event) => setDraft({ ...draft, key: event.target.value })} /></label></div><div className="form-actions"><span><LockKeyhole size={14} /> Klucz nie trafia do historii projektu.</span><button className="primary-button" onClick={() => void addProvider()}>Zapisz i podłącz <Check size={15} /></button></div></div>}
    </div>
  );
}

function ModelsViewLegacy({ providers, selectedProviderId, setSelectedProviderId, showForm, setShowForm, draft, setDraft, addProvider, offers, discoverOffers, discovering, onUseOffer, onConfigureProvider }: { providers: Provider[]; selectedProviderId: string; setSelectedProviderId: (value: string) => void; showForm: boolean; setShowForm: (value: boolean) => void; draft: { name: string; kind: Provider["kind"]; model: string; endpoint: string; key: string }; setDraft: (value: { name: string; kind: Provider["kind"]; model: string; endpoint: string; key: string }) => void; addProvider: () => void; offers: ModelOffer[]; discoverOffers: () => Promise<void>; discovering: boolean; onUseOffer: (offer: ModelOffer) => void; onConfigureProvider: (provider: Provider) => void }) {
  const selected = providers.find((provider) => provider.id === selectedProviderId);
  return <div className="content page-content"><div className="page-header"><div><span className="eyebrow"><Cpu size={13} /> inteligentny routing</span><h1>Modele i routing</h1><p>Podłącz dostawców, a AgentOS dobierze model do trudności, prywatności, kosztu i czasu.</p></div><div className="page-header-actions"><button className="secondary-button" onClick={() => void discoverOffers()} disabled={discovering}><Network size={14} /> {discovering ? "Szukam ofert..." : "Znajdź tanie modele"}</button><button className="primary-button" onClick={() => setShowForm(!showForm)}><Plus size={15} /> Podłącz model</button></div></div><div className="router-card"><div className="router-icon"><SlidersHorizontal size={19} /></div><div><strong>Strategia: najlepszy wynik w ramach limitu</strong><span>Dla planowania preferuj głębokie modele, dla prostych akcji lokalny model, dla researchu router sprawdza źródła i koszt.</span></div><div className="router-pill"><span className="router-dot" /> {selected ? `${selected.name} · ${selected.model}` : "aktywny"}</div></div>{offers.length > 0 && <section className="model-offer-section"><div className="model-offer-head"><div><span className="eyebrow"><Wifi size={13} /> katalog live</span><h2>Tanie i darmowe oferty</h2><p>Ceny są odczytane z katalogu OpenRouter i zapisane z datą weryfikacji. „Darmowy” oznacza cenę 0, nie brak limitów.</p></div><span className="catalog-stamp">{offers.length} ofert · ostatni odczyt {new Date(Number(offers[0].checkedAt) * 1000).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}</span></div><div className="model-offer-grid">{offers.slice(0, 12).map((offer) => <article className="model-offer-card" key={offer.id}><div className="model-offer-top"><span className={`offer-badge ${offer.free ? "free" : "cheap"}`}>{offer.free ? "DARMOWY" : "TANI"}</span><span className="offer-context">{offer.contextLength.toLocaleString("pl-PL")} kontekstu</span></div><strong>{offer.name}</strong><code>{offer.id}</code><p>{offer.description}</p><div className="model-offer-meta"><span>{offerPriceLabel(offer)}</span><span>{offer.modalities.join(" · ")}</span></div><button className="ghost-button" onClick={() => onUseOffer(offer)}><Zap size={13} /> Użyj w routerze</button></article>)}</div></section>}<div className="provider-grid">{providers.map((provider) => <div className={`provider-card ${selectedProviderId === provider.id ? "selected" : ""}`} key={provider.id}><div className={`provider-mark ${toneClass[provider.tone]}`}>{provider.kind === "ollama" ? <Terminal size={18} /> : provider.kind === "anthropic" ? <Sparkles size={18} /> : provider.kind === "google" ? <Globe2 size={18} /> : provider.kind === "openrouter" ? <Network size={18} /> : <Zap size={18} />}</div><div className="provider-name"><strong>{provider.name}</strong><span>{provider.model}</span></div><div className="provider-meta"><span><Wifi size={13} /> {provider.latency}</span><span className={provider.hasKey ? "key-ok" : "key-missing"}><KeyRound size={13} /> {provider.hasKey ? "klucz zapisany" : "brak klucza"}</span></div><div className="provider-endpoint">{provider.endpoint}</div><button className="ghost-button provider-action" onClick={() => setSelectedProviderId(provider.id)}>{selectedProviderId === provider.id ? <><Check size={14} /> Używany</> : <>Użyj w routerze <ArrowUpRight size={14} /></>}</button></div>)}</div>{showForm && <div className="provider-form"><div className="form-head"><div><strong>Nowy adapter modelu</strong><span>Klucz API trafi do magazynu systemowego, nie do historii projektu.</span></div><button className="icon-button" onClick={() => setShowForm(false)}><X size={16} /></button></div><div className="form-grid"><label>Nazwa<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>Typ<select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as Provider["kind"] })}><option value="custom">OpenAI-compatible</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google AI</option><option value="ollama">Ollama / lokalny</option><option value="openrouter">OpenRouter</option></select></label><label>Model<input value={draft.model} placeholder="np. gpt-5.6-sol" onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label><label>Endpoint<input value={draft.endpoint} placeholder="https://.../v1/chat/completions" onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} /></label><label className="full-field">Klucz API<input type="password" value={draft.key} placeholder="zostaw puste dla Ollama" onChange={(event) => setDraft({ ...draft, key: event.target.value })} /></label></div><div className="form-actions"><span><LockKeyhole size={14} /> Nie zapisujemy klucza w frontendzie.</span><button className="primary-button" onClick={() => void addProvider()}>Zapisz adapter <Check size={15} /></button></div></div>}</div>;
}

function ComputerView({ activeProject, runAction, busy, enabled, onToggle }: { activeProject: Project; runAction: (action: string, target?: string) => void; busy: boolean; enabled: boolean; onToggle: () => void }) {
  return <div className="content page-content"><div className="page-header"><div><span className="eyebrow"><Laptop size={13} /> kontrola urządzenia</span><h1>Komputer</h1><p>Jawne, ograniczone akcje systemowe. Agent nie dostaje pełnego dostępu do myszy i klawiatury bez dodatkowej polityki.</p></div><button className={`permission-state permission-button ${enabled ? "enabled" : "disabled"}`} onClick={onToggle}><ShieldCheck size={15} /> {enabled ? "dostęp włączony" : "dostęp wyłączony"}</button></div><div className="permission-banner"><div className="permission-banner-icon"><LockKeyhole size={18} /></div><div><strong>{enabled ? "Dostęp kontrolowany" : "Dostęp zablokowany"}</strong><span>Każda akcja ma zakres, cel i zatwierdzenie. Przełącznik powyżej wpływa na wszystkie akcje komputera.</span></div><span className={`status-chip ${enabled ? "active" : "waiting"}`}>{enabled ? "włączone" : "wyłączone"}</span></div><div className="control-grid"><ControlCard icon={<FolderOpen size={19} />} title="Projekt w Finderze" description="Pokaż aktywny katalog projektu w Finderze." action="Otwórz" onClick={() => runAction("reveal_project", activeProject.path)} busy={busy} /><ControlCard icon={<Globe2 size={19} />} title="Adres w przeglądarce" description="Otwórz bezpiecznie wskazaną stronę w domyślnej przeglądarce." action="Otwórz Safari" onClick={() => runAction("open_url", "https://example.com")} busy={busy} /><ControlCard icon={<Terminal size={19} />} title="Terminal projektu" description="Uruchom terminal w katalogu projektu bez wykonywania komend." action="Otwórz Terminal" onClick={() => runAction("open_terminal", activeProject.path)} busy={busy} /><ControlCard icon={<Upload size={19} />} title="Zrzut ekranu" description="Wygeneruj artefakt ekranu do bieżącej sesji." action="Zrób screenshot" onClick={() => runAction("screenshot")} busy={busy} /></div><div className="control-note"><CircleAlert size={16} /><div><strong>Pełne sterowanie GUI jest celowo poza domyślnym MVP.</strong><span>Wersja rozszerzona może użyć macOS Accessibility API, ale wymaga osobnej polityki, widocznego nagrywania działań i awaryjnego przycisku Stop.</span></div></div></div>;
}

function SettingsView({ networkUrl, setNetworkUrl, networkResult, fetchNetwork, busy, permissions, onToggle }: { networkUrl: string; setNetworkUrl: (value: string) => void; networkResult: string; fetchNetwork: () => void; busy: boolean; permissions: PermissionState; onToggle: (key: keyof PermissionState) => void }) {
  return <div className="content page-content"><div className="page-header"><div><span className="eyebrow"><Settings size={13} /> polityka i konektory</span><h1>Ustawienia</h1><p>Konfiguruj granice sieci, przechowywanie danych i zachowanie agentów.</p></div><div className="permission-state"><ShieldCheck size={15} /> kontrolowane lokalnie</div></div><div className="settings-grid"><section className="settings-section"><div className="settings-section-title"><div className="setting-icon cyan"><Globe2 size={17} /></div><div><strong>Sieć i research</strong><span>Fetch przechodzi przez backend z limitem i walidacją adresu.</span></div></div><div className="network-form"><label>Adres do sprawdzenia<input value={networkUrl} onChange={(event) => setNetworkUrl(event.target.value)} /></label><button className="secondary-button" onClick={() => void fetchNetwork()} disabled={busy || !permissions.network}><Globe2 size={14} /> {permissions.network ? "Pobierz" : "Sieć wyłączona"}</button></div>{networkResult && <pre className="network-result">{networkResult.slice(0, 6000)}</pre>}</section><section className="settings-section"><div className="settings-section-title"><div className="setting-icon violet"><LockKeyhole size={17} /></div><div><strong>Prywatność i uprawnienia</strong><span>Każdy przełącznik zmienia działanie aplikacji i zostaje zapisany lokalnie.</span></div></div><SettingToggle label="Dostęp do sieci" enabled={permissions.network} onToggle={() => onToggle("network")} /><SettingToggle label="Dostęp do komputera" enabled={permissions.computer} onToggle={() => onToggle("computer")} /><SettingToggle label="Redaguj sekrety w logach" enabled={permissions.redactSecrets} onToggle={() => onToggle("redactSecrets")} /><SettingToggle label="Wymagaj zgody na działania" enabled={permissions.requireApproval} onToggle={() => onToggle("requireApproval")} /><SettingToggle label="Izoluj każdą sesję projektu" enabled={permissions.isolateSessions} onToggle={() => onToggle("isolateSessions")} /><SettingToggle label="Zapisuj pełny event log" enabled={permissions.eventLog} onToggle={() => onToggle("eventLog")} /></section><section className="settings-section"><div className="settings-section-title"><div className="setting-icon amber"><Command size={17} /></div><div><strong>Skróty i zachowanie</strong><span>Interfejs ma pomagać w sterowaniu pracą, nie tylko w rozmowie.</span></div></div><div className="shortcut-row"><span>Uruchom intencję</span><kbd>⌘ ↵</kbd></div><div className="shortcut-row"><span>Przerwij agenta</span><kbd>⌘ .</kbd></div><div className="shortcut-row"><span>Otwórz command palette</span><kbd>⌘ K</kbd></div></section></div></div>;
}

function Stage({ state, label }: { state: "done" | "running" | "waiting" | "queued"; label: string }) { return <div className={`stage stage-${state}`}><span>{state === "done" ? <Check size={15} /> : state === "running" ? <Activity size={15} /> : state === "waiting" ? <CircleAlert size={15} /> : <span className="stage-empty" />}</span><strong>{label}</strong></div>; }
function SummaryRow({ icon, label, value, warn }: { icon: React.ReactNode; label: string; value: string; warn?: boolean }) { return <div className="summary-row"><span>{icon}{label}</span><strong className={warn ? "warn-text" : ""}>{value}</strong></div>; }
function PermissionRow({ icon, label, detail, enabled, onToggle }: { icon: React.ReactNode; label: string; detail: string; enabled: boolean; onToggle: () => void }) { return <div className="permission-row"><span className="permission-icon">{icon}</span><div><strong>{label}</strong><small>{detail}</small></div><button className={`toggle toggle-button ${enabled ? "on" : ""}`} role="switch" aria-checked={enabled} aria-label={`${label}: ${enabled ? "włączone" : "wyłączone"}`} onClick={onToggle}><i /></button></div>; }
function MiniStat({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: string }) { return <div className="mini-stat"><div className={`mini-stat-icon ${tone}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>; }
function ControlCard({ icon, title, description, action, onClick, busy }: { icon: React.ReactNode; title: string; description: string; action: string; onClick: () => void; busy: boolean }) { return <div className="control-card"><div className="control-card-icon">{icon}</div><strong>{title}</strong><p>{description}</p><button className="secondary-button" onClick={onClick} disabled={busy}>{busy ? <Activity size={14} className="spin" /> : <Play size={14} />} {action}</button></div>; }
function SettingToggle({ label, enabled, onToggle }: { label: string; enabled: boolean; onToggle: () => void }) { return <div className="setting-toggle"><span>{label}</span><button className={`toggle toggle-button ${enabled ? "on" : ""}`} role="switch" aria-checked={enabled} aria-label={`${label}: ${enabled ? "włączone" : "wyłączone"}`} onClick={onToggle}><i /></button></div>; }
function EmptyState({ title, description, action }: { title: string; description: string; action: () => void }) { return <div className="empty-state"><div className="empty-icon"><MessageSquare size={18} /></div><strong>{title}</strong><span>{description}</span><button className="secondary-button" onClick={action}><Play size={14} /> Uruchom teraz</button></div>; }

export default App;
