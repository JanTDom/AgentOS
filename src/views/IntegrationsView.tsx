import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, Database, FileJson, GitBranch, KeyRound, Loader2, Plug, Plus, Power, Rocket, Trash2 } from "lucide-react";
import { api, inDesktopApp } from "../api";
import { useApp } from "../context";
import { EmptyState } from "../components";
import { uid } from "../store";
import type { McpServer, McpTool, Snapshot } from "../types";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
type AccountId = keyof Snapshot["accounts"];

const SERVICES: Array<{ id: AccountId; name: string; icon: typeof GitBranch; what: string; steps: string[] }> = [
  {
    id: "github", name: "GitHub", icon: GitBranch,
    what: "Wypychanie zmian, pull requesty, tworzenie i klonowanie repozytoriów. Ten sam token podnosi limity wyszukiwania umiejętności.",
    steps: ["GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.", "Dostęp do repozytoriów: wybrane albo wszystkie.", "Uprawnienia: Contents i Pull requests — Read and write; Administration — Read and write (tylko jeśli AgentOS ma zakładać repozytoria)."],
  },
  {
    id: "vercel", name: "Vercel", icon: Rocket,
    what: "Wdrożenia podglądowe i produkcyjne, status budowania, logi błędów, przywracanie poprzedniej wersji, zmienne środowiskowe.",
    steps: ["Vercel → Account Settings → Tokens → Create.", "Zakres: Twoje konto albo zespół, w którym są projekty.", "Ustaw datę wygaśnięcia zgodnie z Twoją polityką bezpieczeństwa."],
  },
  {
    id: "supabase", name: "Supabase", icon: Database,
    what: "Podgląd struktury bazy, zapytania (odczyt bez pytania, zmiany za zgodą), typy TypeScript, przekazanie adresu i klucza do Vercela.",
    steps: ["Supabase → Account → Access Tokens → Generate new token.", "Token daje dostęp do wszystkich Twoich projektów Supabase — przechowuj go tylko w AgentOS (pęk kluczy macOS)."],
  },
];

export function IntegrationsView() {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Integracje</h1>
          <p className="muted">Połącz usługi, z których korzystasz przy publikowaniu projektów. Tokeny trafiają do pęku kluczy macOS, nie do plików projektów. Wypchnięcia, wdrożenia i zmiany w bazie zawsze wymagają Twojej zgody — a operacje produkcyjne dodatkowego potwierdzenia.</p>
        </div>
      </header>
      <section className="integration-grid">{SERVICES.map((s) => <AccountCard key={s.id} service={s} />)}</section>
      <McpSection />
    </div>
  );
}

function AccountCard({ service }: { service: (typeof SERVICES)[number] }) {
  const { snapshot, mutate, notify } = useApp();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const account = snapshot.accounts[service.id];
  const Icon = service.icon;

  const verify = async () => {
    if (service.id === "github") return (await api.githubUser()).login;
    if (service.id === "vercel") return (await api.vercelAccount()).username;
    const projects = await api.supabaseProjects();
    return `${projects.length} projektów`;
  };
  const save = async () => {
    if (!inDesktopApp) { notify("Integracje działają w aplikacji AgentOS na Macu.", "warn"); return; }
    setBusy(true);
    try {
      if (token.trim()) await api.saveSecret(service.id, token.trim());
      const who = await verify();
      mutate((s) => ({ ...s, accounts: { ...s.accounts, [service.id]: who } }));
      setToken("");
      notify(`${service.name}: połączono (${who}).`);
    } catch (e) {
      notify(errText(e), "bad");
    } finally { setBusy(false); }
  };
  return (
    <article className={`integration-card ${account ? "connected" : ""}`}>
      <div className="integration-head">
        <strong><Icon size={16} /> {service.name}</strong>
        {account ? <span className="state state-ok"><Check size={12} /> {account}</span> : <span className="state state-off">nie połączono</span>}
      </div>
      <p className="muted small">{service.what}</p>
      <div className="row">
        <KeyRound size={14} className="muted" />
        <input className="input grow" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={account ? "Wklej nowy token, aby go zmienić" : "Wklej token"} onKeyDown={(e) => { if (e.key === "Enter" && token.trim()) void save(); }} />
        <button className="btn" disabled={busy || (!token.trim() && !account)} onClick={() => void save()}>{busy ? <Loader2 size={13} className="spin" /> : null}{token.trim() ? "Zapisz i sprawdź" : "Sprawdź"}</button>
      </div>
      <div className="row">
        <button className="link small" onClick={() => setShowHelp((h) => !h)}>{showHelp ? "Ukryj instrukcję" : "Jak zdobyć token?"}</button>
        {account && <button className="btn btn-ghost btn-xs" onClick={() => mutate((s) => ({ ...s, accounts: { ...s.accounts, [service.id]: undefined } }))}>Odłącz w AgentOS</button>}
      </div>
      {showHelp && <ol className="steps-hint">{service.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
    </article>
  );
}

function splitArgs(text: string): string[] {
  return (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^["']|["']$/g, ""));
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const looksSecret = (key: string) => /(key|token|secret|password|pat|auth)/i.test(key);

function McpSection() {
  const { snapshot, mutate, notify, confirmDialog } = useApp();
  const [adding, setAdding] = useState(false);
  const [tools, setTools] = useState<Record<string, McpTool[] | string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState<string[]>([]);
  useEffect(() => { if (inDesktopApp) api.mcpRunning().then(setRunning).catch(() => undefined); }, []);

  const update = (id: string, patch: Partial<McpServer>) => mutate((s) => ({ ...s, mcpServers: s.mcpServers.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const test = async (server: McpServer) => {
    setBusy(server.id);
    try {
      const list = await api.mcpStart(server, true);
      setTools((t) => ({ ...t, [server.id]: list }));
      setRunning((r) => [...new Set([...r, server.id])]);
      notify(`${server.name}: działa, ${list.length} narzędzi.`);
    } catch (e) {
      setTools((t) => ({ ...t, [server.id]: errText(e) }));
    } finally { setBusy(null); }
  };
  const stop = async (server: McpServer) => { await api.mcpStop(server.id).catch(() => undefined); setRunning((r) => r.filter((x) => x !== server.id)); };
  const remove = async (server: McpServer) => {
    if (!(await confirmDialog(`Usunąć serwer MCP „${server.name}”?`, "Usuń serwer"))) return;
    await stop(server);
    mutate((s) => ({ ...s, mcpServers: s.mcpServers.filter((m) => m.id !== server.id) }));
  };
  const importClaude = async () => {
    if (!inDesktopApp) return;
    const selected = await open({ multiple: false, directory: false, title: "Wybierz claude_desktop_config.json (Library/Application Support/Claude)", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!selected || Array.isArray(selected)) return;
    try {
      const config = JSON.parse(await api.readUserJson(selected)) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string }> };
      const entries = Object.entries(config.mcpServers ?? {});
      const added: string[] = [];
      const skipped: string[] = [];
      for (const [name, cfg] of entries) {
        if (!cfg.command) { skipped.push(name); continue; }
        const id = uid("mcp");
        const env: Record<string, string> = {};
        const secretKeys: string[] = [];
        for (const [k, v] of Object.entries(cfg.env ?? {})) {
          if (looksSecret(k)) { await api.saveSecret(`mcp-${id}-${k}`, v); secretKeys.push(k); } else env[k] = v;
        }
        const server: McpServer = { id, name, command: cfg.command, args: cfg.args ?? [], env, secretKeys, enabled: false, autoApprove: false };
        mutate((s) => ({ ...s, mcpServers: [...s.mcpServers, server] }));
        added.push(name);
      }
      notify(added.length ? `Zaimportowano: ${added.join(", ")} (wyłączone — włącz te, których chcesz używać).${skipped.length ? ` Pominięto serwery zdalne: ${skipped.join(", ")}.` : ""}` : "W pliku nie ma serwerów uruchamianych lokalnie.", added.length ? "good" : "warn");
    } catch (e) { notify(errText(e), "bad"); }
  };

  return (
    <section>
      <div className="section-head">
        <h2><Plug size={14} /> Serwery MCP</h2>
        <div className="row">
          <button className="btn btn-ghost" onClick={() => void importClaude()}><FileJson size={14} /> Importuj z Claude Desktop</button>
          <button className="btn" onClick={() => setAdding((a) => !a)}><Plus size={14} /> Dodaj serwer</button>
        </div>
      </div>
      <p className="muted small">Serwery MCP dają agentowi dodatkowe narzędzia (np. bazy danych, kalendarz, przeglądarka). Uruchamiane lokalnie (stdio), np. przez npx lub uvx. Każde użycie narzędzia wymaga Twojej zgody, chyba że oznaczysz serwer jako zaufany.</p>
      {adding && <McpForm onDone={() => setAdding(false)} />}
      {snapshot.mcpServers.length === 0 && !adding
        ? <EmptyState icon={<Plug size={18} />} title="Brak serwerów MCP" text="Dodaj serwer ręcznie albo zaimportuj konfigurację z Claude Desktop." />
        : (
          <div className="integration-grid">
            {snapshot.mcpServers.map((server) => {
              const t = tools[server.id];
              const isRunning = running.includes(server.id);
              return (
                <article key={server.id} className={`integration-card ${server.enabled ? "connected" : ""}`}>
                  <div className="integration-head">
                    <strong><Plug size={15} /> {server.name}</strong>
                    <button className={`switch ${server.enabled ? "on" : ""}`} role="switch" aria-checked={server.enabled} aria-label="Dostępny dla agenta" onClick={() => update(server.id, { enabled: !server.enabled })}><i /></button>
                  </div>
                  <code className="mono small ellipsis" title={[server.command, ...server.args].join(" ")}>{[server.command, ...server.args].join(" ")}</code>
                  {server.secretKeys.length > 0 && <span className="muted small">Sekrety w pęku kluczy: {server.secretKeys.join(", ")}</span>}
                  <label className="check"><input type="checkbox" checked={server.autoApprove} onChange={() => update(server.id, { autoApprove: !server.autoApprove })} /> Zaufany — używaj narzędzi bez pytania</label>
                  {typeof t === "string" && <div className="inline-warn bad">{t.slice(0, 600)}</div>}
                  {Array.isArray(t) && <div className="file-list-sm">{t.map((x) => <div key={x.name} title={x.description}>{x.name}</div>)}</div>}
                  <div className="row">
                    <button className="btn btn-xs" disabled={busy === server.id} onClick={() => void test(server)}>{busy === server.id ? <Loader2 size={12} className="spin" /> : <Power size={12} />} {isRunning ? "Uruchom ponownie" : "Uruchom i sprawdź"}</button>
                    {isRunning && <button className="btn btn-ghost btn-xs" onClick={() => void stop(server)}>Zatrzymaj</button>}
                    <button className="btn btn-ghost btn-xs btn-danger" onClick={() => void remove(server)}><Trash2 size={12} /> Usuń</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
    </section>
  );
}

function McpForm({ onDone }: { onDone: () => void }) {
  const { mutate, notify } = useApp();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("npx");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [secrets, setSecrets] = useState("");
  const save = async () => {
    const id = uid("mcp");
    const secretPairs = parseEnv(secrets);
    try {
      for (const [k, v] of Object.entries(secretPairs)) await api.saveSecret(`mcp-${id}-${k}`, v);
      mutate((s) => ({ ...s, mcpServers: [...s.mcpServers, { id, name: name.trim(), command: command.trim(), args: splitArgs(args), env: parseEnv(env), secretKeys: Object.keys(secretPairs), enabled: true, autoApprove: false }] }));
      notify(`Dodano serwer ${name.trim()}. Kliknij „Uruchom i sprawdź”.`);
      onDone();
    } catch (e) { notify(errText(e), "bad"); }
  };
  return (
    <div className="panel">
      <div className="form-grid">
        <label className="field">Nazwa<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="np. Pliki biurowe" /></label>
        <label className="field">Polecenie<input className="input" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx, uvx, node, python3 lub pełna ścieżka" /></label>
        <label className="field">Argumenty<input className="input" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y nazwa-pakietu-serwera --opcja" /></label>
      </div>
      <div className="form-grid">
        <label className="field">Zmienne (KLUCZ=wartość, jedna w linii)<textarea rows={3} value={env} onChange={(e) => setEnv(e.target.value)} /></label>
        <label className="field">Sekrety — trafią do pęku kluczy (KLUCZ=wartość)<textarea rows={3} value={secrets} onChange={(e) => setSecrets(e.target.value)} placeholder="API_TOKEN=..." /></label>
      </div>
      <div className="modal-actions"><button className="btn btn-ghost" onClick={onDone}>Anuluj</button><button className="btn btn-primary" disabled={!name.trim() || !command.trim()} onClick={() => void save()}>Dodaj serwer</button></div>
    </div>
  );
}
