// Narzędzia agenta dla git/GitHub, Vercel, Supabase i serwerów MCP.
import type { ToolSpec } from "./api";
import { api } from "./api";
import { formatRows, isReadOnlySql, mcpToolName, SCHEMA_SQL, waitForDeployment, deployStateLabel } from "./integrations";
import type { McpServer, McpTool, Project } from "./types";

export type Accounts = { github?: string; vercel?: string; supabase?: string };

export type IntegrationCtx = {
  project: Project | null;
  accounts: Accounts;
  action: (title: string) => string;
  finish: (id: string, ok: boolean, output: string) => void;
  progress: (id: string, title: string) => void;
  approve: (tool: string, title: string, detail: string, danger?: boolean) => Promise<{ approved: boolean; feedback?: string; stopped?: boolean }>;
  notice: (text: string) => void;
  stopped: () => boolean;
  saveProject: (patch: Partial<Project>) => void;
};

export type McpBinding = { server: McpServer; tool: McpTool };

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

const SPECS: Record<string, ToolSpec> = {
  git_status: { name: "git_status", description: "Pokazuje gałąź, zmienione pliki i stan synchronizacji z GitHubem.", parameters: obj({}) },
  git_commit: { name: "git_commit", description: "Zatwierdza (commit) wszystkie zmiany w projekcie z opisem. Użytkownik zatwierdza.", parameters: obj({ message: { type: "string", description: "Krótki opis zmian po polsku" } }, ["message"]) },
  git_branch: { name: "git_branch", description: "Tworzy nową gałąź i przełącza się na nią (np. przed pull requestem).", parameters: obj({ name: { type: "string" } }, ["name"]) },
  git_push: { name: "git_push", description: "Wypycha bieżącą gałąź na GitHub. Wypchnięcie na main bywa zablokowane — wtedy utwórz gałąź i pull request.", parameters: obj({ reason: { type: "string" } }) },
  github_create_pr: { name: "github_create_pr", description: "Tworzy pull request z bieżącej gałęzi do gałęzi głównej.", parameters: obj({ title: { type: "string" }, body: { type: "string" } }, ["title", "body"]) },
  vercel_deploy: { name: "vercel_deploy", description: "Wdraża projekt na Vercel. target=preview tworzy wersję podglądową, production — publiczną. Czeka na zbudowanie; przy błędzie zwraca logi.", parameters: obj({ target: { type: "string", enum: ["preview", "production"] } }, ["target"]) },
  vercel_logs: { name: "vercel_logs", description: "Pobiera logi budowania ostatniego (lub wskazanego) wdrożenia Vercel.", parameters: obj({ deployment_id: { type: "string" } }) },
  supabase_schema: { name: "supabase_schema", description: "Lista tabel i kolumn w schemacie public połączonej bazy Supabase.", parameters: obj({}) },
  supabase_sql: { name: "supabase_sql", description: "Wykonuje SQL w połączonej bazie Supabase. Zapytania tylko do odczytu wykonują się od razu; zmiany danych lub schematu wymagają zgody użytkownika. Zmiany schematu zapisuj też jako plik w supabase/migrations.", parameters: obj({ sql: { type: "string" }, reason: { type: "string" } }, ["sql", "reason"]) },
};

export const INTEGRATION_TOOLS = new Set(Object.keys(SPECS));

export function integrationTools(project: Project | null, accounts: Accounts, mcp: Map<string, McpBinding>): ToolSpec[] {
  const out: ToolSpec[] = [];
  if (project) {
    out.push(SPECS.git_status);
    if (project.accessMode !== "read") {
      out.push(SPECS.git_commit, SPECS.git_branch, SPECS.git_push);
      if (accounts.github) out.push(SPECS.github_create_pr);
      if (accounts.vercel) out.push(SPECS.vercel_deploy);
    }
    if (accounts.vercel && project.integrations?.vercel?.projectId) out.push(SPECS.vercel_logs);
    if (accounts.supabase && project.integrations?.supabase) out.push(SPECS.supabase_schema, SPECS.supabase_sql);
  }
  for (const [name, binding] of mcp) {
    out.push({ name, description: `[${binding.server.name}] ${binding.tool.description}`.slice(0, 1000), parameters: binding.tool.inputSchema });
  }
  return out;
}

export function integrationPrompt(project: Project | null, accounts: Accounts, mcp: Map<string, McpBinding>): string {
  const lines: string[] = [];
  if (project) {
    lines.push("Publikacja: projekt możesz zapisać w historii wersji (git_commit), wypchnąć na GitHub (git_push), otworzyć pull request i wdrożyć na Vercel. Przed wypchnięciem i wdrożeniem upewnij się, że projekt się buduje. Nigdy nie zatwierdzaj plików z hasłami (.env).");
    if (!accounts.github) lines.push("GitHub nie jest połączony — do wypchnięcia przez HTTPS użytkownik musi dodać token w ekranie Integracje.");
    if (project.integrations?.vercel) lines.push(`Vercel: projekt „${project.integrations.vercel.name}”.`);
    else if (accounts.vercel) lines.push("Vercel jest połączony, ale projekt nie jest jeszcze powiązany — pierwsze wdrożenie utworzy nowy projekt Vercel.");
    if (project.integrations?.supabase) lines.push(`Supabase: baza projektu „${project.integrations.supabase.name}” (ref ${project.integrations.supabase.ref}), adres https://${project.integrations.supabase.ref}.supabase.co.`);
  }
  if (mcp.size) lines.push(`Dostępne narzędzia z serwerów MCP: ${[...new Set([...mcp.values()].map((b) => b.server.name))].join(", ")} (nazwy zaczynają się od mcp_).`);
  return lines.join("\n");
}

export async function prepareMcp(servers: McpServer[], notice: (t: string) => void): Promise<Map<string, McpBinding>> {
  const map = new Map<string, McpBinding>();
  for (const server of servers.filter((s) => s.enabled)) {
    try {
      const tools = await api.mcpStart(server);
      for (const tool of tools.slice(0, 60)) map.set(mcpToolName(server.name, tool.name), { server, tool });
    } catch (error) {
      notice(`Serwer MCP „${server.name}” nie uruchomił się: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  return map;
}

export async function runIntegrationTool(ctx: IntegrationCtx, name: string, input: Record<string, unknown>, mcp: Map<string, McpBinding>): Promise<{ content: string; isError: boolean }> {
  const binding = mcp.get(name);
  if (binding) {
    const args = JSON.stringify(input, null, 2);
    if (!binding.server.autoApprove) {
      const d = await ctx.approve("mcp", `Użyć narzędzia „${binding.tool.name}” z serwera ${binding.server.name}?`, `${binding.tool.description.slice(0, 300)}\n\nArgumenty:\n${args.slice(0, 3000)}`);
      if (d.stopped) return { content: "Przerwano.", isError: true };
      if (!d.approved) return { content: `Użytkownik odmówił.${d.feedback ? ` Uwagi: ${d.feedback}` : ""}`, isError: false };
    }
    const id = ctx.action(`${binding.server.name}: ${binding.tool.name}`);
    const result = await api.mcpCall(binding.server.id, binding.tool.name, input);
    ctx.finish(id, !result.isError, result.text.slice(0, 2000));
    return { content: result.text || "(pusta odpowiedź)", isError: result.isError };
  }

  const project = ctx.project;
  if (!project) return { content: "Brak projektu.", isError: true };
  const path = project.path;

  switch (name) {
    case "git_status": {
      const id = ctx.action("Sprawdza stan wersji (git)");
      const s = await api.gitStatus(path);
      if (!s.isRepo) { ctx.finish(id, true, "brak historii wersji"); return { content: "Projekt nie ma historii wersji (git). git_commit ją utworzy.", isError: false }; }
      ctx.finish(id, true, `${s.branch} · ${s.files.length} zmian`);
      return { content: [`Gałąź: ${s.branch}`, `Zdalne: ${s.remote ?? "brak"}`, `Przed/za zdalnym: +${s.ahead}/−${s.behind}`, `Ostatni commit: ${s.lastCommit ?? "brak"}`, `Zmiany (${s.files.length}):`, ...s.files.slice(0, 100).map((f) => `- ${f.status}: ${f.path}`), ...(s.sensitive.length ? [`UWAGA, pliki mogące zawierać hasła: ${s.sensitive.join(", ")}`] : [])].join("\n"), isError: false };
    }
    case "git_commit": {
      let s = await api.gitStatus(path);
      if (!s.isRepo) { await api.gitInit(path); s = await api.gitStatus(path); ctx.notice("Włączono historię wersji (git) w projekcie."); }
      if (!s.files.length) return { content: "Brak zmian do zatwierdzenia.", isError: false };
      const message = str(input.message);
      const d = await ctx.approve("git_commit", "Zatwierdzić zmiany w historii wersji?", `Opis: ${message}\n\nPliki (${s.files.length}):\n${s.files.slice(0, 40).map((f) => `• ${f.status}: ${f.path}`).join("\n")}${s.files.length > 40 ? `\n… i ${s.files.length - 40} kolejnych` : ""}${s.sensitive.length ? `\n\n⚠ Mogą zawierać hasła: ${s.sensitive.join(", ")}` : ""}`, s.sensitive.length > 0);
      if (d.stopped) return { content: "Przerwano.", isError: true };
      if (!d.approved) return { content: `Użytkownik nie zatwierdził.${d.feedback ? ` Uwagi: ${d.feedback}` : ""}`, isError: false };
      const author = ctx.accounts.github ? await api.githubUser().catch(() => undefined) : undefined;
      const id = ctx.action("Zatwierdza zmiany (commit)");
      const out = await api.gitCommit(path, message, s.sensitive.length > 0, author);
      ctx.finish(id, true, out);
      return { content: `Zatwierdzono: ${out}`, isError: false };
    }
    case "git_branch": {
      const id = ctx.action(`Tworzy gałąź ${str(input.name)}`);
      const branch = await api.gitBranch(path, str(input.name));
      ctx.finish(id, true, branch);
      return { content: `Utworzono i przełączono na gałąź ${branch}.`, isError: false };
    }
    case "git_push": {
      const s = await api.gitStatus(path);
      if (!s.remote) return { content: "Projekt nie ma zdalnego repozytorium. Poproś użytkownika, by utworzył je w zakładce Publikacja (Utwórz repozytorium na GitHubie).", isError: true };
      const protectedBranch = (s.branch === "main" || s.branch === "master");
      if (protectedBranch && !project.integrations?.allowMainPush) {
        return { content: `Wypchnięcie bezpośrednio na ${s.branch} jest zablokowane w tym projekcie. Utwórz gałąź (git_branch), wypchnij ją i otwórz pull request (github_create_pr).`, isError: true };
      }
      const d = await ctx.approve("git_push", `Wypchnąć gałąź ${s.branch} na GitHub?`, `Repozytorium: ${s.githubRepo ?? s.remote}\nCommitów do wysłania: ${s.ahead || "?"}\n${str(input.reason) ? `Po co: ${str(input.reason)}` : ""}${s.files.length ? `\n⚠ Niezatwierdzone zmiany (${s.files.length}) nie zostaną wysłane.` : ""}`, protectedBranch);
      if (d.stopped) return { content: "Przerwano.", isError: true };
      if (!d.approved) return { content: `Użytkownik nie zgodził się na wypchnięcie.${d.feedback ? ` Uwagi: ${d.feedback}` : ""}`, isError: false };
      const id = ctx.action(`Wypycha ${s.branch} na GitHub`);
      const out = await api.gitPush(path, protectedBranch);
      ctx.finish(id, true, out);
      return { content: out, isError: false };
    }
    case "github_create_pr": {
      const d = await ctx.approve("github_pr", `Utworzyć pull request „${str(input.title)}”?`, str(input.body).slice(0, 3000));
      if (d.stopped) return { content: "Przerwano.", isError: true };
      if (!d.approved) return { content: "Użytkownik nie zgodził się.", isError: false };
      const id = ctx.action("Tworzy pull request");
      const url = await api.githubCreatePr(path, str(input.title), str(input.body));
      ctx.finish(id, true, url);
      ctx.notice(`Pull request: ${url}`);
      return { content: `Utworzono pull request: ${url}`, isError: false };
    }
    case "vercel_deploy": {
      const production = str(input.target) === "production";
      const link = project.integrations?.vercel;
      const d = await ctx.approve(
        "vercel_deploy",
        production ? "Wdrożyć na PRODUKCJĘ (wersja publiczna)?" : "Wdrożyć wersję podglądową na Vercel?",
        `${link ? `Projekt Vercel: ${link.name}` : `Nowy projekt Vercel: ${project.name}`}\nPliki projektu zostaną wysłane do Vercel (bez .env, node_modules, .git).${production ? "\n\nTa wersja zastąpi obecną wersję publiczną. Poprzednią można przywrócić w zakładce Publikacja." : ""}`,
        production,
      );
      if (d.stopped) return { content: "Przerwano.", isError: true };
      if (!d.approved) return { content: `Użytkownik nie zgodził się na wdrożenie.${d.feedback ? ` Uwagi: ${d.feedback}` : ""}`, isError: false };
      const id = ctx.action(production ? "Wdraża na produkcję (Vercel)" : "Wdraża wersję podglądową (Vercel)");
      const dep = await api.vercelDeploy(path, link?.name ?? project.name, link?.projectId, link?.teamId, production);
      if (!link?.projectId && dep.projectId) ctx.saveProject({ integrations: { ...project.integrations, vercel: { projectId: dep.projectId, name: link?.name ?? project.name, teamId: link?.teamId ?? null } } });
      ctx.progress(id, `Vercel buduje (${dep.files} plików)…`);
      const result = await waitForDeployment(dep.id, link?.teamId, (state) => ctx.progress(id, `Vercel: ${deployStateLabel[state] ?? state}`), ctx.stopped);
      if (result.state === "READY") {
        ctx.finish(id, true, `Gotowe: ${result.url ?? dep.url}`);
        ctx.notice(`Wdrożenie gotowe: ${result.url ?? dep.url}`);
        return { content: `Wdrożenie gotowe (${production ? "produkcja" : "podgląd"}): ${result.url ?? dep.url}`, isError: false };
      }
      const logs = result.state === "ERROR" ? await api.vercelLogs(dep.id, link?.teamId).catch(() => "") : "";
      ctx.finish(id, false, `${deployStateLabel[result.state] ?? result.state}${result.error ? `: ${result.error}` : ""}`);
      return { content: `Wdrożenie zakończone stanem ${result.state}. ${result.error ?? ""}\n\nLogi budowania (koniec):\n${logs.slice(-8000)}`, isError: true };
    }
    case "vercel_logs": {
      const link = project.integrations?.vercel;
      let depId = str(input.deployment_id);
      if (!depId && link?.projectId) depId = (await api.vercelDeployments(link.projectId, link.teamId))[0]?.id ?? "";
      if (!depId) return { content: "Brak wdrożeń.", isError: true };
      const id = ctx.action("Pobiera logi wdrożenia");
      const logs = await api.vercelLogs(depId, link?.teamId);
      ctx.finish(id, true, `${logs.length} znaków`);
      return { content: logs.slice(-15000), isError: false };
    }
    case "supabase_schema": {
      const ref = project.integrations!.supabase!.ref;
      const id = ctx.action("Odczytuje strukturę bazy Supabase");
      const rows = await api.supabaseQuery(ref, SCHEMA_SQL, true);
      ctx.finish(id, true, Array.isArray(rows) ? `${rows.length} tabel` : "ok");
      return { content: formatRows(rows, 200), isError: false };
    }
    case "supabase_sql": {
      const ref = project.integrations!.supabase!.ref;
      const sql = str(input.sql);
      const readOnly = isReadOnlySql(sql);
      if (!readOnly) {
        if (project.accessMode === "read") return { content: "Projekt jest w trybie tylko do odczytu — zmiany w bazie są niedostępne.", isError: true };
        const d = await ctx.approve("supabase_sql", "Wykonać zmianę w bazie danych Supabase?", `Baza: ${project.integrations!.supabase!.name}\nPo co: ${str(input.reason)}\n\n${sql.slice(0, 6000)}\n\nZmian w bazie nie da się cofnąć przyciskiem „Cofnij”.`, true);
        if (d.stopped) return { content: "Przerwano.", isError: true };
        if (!d.approved) return { content: `Użytkownik nie zgodził się na zmianę w bazie.${d.feedback ? ` Uwagi: ${d.feedback}` : ""}`, isError: false };
      }
      const id = ctx.action(readOnly ? "Odczytuje dane z Supabase" : "Wykonuje zmianę w bazie Supabase");
      const rows = await api.supabaseQuery(ref, sql, readOnly);
      ctx.finish(id, true, Array.isArray(rows) ? `${rows.length} wierszy` : "wykonano");
      return { content: formatRows(rows), isError: false };
    }
  }
  return { content: `Nieznane narzędzie: ${name}`, isError: true };
}
