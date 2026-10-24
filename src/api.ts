// Jedyne miejsce, w którym interfejs rozmawia z backendem Tauri.
import { invoke } from "@tauri-apps/api/core";
import type { AgentMessage, GitStatus, InstalledSkill, McpServer, McpTool, Provider, RemoteSkill, SkillPreview, SkillSearchResult, ToolCall, VercelDeployment } from "./types";

export const inDesktopApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export class DesktopOnlyError extends Error {
  constructor() {
    super("Ta funkcja działa tylko w aplikacji AgentOS na Macu (nie w podglądzie przeglądarki).");
  }
}

export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!inDesktopApp) throw new DesktopOnlyError();
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(typeof error === "string" ? error : error instanceof Error ? error.message : String(error));
  }
}

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type AgentReply = {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  toolsUnsupported: boolean;
};

export const api = {
  getSnapshot: () => call<unknown>("get_snapshot"),
  saveSnapshot: (snapshot: unknown) => call<void>("save_snapshot", { snapshot }),
  backupSnapshot: (label: string) => call<boolean>("backup_snapshot", { label }),
  keyStatuses: (providerIds: string[]) => call<Array<{ providerId: string; hasKey: boolean }>>("get_provider_key_statuses", { providerIds }),
  saveProvider: (provider: Provider, apiKey: string) =>
    call<{ providerId: string; hasKey: boolean }>("save_provider", {
      provider: { id: provider.id, name: provider.name, kind: provider.kind, model: provider.model, endpoint: provider.endpoint, hasKey: provider.hasKey, latency: "", tone: "cyan" },
      apiKey,
    }),
  listModels: (provider: Provider) => call<string[]>("list_models", { providerId: provider.id, providerKind: provider.kind, endpoint: provider.endpoint }),
  agentTurn: (provider: Provider, model: string, system: string, messages: AgentMessage[], tools: ToolSpec[]) =>
    call<AgentReply>("agent_turn", { providerId: provider.id, providerKind: provider.kind, endpoint: provider.endpoint, model, system, messages, tools }),
  inspectProject: (path: string) => call<{ name: string; path: string; contextFiles: string[] }>("inspect_project", { path }),
  readContextFiles: (path: string) => call<Array<{ name: string; path: string; content: string }>>("read_project_context", { path }),
  listFiles: (projectPath: string, path = "", depth = 2) =>
    call<Array<{ path: string; kind: "dir" | "file"; size: number }>>("fs_list", { projectPath, path, depth }),
  readFile: (projectPath: string, path: string) => call<string>("fs_read", { projectPath, path }),
  searchFiles: (projectPath: string, query: string) => call<string[]>("fs_search", { projectPath, query }),
  writeFile: (projectPath: string, path: string, content: string, conversationId: string) =>
    call<{ id: string; path: string; kind: "created" | "modified"; before: string | null; after: string }>("fs_write", { projectPath, path, content, conversationId }),
  undoChange: (conversationId: string, changeId: string, force: boolean) => call<string>("change_undo", { conversationId, changeId, force }),
  runCommand: (projectPath: string, command: string) =>
    call<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean }>("run_command", { projectPath, command }),
  createProjectFolder: (parent: string, name: string) => call<string>("create_project_folder", { parent, name }),
  skillList: (projectPath?: string | null) => call<InstalledSkill[]>("skill_list", { projectPath: projectPath ?? null }),
  skillRead: (key: string, projectPath?: string | null, file?: string) =>
    call<{ dir: string; content: string; files: string[] }>("skill_read", { key, projectPath: projectPath ?? null, file: file ?? null }),
  skillRemove: (key: string, projectPath?: string | null) => call<void>("skill_remove", { key, projectPath: projectPath ?? null }),
  skillSearch: (query: string, sources: string[]) => call<SkillSearchResult>("skill_search", { query, sources }),
  skillInspect: (source: string) => call<RemoteSkill[]>("skill_inspect", { source }),
  skillPreview: (skill: Pick<RemoteSkill, "repo" | "gitRef" | "dir">) => call<SkillPreview>("skill_preview", { repo: skill.repo, gitRef: skill.gitRef, dir: skill.dir }),
  skillInstall: (skill: Pick<RemoteSkill, "repo" | "gitRef" | "dir">, scope: "global" | "project", projectPath: string | null, overwrite: boolean) =>
    call<InstalledSkill>("skill_install", { repo: skill.repo, gitRef: skill.gitRef, dir: skill.dir, scope, projectPath, overwrite }),
  skillImportLocal: (path: string, scope: "global" | "project", projectPath: string | null, overwrite: boolean) =>
    call<InstalledSkill[]>("skill_import_local", { path, scope, projectPath, overwrite }),
  saveSecret: (id: string, value: string) =>
    call<{ providerId: string; hasKey: boolean }>("save_provider", { provider: { id, name: id, kind: "custom", model: "", endpoint: "", hasKey: false, latency: "", tone: "cyan" }, apiKey: value }),
  secretStatus: (ids: string[]) => call<Array<{ providerId: string; hasKey: boolean }>>("get_provider_key_statuses", { providerIds: ids }),
  gitStatus: (projectPath: string) => call<GitStatus>("git_status", { projectPath }),
  gitInit: (projectPath: string) => call<string>("git_init", { projectPath }),
  gitCommit: (projectPath: string, message: string, allowSensitive = false, author?: { name: string; email: string }) =>
    call<string>("git_commit", { projectPath, message, allowSensitive, authorName: author?.name ?? null, authorEmail: author?.email ?? null }),
  gitBranch: (projectPath: string, name: string) => call<string>("git_branch", { projectPath, name }),
  gitPush: (projectPath: string, allowProtected: boolean) => call<string>("git_push", { projectPath, allowProtected }),
  gitClone: (url: string, parent: string) => call<string>("git_clone", { url, parent }),
  githubUser: () => call<{ login: string; name: string; email: string }>("github_user"),
  githubCreateRepo: (projectPath: string, name: string, priv: boolean) => call<string>("github_create_repo", { projectPath, name, private: priv, description: null }),
  githubCreatePr: (projectPath: string, title: string, body: string) => call<string>("github_create_pr", { projectPath, title, body, base: null }),
  vercelAccount: () => call<{ username: string; email: string; teams: Array<{ id: string; name: string; slug: string }> }>("vercel_account"),
  vercelProjects: (teamId?: string | null) => call<Array<{ id: string; name: string; framework?: string | null }>>("vercel_projects", { teamId: teamId ?? null }),
  vercelDeploy: (projectPath: string, name: string, projectId: string | undefined, teamId: string | null | undefined, production: boolean) =>
    call<{ id: string; url?: string; readyState?: string; projectId?: string; files: number }>("vercel_deploy", { projectPath, name, projectId: projectId ?? null, teamId: teamId ?? null, production }),
  vercelDeployment: (id: string, teamId?: string | null) => call<{ id: string; url?: string; readyState?: string; errorMessage?: string | null; target?: string | null; projectId?: string }>("vercel_deployment", { id, teamId: teamId ?? null }),
  vercelDeployments: (projectId: string, teamId?: string | null) => call<VercelDeployment[]>("vercel_deployments", { projectId, teamId: teamId ?? null }),
  vercelLogs: (id: string, teamId?: string | null) => call<string>("vercel_logs", { id, teamId: teamId ?? null }),
  vercelRollback: (projectId: string, deploymentId: string, teamId?: string | null) => call<void>("vercel_rollback", { projectId, deploymentId, teamId: teamId ?? null }),
  vercelSetEnv: (projectId: string, teamId: string | null | undefined, key: string, value: string, sensitive: boolean) =>
    call<void>("vercel_set_env", { projectId, teamId: teamId ?? null, key, value, sensitive }),
  supabaseProjects: () => call<Array<{ ref: string; name: string; region?: string; status?: string }>>("supabase_projects"),
  supabaseQuery: (projectRef: string, sql: string, readOnly: boolean) => call<unknown>("supabase_query", { projectRef, sql, readOnly }),
  supabaseKeys: (projectRef: string) => call<{ url: string; publicKey?: string | null }>("supabase_keys", { projectRef }),
  supabaseTypes: (projectRef: string) => call<string>("supabase_types", { projectRef }),
  mcpStart: (server: McpServer, restart = false) =>
    call<McpTool[]>("mcp_start", { id: server.id, command: server.command, args: server.args, env: server.env, secretKeys: server.secretKeys, restart }),
  mcpCall: (id: string, tool: string, args: unknown) => call<{ text: string; isError: boolean }>("mcp_call", { id, tool, arguments: args }),
  mcpStop: (id: string) => call<void>("mcp_stop", { id }),
  mcpRunning: () => call<string[]>("mcp_running"),
  readUserJson: (path: string) => call<string>("read_user_json", { path }),
  openInSystem: (projectPath: string, mode: "finder" | "terminal" | "default", path?: string) => call<void>("open_in_system", { projectPath, path, mode }),
};
