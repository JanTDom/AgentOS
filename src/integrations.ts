// Wspólna logika integracji używana przez agenta i interfejs.
import { api } from "./api";

/** Czy SQL tylko czyta dane. Błędna klasyfikacja jako „odczyt” jest bezpieczna:
 *  takie zapytanie idzie do punktu API tylko do odczytu i Supabase je odrzuci. */
export function isReadOnlySql(sql: string): boolean {
  const cleaned = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().toLowerCase();
  if (!cleaned) return false;
  const statements = cleaned.split(";").map((s) => s.trim()).filter(Boolean);
  const writes = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|merge|copy|vacuum|reindex|cluster|refresh|call|do|lock|set|reset)\b/;
  return statements.every((s) => /^(select|with|show|explain|table|values)\b/.test(s) && !writes.test(s.replace(/'[^']*'/g, "''")));
}

export const SCHEMA_SQL = `select c.table_schema, c.table_name, string_agg(c.column_name || ' ' || c.data_type || case when c.is_nullable = 'NO' then ' not null' else '' end, ', ' order by c.ordinal_position) as columns
from information_schema.columns c
where c.table_schema = 'public'
group by c.table_schema, c.table_name
order by c.table_name;`;

export function formatRows(result: unknown, max = 50): string {
  if (!Array.isArray(result)) return JSON.stringify(result, null, 2).slice(0, 20000);
  if (result.length === 0) return "(brak wierszy)";
  const rows = result.slice(0, max) as Array<Record<string, unknown>>;
  const cols = Object.keys(rows[0] ?? {});
  const lines = [cols.join(" | "), ...rows.map((r) => cols.map((c) => String(r[c] ?? "∅").replace(/\s+/g, " ").slice(0, 120)).join(" | "))];
  if (result.length > max) lines.push(`… i ${result.length - max} kolejnych wierszy`);
  return lines.join("\n");
}

const TERMINAL = new Set(["READY", "ERROR", "CANCELED"]);

/** Czeka na koniec budowania wdrożenia Vercel. */
export async function waitForDeployment(id: string, teamId: string | null | undefined, onState: (state: string) => void, shouldStop: () => boolean, timeoutMs = 15 * 60 * 1000) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    if (shouldStop()) return { state: "STOPPED" as const, url: undefined as string | undefined, error: undefined as string | undefined };
    const d = await api.vercelDeployment(id, teamId);
    const state = d.readyState ?? "QUEUED";
    if (state !== last) { onState(state); last = state; }
    if (TERMINAL.has(state)) return { state, url: d.url, error: d.errorMessage ?? undefined };
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { state: "TIMEOUT", url: undefined, error: "Przekroczono czas oczekiwania na zbudowanie." };
}

export const deployStateLabel: Record<string, string> = {
  QUEUED: "w kolejce", INITIALIZING: "przygotowanie", BUILDING: "budowanie", READY: "gotowe", ERROR: "błąd", CANCELED: "anulowane", STOPPED: "przestano śledzić", TIMEOUT: "przekroczono czas",
};

export const mcpToolName = (serverName: string, tool: string) =>
  `mcp_${serverName.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20)}_${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
