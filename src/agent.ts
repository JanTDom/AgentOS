// Pętla agenta: model ↔ narzędzia, z planem, zgodami, zatrzymaniem i cofaniem.
import { api, type ToolSpec } from "./api";
import { lineDiff } from "./diff";
import { INTEGRATION_TOOLS, integrationPrompt, integrationTools, prepareMcp, runIntegrationTool, type Accounts, type McpBinding } from "./agentIntegrations";
import { nowIso, uid } from "./store";
import { skillToggleId, type McpServer, type AccessMode, type AgentMessage, type Change, type Conversation, type ConversationItem, type InstalledSkill, type PlanStep, type Project, type Provider, type ToolCall } from "./types";

const MAX_STEPS = 40;

export type Host = {
  conversation: (id: string) => Conversation | undefined;
  project: (id: string | null) => Project | null;
  provider: (id: string) => Provider | undefined;
  update: (id: string, fn: (c: Conversation) => Conversation) => void;
  settings: () => { skillSources: string[]; disabledSkills: string[]; mcpServers: McpServer[]; accounts: Accounts };
  saveProject: (id: string, patch: Partial<Project>) => void;
};

type Decision = { approved: boolean; feedback?: string; stopped?: boolean };

const TOOLS: Record<string, ToolSpec> = {
  list_files: {
    name: "list_files",
    description: "Wyświetla pliki i foldery projektu (pomija node_modules, .git, build). Ścieżki względne wobec folderu projektu.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Podfolder, domyślnie cały projekt" }, depth: { type: "integer", description: "Głębokość 1–5, domyślnie 2" } } },
  },
  read_file: {
    name: "read_file",
    description: "Odczytuje plik tekstowy, kod albo dokument (PDF, DOCX, RTF zamieniane na tekst).",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  search_files: {
    name: "search_files",
    description: "Szuka tekstu (bez rozróżniania wielkości liter) w nazwach i treści plików projektu.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  propose_plan: {
    name: "propose_plan",
    description: "Przedstawia użytkownikowi cel i plan (3–8 kroków) przed zmianami w plikach. Czeka na zatwierdzenie albo uwagi.",
    parameters: { type: "object", properties: { goal: { type: "string" }, steps: { type: "array", items: { type: "string" } } }, required: ["goal", "steps"] },
  },
  mark_step: {
    name: "mark_step",
    description: "Aktualizuje stan kroku planu (numeracja od 1): doing albo done.",
    parameters: { type: "object", properties: { step: { type: "integer" }, status: { type: "string", enum: ["doing", "done"] } }, required: ["step", "status"] },
  },
  write_file: {
    name: "write_file",
    description: "Tworzy albo nadpisuje plik tekstowy w projekcie pełną nową treścią. Foldery tworzone automatycznie. Nie usuwa plików.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  use_skill: {
    name: "use_skill",
    description: "Wczytuje pełne instrukcje zainstalowanej umiejętności (SKILL.md) i listę jej plików. Użyj, zanim zaczniesz zadanie pasujące do opisu umiejętności.",
    parameters: { type: "object", properties: { name: { type: "string", description: "Nazwa umiejętności z listy" } }, required: ["name"] },
  },
  read_skill_file: {
    name: "read_skill_file",
    description: "Odczytuje dodatkowy plik umiejętności (np. reference.md, szablon), wskazany w jej instrukcjach.",
    parameters: { type: "object", properties: { name: { type: "string" }, path: { type: "string", description: "Ścieżka względem folderu umiejętności" } }, required: ["name", "path"] },
  },
  find_skills: {
    name: "find_skills",
    description: "Szuka gotowych umiejętności (SKILL.md) w katalogu i na GitHubie. Użyj, gdy zadanie wymaga specjalistycznej wiedzy lub formatu (np. PDF, XLSX, analiza umów), a żadna zainstalowana umiejętność nie pasuje.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Krótko, najlepiej po angielsku, np. \"pdf forms\"" } }, required: ["query"] },
  },
  install_skill: {
    name: "install_skill",
    description: "Proponuje użytkownikowi instalację umiejętności spod adresu GitHub (z wyników find_skills). Użytkownik zobaczy podgląd, ryzyka i zdecyduje.",
    parameters: { type: "object", properties: { source: { type: "string", description: "Adres GitHub folderu lub repozytorium" }, name: { type: "string", description: "Nazwa, jeśli pod adresem jest kilka umiejętności" }, reason: { type: "string" } }, required: ["source", "reason"] },
  },
  run_command: {
    name: "run_command",
    description: "Uruchamia polecenie powłoki zsh w folderze projektu (limit 2 minuty, bez interakcji). Użytkownik musi je zatwierdzić. Nie uruchamiaj serwerów działających bez końca.",
    parameters: { type: "object", properties: { command: { type: "string" }, reason: { type: "string", description: "Krótko: po co to polecenie" } }, required: ["command", "reason"] },
  },
};

function toolsFor(project: Project | null, skills: InstalledSkill[], toolsUnsupported?: boolean): ToolSpec[] {
  if (toolsUnsupported) return [];
  const skillTools = [...(skills.length ? [TOOLS.use_skill, TOOLS.read_skill_file] : []), TOOLS.find_skills];
  if (!project) return [...skillTools, TOOLS.install_skill];
  const base = [TOOLS.list_files, TOOLS.read_file, TOOLS.search_files, TOOLS.propose_plan, TOOLS.mark_step, ...skillTools];
  return project.accessMode === "read" ? base : [...base, TOOLS.install_skill, TOOLS.write_file, TOOLS.run_command];
}

function skillsSection(skills: InstalledSkill[]): string {
  if (!skills.length) return "Nie masz zainstalowanych umiejętności. Jeśli zadanie wymaga specjalistycznej wiedzy lub formatu, możesz poszukać umiejętności narzędziem find_skills.";
  return [
    "Zainstalowane umiejętności (gotowe instrukcje do konkretnej pracy). Gdy zadanie pasuje do opisu, najpierw wywołaj use_skill i postępuj według jej instrukcji:",
    ...skills.slice(0, 60).map((skill) => `- ${skill.name}: ${skill.description.slice(0, 300) || "(bez opisu)"}`),
  ].join("\n");
}

const accessText: Record<AccessMode, string> = {
  read: "TRYB TYLKO DO ODCZYTU: nie możesz zmieniać plików ani uruchamiać poleceń. Jeśli zadanie wymaga zmian, opisz je i poproś użytkownika o zmianę trybu.",
  ask: "Każdy zapis pliku i każde polecenie użytkownik zatwierdza osobno. Jeśli odrzuci zmianę, nie ponawiaj jej — zapytaj, czego oczekuje.",
  auto: "Zapisy plików w projekcie wykonują się bez pytania (użytkownik może je cofnąć). Polecenia terminala nadal wymagają zgody.",
};

async function systemPrompt(project: Project | null, skills: InstalledSkill[]): Promise<string> {
  const base = [
    "Jesteś AgentOS — asystentem i agentem pracującym na Macu użytkownika. Odpowiadaj po polsku, prostym, konkretnym językiem. Formatuj odpowiedzi w Markdown.",
    "Nie wymyślaj faktów ani wyników. Nie twierdź, że coś działa lub zostało sprawdzone, jeśli tego nie sprawdziłeś narzędziem.",
  ];
  if (!project) {
    base.push("Ta rozmowa nie jest powiązana z folderem projektu, więc nie masz dostępu do plików. Jeśli zadanie tego wymaga, poproś użytkownika o wybranie projektu.");
    base.push(skillsSection(skills));
    return base.join("\n\n");
  }
  base.push(`Pracujesz w projekcie „${project.name}”, folder: ${project.path}. Wszystkie ścieżki podawaj względem tego folderu.`);
  base.push([
    "Sposób pracy:",
    "1. Proste pytania — odpowiedz od razu, bez planu.",
    "2. Zadania wymagające zmian w plikach lub kilku kroków — najpierw rozpoznaj projekt (list_files, read_file), potem wywołaj propose_plan i czekaj na decyzję.",
    "3. Po zatwierdzeniu wykonuj kroki po kolei; przed krokiem mark_step(n, \"doing\"), po nim mark_step(n, \"done\").",
    "4. Pliki zapisuj w całości narzędziem write_file. Nie usuwaj plików.",
    "5. Po zmianach sprawdź rezultat: uruchom testy lub build, jeśli projekt je ma, albo ponownie odczytaj zmienione pliki i sprawdź ich spójność.",
    "6. Na końcu napisz krótko: co zrobiono, które pliki zmieniono, co sprawdzono i jak, jakie są ograniczenia. Jeśli coś się nie udało — powiedz to wprost.",
    "Nowa aplikacja: jeśli użytkownik nie wskazał technologii, a folder jest pusty, wybierz najprostsze rozwiązanie bez instalacji (index.html + style.css + app.js), żeby działało od razu po otwarciu index.html.",
  ].join("\n"));
  base.push(accessText[project.accessMode]);
  base.push(skillsSection(skills));
  if (project.instructions.trim()) base.push(`Instrukcje projektu od użytkownika:\n${project.instructions.trim()}`);
  if (project.memory.length) base.push(`Pamięć projektu (fakty zapisane przez użytkownika):\n${project.memory.map((m) => `- ${m.text}`).join("\n")}`);
  try {
    const files = await api.readContextFiles(project.path);
    const text = files.map((f) => `### ${f.name}\n${f.content}`).join("\n\n").slice(0, 12000);
    if (text) base.push(`Pliki kontekstu znalezione w projekcie:\n${text}`);
  } catch { /* brak plików kontekstu */ }
  return base.join("\n\n");
}

const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));

export class AgentRunner {
  private stopRequests = new Set<string>();
  private waits = new Map<string, { conversationId: string; resolve: (d: Decision) => void }>();
  private active = new Set<string>();

  constructor(private host: Host, private onChange: () => void) {}

  isActive(conversationId: string) { return this.active.has(conversationId); }
  isStopping(conversationId: string) { return this.stopRequests.has(conversationId); }

  stop(conversationId: string) {
    if (!this.active.has(conversationId)) return;
    this.stopRequests.add(conversationId);
    for (const [itemId, wait] of this.waits) {
      if (wait.conversationId === conversationId) { wait.resolve({ approved: false, stopped: true }); this.waits.delete(itemId); }
    }
    this.onChange();
  }

  decide(itemId: string, decision: Decision) {
    const wait = this.waits.get(itemId);
    if (!wait) return;
    this.waits.delete(itemId);
    wait.resolve(decision);
  }

  /** Czy rozmowa czeka na decyzję w planie (wtedy tekst z pola wiadomości jest uwagą do planu). */
  pendingPlanItem(conversationId: string): string | null {
    const c = this.host.conversation(conversationId);
    const plan = c?.items.find((i) => i.kind === "plan" && i.decision === "pending");
    return plan && this.waits.has(plan.id) ? plan.id : null;
  }

  private push(conversationId: string, item: ConversationItem) {
    this.host.update(conversationId, (c) => ({ ...c, items: [...c.items, item], updatedAt: nowIso() }));
  }

  private patchItem(conversationId: string, itemId: string, patch: Partial<ConversationItem>) {
    this.host.update(conversationId, (c) => ({
      ...c,
      items: c.items.map((i) => (i.id === itemId ? ({ ...i, ...patch } as ConversationItem) : i)),
    }));
  }

  private setStatus(conversationId: string, status: Conversation["status"]) {
    this.host.update(conversationId, (c) => ({ ...c, status, updatedAt: nowIso() }));
  }

  private wait(conversationId: string, itemId: string): Promise<Decision> {
    this.setStatus(conversationId, "waiting");
    return new Promise((resolve) => {
      this.waits.set(itemId, { conversationId, resolve });
    }).then((decision) => {
      if (!this.stopRequests.has(conversationId)) this.setStatus(conversationId, "running");
      return decision as Decision;
    });
  }

  async send(conversationId: string, text: string) {
    const conversation = this.host.conversation(conversationId);
    if (!conversation || this.active.has(conversationId)) return;
    const api0 = sanitize(conversation.api);
    this.host.update(conversationId, (c) => ({
      ...c,
      api: [...api0, { role: "user", text }],
      items: [...c.items, { id: uid("item"), kind: "user", text, at: nowIso() }],
      status: "running",
      updatedAt: nowIso(),
    }));
    await this.loop(conversationId);
  }

  private async loop(conversationId: string) {
    this.active.add(conversationId);
    this.stopRequests.delete(conversationId);
    this.onChange();
    const warnings: string[] = [];
    try {
      const first = this.host.conversation(conversationId)!;
      const project = this.host.project(first.projectId);
      const { disabledSkills } = this.host.settings();
      const skills = (await api.skillList(project?.path).catch(() => [] as InstalledSkill[]))
        .filter((skill) => !disabledSkills.includes(skillToggleId(skill, project?.id ?? null)));
      const { mcpServers, accounts } = this.host.settings();
      const mcp = await prepareMcp(mcpServers, (text) => this.push(conversationId, { id: uid("item"), kind: "notice", text, at: nowIso() }));
      const system = [await systemPrompt(project, skills), integrationPrompt(project, accounts, mcp)].filter(Boolean).join("\n\n");
      for (let step = 0; step < MAX_STEPS; step++) {
        if (this.stopRequests.has(conversationId)) return this.finishStopped(conversationId);
        const c = this.host.conversation(conversationId)!;
        const provider = this.host.provider(c.providerId);
        if (!provider) throw new Error("Wybrany model nie jest już dostępny. Wybierz inny model u góry rozmowy.");
        const reply = await api.agentTurn(provider, c.model || provider.model, system, c.api, [...toolsFor(project, skills, c.toolsUnsupported), ...(c.toolsUnsupported ? [] : integrationTools(project, accounts, mcp))]);
        if (this.stopRequests.has(conversationId)) return this.finishStopped(conversationId);
        const assistant: AgentMessage = { role: "assistant", text: reply.text, toolCalls: reply.toolCalls };
        this.host.update(conversationId, (cur) => ({
          ...cur,
          api: [...cur.api, assistant],
          usage: { input: cur.usage.input + reply.inputTokens, output: cur.usage.output + reply.outputTokens },
          toolsUnsupported: cur.toolsUnsupported || reply.toolsUnsupported,
        }));
        if (reply.toolsUnsupported && project) {
          this.push(conversationId, { id: uid("item"), kind: "notice", text: "Ten model nie obsługuje narzędzi, więc nie widzi plików projektu — może tylko rozmawiać. Do pracy na plikach wybierz model z obsługą narzędzi.", at: nowIso() });
        }
        if (reply.toolCalls.length === 0) {
          this.push(conversationId, { id: uid("item"), kind: "result", text: reply.text || "(model nie zwrócił treści)", warnings, at: nowIso() });
          this.setStatus(conversationId, warnings.length ? "warning" : "done");
          return;
        }
        if (reply.text.trim()) this.push(conversationId, { id: uid("item"), kind: "assistant", text: reply.text, at: nowIso() });
        for (const call of reply.toolCalls) {
          const result = this.stopRequests.has(conversationId)
            ? { content: "Przerwano przez użytkownika.", isError: true }
            : INTEGRATION_TOOLS.has(call.name) || mcp.has(call.name)
              ? await this.executeIntegration(conversationId, project, call, mcp, warnings)
              : await this.execute(conversationId, project, call, warnings, skills);
          this.host.update(conversationId, (cur) => ({
            ...cur,
            api: [...cur.api, { role: "tool", toolCallId: call.id, content: result.content, isError: result.isError }],
          }));
        }
      }
      warnings.push(`Osiągnięto limit ${MAX_STEPS} kroków w jednym przebiegu.`);
      this.push(conversationId, { id: uid("item"), kind: "notice", text: `Agent wykonał ${MAX_STEPS} kroków i zatrzymał się, żeby nie pracować bez końca. Napisz „kontynuuj”, jeśli ma działać dalej.`, at: nowIso() });
      this.setStatus(conversationId, "warning");
    } catch (error) {
      this.push(conversationId, { id: uid("item"), kind: "error", text: error instanceof Error ? error.message : String(error), at: nowIso() });
      this.setStatus(conversationId, "failed");
    } finally {
      this.active.delete(conversationId);
      this.stopRequests.delete(conversationId);
      this.onChange();
    }
  }

  private async executeIntegration(conversationId: string, project: Project | null, call: ToolCall, mcp: Map<string, McpBinding>, warnings: string[]): Promise<{ content: string; isError: boolean }> {
    const ctx = {
      project,
      accounts: this.host.settings().accounts,
      action: (title: string) => {
        const id = uid("item");
        this.push(conversationId, { id, kind: "action", tool: call.name, title, status: "running", at: nowIso() });
        return id;
      },
      finish: (id: string, ok: boolean, output: string) => {
        this.patchItem(conversationId, id, { status: ok ? "done" : "failed", output: output.slice(0, 4000) } as Partial<ConversationItem>);
        if (!ok) warnings.push(output.split("\n")[0].slice(0, 200));
      },
      progress: (id: string, title: string) => this.patchItem(conversationId, id, { title } as Partial<ConversationItem>),
      approve: async (tool: string, title: string, detail: string, danger?: boolean) => {
        const id = uid("item");
        this.push(conversationId, { id, kind: "approval", tool, title, detail, danger, status: "pending", at: nowIso() });
        const decision = await this.wait(conversationId, id);
        this.patchItem(conversationId, id, { status: decision.approved ? "approved" : "rejected" } as Partial<ConversationItem>);
        return decision;
      },
      notice: (text: string) => this.push(conversationId, { id: uid("item"), kind: "notice", text, at: nowIso() }),
      stopped: () => this.stopRequests.has(conversationId),
      saveProject: (patch: Partial<Project>) => { if (project) { this.host.saveProject(project.id, patch); Object.assign(project, patch); } },
    };
    try {
      return await runIntegrationTool(ctx, call.name, call.input ?? {}, mcp);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.update(conversationId, (c) => ({ ...c, items: c.items.map((i) => (i.kind === "action" && i.status === "running" ? { ...i, status: "failed" as const, output: message } : i)) }));
      return { content: `Błąd: ${message}`, isError: true };
    }
  }

  private finishStopped(conversationId: string) {
    this.push(conversationId, { id: uid("item"), kind: "notice", text: "Zatrzymano na Twoją prośbę. Zmiany wykonane do tej pory zostały zachowane i można je cofnąć.", at: nowIso() });
    this.setStatus(conversationId, "stopped");
  }

  private async execute(conversationId: string, project: Project | null, call: ToolCall, warnings: string[], skills: InstalledSkill[]): Promise<{ content: string; isError: boolean }> {
    const input = call.input ?? {};
    const skillTool = ["use_skill", "read_skill_file", "find_skills", "install_skill"].includes(call.name);
    if (!project && !skillTool) return { content: "Brak projektu — narzędzia plikowe są niedostępne.", isError: true };
    const findSkill = (name: string) => {
      const n = name.trim().toLowerCase();
      return skills.find((s) => s.name.toLowerCase() === n) ?? skills.find((s) => s.slug === n) ?? skills.find((s) => s.name.toLowerCase().includes(n));
    };
    const action = (title: string) => {
      const id = uid("item");
      this.push(conversationId, { id, kind: "action", tool: call.name, title, status: "running", at: nowIso() });
      return id;
    };
    const finish = (id: string, ok: boolean, output: string) => this.patchItem(conversationId, id, { status: ok ? "done" : "failed", output: output.slice(0, 4000) } as Partial<ConversationItem>);

    try {
      if (skillTool) return await this.executeSkill(conversationId, project, call.name, input, skills, findSkill, action, finish);
      if (!project) return { content: "Brak projektu.", isError: true };
      switch (call.name) {
        case "list_files": {
          const path = str(input.path);
          const id = action(path ? `Przegląda folder ${path}` : "Przegląda pliki projektu");
          const entries = await api.listFiles(project.path, path, Number(input.depth) || 2);
          const text = entries.length ? entries.map((e) => (e.kind === "dir" ? `${e.path}/` : `${e.path} (${e.size} B)`)).join("\n") : "(folder jest pusty)";
          finish(id, true, `${entries.length} pozycji`);
          return { content: text, isError: false };
        }
        case "read_file": {
          const path = str(input.path);
          const id = action(`Czyta ${path}`);
          const text = await api.readFile(project.path, path);
          finish(id, true, `${text.length.toLocaleString("pl-PL")} znaków`);
          return { content: text, isError: false };
        }
        case "search_files": {
          const query = str(input.query);
          const id = action(`Szuka „${query}”`);
          const hits = await api.searchFiles(project.path, query);
          finish(id, true, `${hits.length} trafień`);
          return { content: hits.join("\n") || "Brak trafień.", isError: false };
        }
        case "propose_plan": {
          const steps: PlanStep[] = (Array.isArray(input.steps) ? input.steps : []).map((s) => ({ title: str(s), status: "todo" as const }));
          const id = uid("item");
          const auto = project.accessMode === "auto";
          this.push(conversationId, { id, kind: "plan", goal: str(input.goal), steps, decision: auto ? "approved" : "pending", at: nowIso() });
          if (auto) return { content: "Plan przyjęty automatycznie (tryb automatyczny). Wykonuj.", isError: false };
          const decision = await this.wait(conversationId, id);
          if (decision.stopped) return { content: "Przerwano.", isError: true };
          if (decision.approved) {
            this.patchItem(conversationId, id, { decision: "approved" } as Partial<ConversationItem>);
            return { content: "Użytkownik zatwierdził plan. Wykonuj go krok po kroku.", isError: false };
          }
          this.patchItem(conversationId, id, { decision: "changed" } as Partial<ConversationItem>);
          if (decision.feedback) this.push(conversationId, { id: uid("item"), kind: "user", text: decision.feedback, at: nowIso() });
          return { content: `Użytkownik nie zatwierdził planu. Jego uwagi: ${decision.feedback || "(brak)"}. Popraw plan i przedstaw go ponownie.`, isError: false };
        }
        case "mark_step": {
          const index = Number(input.step) - 1;
          const status = str(input.status) === "done" ? "done" : "doing";
          this.host.update(conversationId, (c) => {
            const planIndex = [...c.items].reverse().findIndex((i) => i.kind === "plan");
            if (planIndex < 0) return c;
            const realIndex = c.items.length - 1 - planIndex;
            const items = [...c.items];
            const plan = items[realIndex];
            if (plan.kind !== "plan" || !plan.steps[index]) return c;
            items[realIndex] = { ...plan, steps: plan.steps.map((s, i) => (i === index ? { ...s, status } : s)) };
            return { ...c, items };
          });
          return { content: "ok", isError: false };
        }
        case "write_file": {
          if (project.accessMode === "read") return { content: "Projekt jest w trybie tylko do odczytu.", isError: true };
          const path = str(input.path);
          const content = str(input.content);
          let before = "";
          let exists = true;
          try { before = await api.readFile(project.path, path); } catch { exists = false; }
          const diff = lineDiff(before, content);
          if (project.accessMode === "ask") {
            const id = uid("item");
            this.push(conversationId, {
              id, kind: "approval", tool: "write_file",
              title: exists ? `Zmienić plik ${path}?` : `Utworzyć plik ${path}?`,
              detail: exists ? `+${diff.added} / −${diff.removed} linii` : `${diff.added} linii`,
              diff: diff.lines, added: diff.added, removed: diff.removed, status: "pending", at: nowIso(),
            });
            const decision = await this.wait(conversationId, id);
            this.patchItem(conversationId, id, { status: decision.approved ? "approved" : "rejected" } as Partial<ConversationItem>);
            if (decision.stopped) return { content: "Przerwano.", isError: true };
            if (!decision.approved) {
              warnings.push(`Odrzucono zmianę pliku ${path}.`);
              return { content: `Użytkownik odrzucił zapis ${path}.${decision.feedback ? ` Uwagi: ${decision.feedback}` : ""} Nie ponawiaj tej zmiany bez pytania.`, isError: false };
            }
          }
          const record = await api.writeFile(project.path, path, content, conversationId);
          const change: Change = { id: record.id, conversationId, path: record.path, kind: record.kind, added: diff.added, removed: diff.removed, at: nowIso(), undone: false, preview: diff.lines.slice(0, 200) };
          this.host.update(conversationId, (c) => ({ ...c, changes: [...c.changes, change] }));
          this.push(conversationId, { id: uid("item"), kind: "change", changeId: record.id, path: record.path, change: record.kind, added: diff.added, removed: diff.removed, at: nowIso() });
          return { content: `Zapisano ${record.path} (+${diff.added}/−${diff.removed} linii).`, isError: false };
        }
        case "run_command": {
          if (project.accessMode === "read") return { content: "Projekt jest w trybie tylko do odczytu.", isError: true };
          const command = str(input.command);
          const approvalId = uid("item");
          this.push(conversationId, { id: approvalId, kind: "approval", tool: "run_command", title: "Uruchomić polecenie w Terminalu?", detail: `${command}\n\nPo co: ${str(input.reason) || "nie podano"}`, status: "pending", at: nowIso() });
          const decision = await this.wait(conversationId, approvalId);
          this.patchItem(conversationId, approvalId, { status: decision.approved ? "approved" : "rejected" } as Partial<ConversationItem>);
          if (decision.stopped) return { content: "Przerwano.", isError: true };
          if (!decision.approved) return { content: `Użytkownik nie zgodził się na polecenie.${decision.feedback ? ` Uwagi: ${decision.feedback}` : ""}`, isError: false };
          const id = action(`Uruchamia: ${command}`);
          const result = await api.runCommand(project.path, command);
          const ok = result.exitCode === 0 && !result.timedOut;
          const summary = result.timedOut ? "Przekroczono limit czasu — polecenie zatrzymano." : `Kod wyjścia ${result.exitCode ?? "?"} · ${(result.durationMs / 1000).toFixed(1)} s`;
          finish(id, ok, `${summary}\n${(result.stdout + "\n" + result.stderr).trim().slice(-3000)}`);
          if (!ok) warnings.push(`Polecenie nie powiodło się: ${command}`);
          return { content: `${summary}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`, isError: !ok };
        }
        default:
          return { content: `Nieznane narzędzie: ${call.name}`, isError: true };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.update(conversationId, (c) => ({
        ...c,
        items: c.items.map((i) => (i.kind === "action" && i.status === "running" ? { ...i, status: "failed" as const, output: message } : i)),
      }));
      return { content: `Błąd: ${message}`, isError: true };
    }
  }
}

type ActionFn = (title: string) => string;
type FinishFn = (id: string, ok: boolean, output: string) => void;

export interface AgentRunner {
  executeSkill(
    conversationId: string, project: Project | null, name: string, input: Record<string, unknown>,
    skills: InstalledSkill[], findSkill: (name: string) => InstalledSkill | undefined, action: ActionFn, finish: FinishFn,
  ): Promise<{ content: string; isError: boolean }>;
}

AgentRunner.prototype.executeSkill = async function (this: AgentRunner, conversationId, project, name, input, skills, findSkill, action, finish) {
  const self = this as unknown as { push: (id: string, item: ConversationItem) => void; patchItem: (c: string, i: string, p: Partial<ConversationItem>) => void; wait: (c: string, i: string) => Promise<Decision>; host: Host };
  switch (name) {
    case "use_skill":
    case "read_skill_file": {
      const skill = findSkill(str(input.name));
      if (!skill) return { content: `Nie ma zainstalowanej umiejętności „${str(input.name)}”. Dostępne: ${skills.map((s) => s.name).join(", ") || "brak"}.`, isError: true };
      const file = name === "read_skill_file" ? str(input.path) : undefined;
      const id = action(file ? `Czyta ${file} z umiejętności ${skill.name}` : `Korzysta z umiejętności ${skill.name}`);
      const data = await api.skillRead(skill.key, project?.path, file);
      finish(id, true, `${data.content.length.toLocaleString("pl-PL")} znaków`);
      if (file) return { content: data.content, isError: false };
      return {
        content: `Umiejętność: ${skill.name}\nFolder umiejętności: ${data.dir}\nPliki: ${data.files.join(", ")}\n\nŚcieżki względne w instrukcjach odnoszą się do folderu umiejętności. Dodatkowe pliki czytaj narzędziem read_skill_file. Skrypty uruchamiaj przez run_command, podając pełną ścieżkę — użytkownik każde polecenie zatwierdza.\n\n${data.content}`,
        isError: false,
      };
    }
    case "find_skills": {
      const query = str(input.query);
      const id = action(`Szuka umiejętności „${query}”`);
      const result = await api.skillSearch(query, self.host.settings().skillSources);
      const found = [...result.catalog, ...result.community];
      finish(id, true, `${found.length} umiejętności, ${result.repos.length} repozytoriów`);
      const lines = [
        ...found.slice(0, 15).map((s) => `- ${s.name} — ${s.description.slice(0, 200)} [${s.origin === "catalog" ? "katalog" : "społeczność"}] adres: ${s.url}`),
        ...(result.repos.length ? ["Repozytoria, które mogą zawierać umiejętności:", ...result.repos.slice(0, 8).map((r) => `- ${r.repo} ★${r.stars} — ${r.description.slice(0, 160)} adres: ${r.url}`)] : []),
        ...result.errors.map((e) => `Uwaga: ${e}`),
      ];
      return { content: lines.join("\n") || "Nic nie znaleziono.", isError: false };
    }
    case "install_skill": {
      if (project?.accessMode === "read") return { content: "Projekt jest w trybie tylko do odczytu — instalacja niedostępna.", isError: true };
      const source = str(input.source);
      const id = action(`Sprawdza umiejętność ${source}`);
      const candidates = await api.skillInspect(source);
      const wanted = str(input.name).toLowerCase();
      const chosen = candidates.length === 1 ? candidates[0] : candidates.find((c) => c.name.toLowerCase() === wanted || c.dir.toLowerCase().endsWith(wanted));
      if (!chosen) {
        finish(id, true, `${candidates.length} umiejętności pod adresem`);
        return { content: `Pod tym adresem jest kilka umiejętności. Wskaż jedną parametrem name:\n${candidates.slice(0, 40).map((c) => `- ${c.name} — ${c.description.slice(0, 120)}`).join("\n")}`, isError: false };
      }
      const preview = await api.skillPreview(chosen);
      finish(id, !preview.blocked, preview.blocked ?? `${preview.files.length} plików`);
      if (preview.blocked) return { content: `Nie można zainstalować: ${preview.blocked}`, isError: true };
      const scope: "global" | "project" = project ? "project" : "global";
      const approvalId = uid("item");
      const scripts = preview.files.filter((f) => f.script).length;
      self.push(conversationId, {
        id: approvalId, kind: "approval", tool: "install_skill",
        title: `Zainstalować umiejętność „${chosen.name}”?`,
        detail: [
          chosen.description,
          "",
          `Źródło: ${chosen.url}`,
          `Pliki: ${preview.files.length}${scripts ? ` · skrypty: ${scripts} (nie są uruchamiane automatycznie)` : ""}`,
          `Miejsce: ${scope === "project" ? `projekt „${project!.name}” (.agentos/skills)` : "wszystkie projekty"}`,
          `Po co: ${str(input.reason) || "nie podano"}`,
          ...(preview.risks.length ? ["", "Do sprawdzenia:", ...preview.risks.slice(0, 12).map((r) => `• ${r}`)] : []),
        ].join("\n"),
        status: "pending", at: nowIso(),
      });
      const decision = await self.wait(conversationId, approvalId);
      self.patchItem(conversationId, approvalId, { status: decision.approved ? "approved" : "rejected" } as Partial<ConversationItem>);
      if (decision.stopped) return { content: "Przerwano.", isError: true };
      if (!decision.approved) return { content: `Użytkownik nie zgodził się na instalację.${decision.feedback ? ` Uwagi: ${decision.feedback}` : ""}`, isError: false };
      let installed: InstalledSkill;
      try {
        installed = await api.skillInstall(chosen, scope, project?.path ?? null, false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith("EXISTS:")) throw error;
        return { content: `Umiejętność „${chosen.name}” jest już zainstalowana. Użyj use_skill.`, isError: false };
      }
      skills.push(installed);
      self.push(conversationId, { id: uid("item"), kind: "notice", text: `Zainstalowano umiejętność „${installed.name}”. Możesz nią zarządzać w ekranie Umiejętności.`, at: nowIso() });
      return { content: `Zainstalowano „${installed.name}”. Teraz wywołaj use_skill z nazwą „${installed.name}”.`, isError: false };
    }
  }
  return { content: `Nieznane narzędzie: ${name}`, isError: true };
};

/** Dopisuje brakujące wyniki narzędzi, aby przerwaną rozmowę dało się wznowić. */
export function sanitize(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  messages.forEach((message, index) => {
    out.push(message);
    if (message.role !== "assistant" || message.toolCalls.length === 0) return;
    const answered = new Set<string>();
    for (let k = index + 1; k < messages.length; k++) {
      const next = messages[k];
      if (next.role !== "tool") break;
      answered.add(next.toolCallId);
    }
    for (const call of message.toolCalls) {
      if (!answered.has(call.id)) out.push({ role: "tool", toolCallId: call.id, content: "Przerwano przed wykonaniem.", isError: true });
    }
  });
  // Dopisane wyniki trafiają zaraz po wywołaniu, przed istniejącymi wynikami — kolejność w bloku nie ma znaczenia.
  return out;
}

/** Cofa zmianę; przy konflikcie pyta użytkownika. */
export async function undoChange(change: Change, confirm: (text: string) => Promise<boolean>): Promise<string> {
  try {
    return await api.undoChange(change.conversationId, change.id, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("CONFLICT:") && await confirm(`${message.replace("CONFLICT: ", "")}\n\nCofnąć mimo to?`)) {
      return api.undoChange(change.conversationId, change.id, true);
    }
    throw new Error(message.replace("CONFLICT: ", ""));
  }
}
