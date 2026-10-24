// Jedyne miejsce, w którym interfejs rozmawia z backendem Tauri.
import { invoke } from "@tauri-apps/api/core";
import type { AgentMessage, InstalledSkill, Provider, RemoteSkill, SkillPreview, SkillSearchResult, ToolCall } from "./types";

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
  openInSystem: (projectPath: string, mode: "finder" | "terminal" | "default", path?: string) => call<void>("open_in_system", { projectPath, path, mode }),
};
