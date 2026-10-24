import { createContext, useContext } from "react";
import type { AgentRunner } from "./agent";
import { isLocal, type Conversation, type Project, type Provider, type Route, type Snapshot } from "./types";

export type Tone = "good" | "warn" | "bad";

export type AppApi = {
  snapshot: Snapshot;
  route: Route;
  go: (route: Route) => void;
  mutate: (fn: (s: Snapshot) => Snapshot) => void;
  runner: AgentRunner;
  notify: (text: string, tone?: Tone) => void;
  usableProviders: Provider[];
  defaultProvider: Provider | undefined;
  startConversation: (options: { projectId: string | null; text: string; providerId?: string; model?: string }) => Conversation | null;
  addExistingProject: () => Promise<Project | null>;
  createNewProject: (name: string) => Promise<Project | null>;
  refreshLocalModels: () => Promise<void>;
  confirmDialog: (text: string, title?: string) => Promise<boolean>;
};

export const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const value = useContext(AppContext);
  if (!value) throw new Error("Brak kontekstu aplikacji");
  return value;
}

export const isUsable = (p: Provider) => (isLocal(p) ? p.status === "ok" : p.hasKey) && Boolean(p.model);

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "";
  const min = Math.round(diff / 60000);
  if (min < 1) return "teraz";
  if (min < 60) return `${min} min temu`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} godz. temu`;
  const d = Math.round(h / 24);
  if (d === 1) return "wczoraj";
  if (d < 7) return `${d} dni temu`;
  return new Date(iso).toLocaleDateString("pl-PL", { day: "numeric", month: "short" });
}
