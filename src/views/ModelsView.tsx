import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Cloud, HardDrive, KeyRound, Loader2, Plus, RefreshCw, Star } from "lucide-react";
import { applyCatalog, categoryLabel, formatDate, modelFacts, modelName } from "../modelCatalog";
import { api } from "../api";
import { useApp, isUsable } from "../context";
import { uid } from "../store";
import { isLocal, type ModelCategory, type Provider } from "../types";

const help: Record<string, string> = {
  ollama: "Darmowy program do uruchamiania modeli na Macu (ollama.com). Po instalacji pobierz model, np. poleceniem „ollama pull” w Terminalu.",
  lmstudio: "Aplikacja z katalogiem modeli lokalnych (lmstudio.ai). Włącz w niej serwer lokalny (Developer → Start Server).",
  anthropic: "Modele Claude. Klucz utworzysz w console.anthropic.com.",
  openai: "Modele GPT. Klucz utworzysz w platform.openai.com.",
  google: "Modele Gemini. Klucz utworzysz w aistudio.google.com.",
  openrouter: "Jeden klucz do wielu dostawców (openrouter.ai).",
};

export function ModelsView() {
  const { snapshot, refreshLocalModels } = useApp();
  const [checking, setChecking] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const locals = snapshot.providers.filter(isLocal);
  const clouds = snapshot.providers.filter((p) => !isLocal(p));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Modele</h1>
          <p className="muted">Wystarczy jeden model. Lokalne działają bez internetu i nie wysyłają danych poza Maca. Chmurowe są zwykle mocniejsze, ale treść rozmowy i czytanych plików trafia do dostawcy.</p>
        </div>
      </header>
      <section>
        <div className="section-head">
          <h2><HardDrive size={15} /> Na tym Macu</h2>
          <button className="btn btn-ghost" disabled={checking} onClick={async () => { setChecking(true); await refreshLocalModels(); setChecking(false); }}>
            {checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Sprawdź ponownie
          </button>
        </div>
        <div className="provider-list">{locals.map((p) => <ProviderCard key={p.id} provider={p} />)}</div>
      </section>
      <section>
        <div className="section-head"><h2><Cloud size={15} /> W chmurze</h2></div>
        <div className="provider-list">{clouds.map((p) => <ProviderCard key={p.id} provider={p} />)}</div>
      </section>
      <section>
        <button className="btn btn-ghost" onClick={() => setShowCustom((s) => !s)}><Plus size={14} /> Dodaj inny serwer zgodny z API OpenAI <ChevronDown size={13} /></button>
        {showCustom && <CustomProvider onDone={() => setShowCustom(false)} />}
      </section>
    </div>
  );
}

function ProviderCard({ provider }: { provider: Provider }) {
  const { snapshot, mutate, notify } = useApp();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState("");
  const local = isLocal(provider);
  const ready = isUsable(provider);
  const isDefault = snapshot.defaultProviderId === provider.id;
  const patch = (p: Partial<Provider>) => mutate((s) => ({ ...s, providers: s.providers.map((x) => (x.id === provider.id ? { ...x, ...p } : x)) }));

  const loadModels = async () => {
    setBusy(true);
    try {
      const catalog = await api.listModels(provider);
      const next = applyCatalog(provider, catalog);
      patch(next);
      notify(catalog.length ? `Pobrano listę: ${next.models?.length ?? 0} modeli do rozmów (${catalog.length} wszystkich).` : "Dostawca nie zwrócił żadnych modeli.", catalog.length ? "good" : "warn");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patch({ status: local ? "offline" : "error", statusText: message });
      notify(message, "bad");
    } finally { setBusy(false); }
  };

  const saveKey = async () => {
    setBusy(true);
    try {
      const status = await api.saveProvider(provider, key.trim());
      patch({ hasKey: status.hasKey });
      setKey("");
      notify("Klucz zapisany w pęku kluczy macOS.");
      if (status.hasKey) void loadModels();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "bad");
    } finally { setBusy(false); }
  };

  const status = local
    ? provider.status === "ok" ? { tone: "ok", text: `Działa · ${provider.statusText ?? ""}` } : provider.status === "offline" ? { tone: "off", text: "Nie uruchomiono" } : { tone: "off", text: "Nie sprawdzono" }
    : !provider.hasKey ? { tone: "off", text: "Brak klucza" }
    : provider.status === "error" ? { tone: "bad", text: "Błąd połączenia" }
    : provider.catalog?.length ? { tone: "ok", text: `Połączono · ${provider.statusText ?? ""}` }
    : { tone: "ok", text: "Klucz zapisany" };

  return (
    <article className={`provider ${ready ? "ready" : ""}`}>
      <div className="provider-top">
        <div className="provider-name">
          <strong>{provider.name}</strong>
          <span className={`badge ${local ? "badge-local" : "badge-cloud"}`}>{local ? "dane zostają na Macu" : "dane wysyłane do dostawcy"}</span>
        </div>
        <span className={`state state-${status.tone}`}>{status.tone === "ok" ? <Check size={12} /> : status.tone === "bad" ? <AlertTriangle size={12} /> : null}{status.text}</span>
      </div>
      {help[provider.kind] && <p className="muted small">{help[provider.kind]}</p>}

      {!local && (
        <div className="row">
          <KeyRound size={14} className="muted" />
          <input className="input grow" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={provider.hasKey ? "Wklej nowy klucz, aby go zmienić" : "Wklej klucz API"} />
          <button className="btn" disabled={!key.trim() || busy} onClick={() => void saveKey()}>Zapisz klucz</button>
        </div>
      )}

      {(local ? provider.status === "ok" : provider.hasKey) && (
        <div className="row">
          <span className="muted small">Model:</span>
          {provider.models && provider.models.length > 0 ? (
            <select className="input grow" value={provider.model} onChange={(e) => patch({ model: e.target.value })}>
              {!provider.models.includes(provider.model) && provider.model && <option value={provider.model}>{modelName(provider, provider.model)}</option>}
              {provider.models.map((m) => <option key={m} value={m}>{modelName(provider, m)}</option>)}
            </select>
          ) : (
            <input className="input grow" value={manual || provider.model} onChange={(e) => setManual(e.target.value)} onBlur={() => manual && patch({ model: manual.trim() })} placeholder="nazwa modelu" />
          )}
          <button className="btn btn-ghost" disabled={busy} onClick={() => void loadModels()}>{busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Lista modeli</button>
        </div>
      )}
      {local && provider.status === "ok" && provider.models?.length === 0 && <p className="small warn-text">Program działa, ale nie ma pobranych modeli.</p>}
      {!local && provider.status === "error" && provider.statusText && <p className="small error-text">{provider.statusText}</p>}
      {provider.catalog && provider.catalog.length > 0 && <Catalog provider={provider} onPick={(id) => patch({ model: id })} />}

      <div className="provider-foot">
        {ready && (isDefault
          ? <span className="small ok-text"><Star size={12} /> Domyślny dla nowych zadań</span>
          : <button className="btn btn-ghost btn-xs" onClick={() => mutate((s) => ({ ...s, defaultProviderId: provider.id }))}><Star size={12} /> Ustaw jako domyślny</button>)}
        {provider.id.startsWith("custom-") && <button className="btn btn-ghost btn-xs" onClick={() => mutate((s) => ({ ...s, providers: s.providers.filter((p) => p.id !== provider.id) }))}>Usuń</button>}
      </div>
    </article>
  );
}

const CATS: ModelCategory[] = ["chat", "embedding", "image", "audio", "other"];

/** Pełna lista modeli dostawcy: wyszukiwanie, rodzaje, kontekst, ceny, ręczny identyfikator. */
function Catalog({ provider, onPick }: { provider: Provider; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<ModelCategory | "all">("chat");
  const [manual, setManual] = useState("");
  const catalog = provider.catalog ?? [];
  const counts = CATS.map((c) => [c, catalog.filter((m) => m.category === c).length] as const).filter(([, n]) => n > 0);
  const q = query.trim().toLowerCase();
  const rows = catalog.filter((m) => (cat === "all" || m.category === cat) && (!q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)));
  const checked = provider.catalogAt ? new Date(provider.catalogAt).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }) : null;
  return (
    <div className="catalog">
      <button className="btn btn-ghost btn-xs" onClick={() => setOpen((o) => !o)} style={{ justifySelf: "start" }}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Wszystkie modele ({catalog.length}){checked ? ` · sprawdzono ${checked}` : ""}
      </button>
      {open && (
        <>
          <div className="catalog-tools">
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Szukaj po nazwie lub identyfikatorze" />
            {counts.length > 1 && counts.map(([c, n]) => (
              <button key={c} className={`cat-chip ${cat === c ? "on" : ""}`} onClick={() => setCat(c)}>{categoryLabel[c]} {n}</button>
            ))}
            {counts.length > 1 && <button className={`cat-chip ${cat === "all" ? "on" : ""}`} onClick={() => setCat("all")}>Wszystkie</button>}
          </div>
          <div className="catalog-list">
            {rows.length === 0 && <p className="muted small" style={{ padding: 8 }}>Brak modeli pasujących do filtra.</p>}
            {rows.map((m) => {
              const facts = modelFacts(m);
              const date = formatDate(m.created);
              const pickable = m.category === "chat";
              return (
                <button key={m.id} className={`catalog-row ${m.id === provider.model ? "on" : ""}`} disabled={!pickable} title={pickable ? "Ustaw jako model tego dostawcy" : "Ten model nie służy do rozmowy"} onClick={() => pickable && onPick(m.id)}>
                  <strong className="ellipsis">{m.name}{m.id === provider.model ? " ✓" : ""}</strong>
                  <span className="cat">{categoryLabel[m.category]}{date ? ` · ${date}` : ""}</span>
                  {m.name !== m.id && <span className="id">{m.id}</span>}
                  {facts.length > 0 && <span className="facts">{facts.join(" · ")}</span>}
                </button>
              );
            })}
          </div>
          <p className="muted small">Nazwy, długość kontekstu i ceny pochodzą wyłącznie z odpowiedzi dostawcy. Puste pole oznacza, że dostawca tych danych nie podaje.</p>
          <div className="row">
            <input className="input grow" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Model spoza listy — wpisz identyfikator" />
            <button className="btn btn-ghost" disabled={!manual.trim()} onClick={() => { onPick(manual.trim()); setManual(""); }}>Użyj</button>
          </div>
        </>
      )}
    </div>
  );
}

function CustomProvider({ onDone }: { onDone: () => void }) {
  const { mutate, notify } = useApp();
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("http://localhost:8080/v1/chat/completions");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const isLocalEndpoint = /^http:\/\/(localhost|127\.0\.0\.1)/.test(endpoint);
  const save = async () => {
    const provider: Provider = { id: uid("custom"), name: name.trim(), kind: isLocalEndpoint ? "local" : "custom", model: model.trim(), endpoint: endpoint.trim(), hasKey: false, status: isLocalEndpoint ? "unknown" : undefined };
    try {
      if (!isLocalEndpoint && key.trim()) provider.hasKey = (await api.saveProvider(provider, key.trim())).hasKey;
      if (isLocalEndpoint) {
        try { Object.assign(provider, applyCatalog(provider, await api.listModels(provider))); }
        catch { provider.status = "offline"; }
      }
      mutate((s) => ({ ...s, providers: [...s.providers, provider] }));
      notify(`Dodano ${provider.name}.`);
      onDone();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "bad");
    }
  };
  return (
    <div className="panel">
      <div className="form-grid">
        <label className="field">Nazwa<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="np. vLLM w biurze" /></label>
        <label className="field">Adres (chat/completions)<input className="input" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} /></label>
        <label className="field">Model<input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="nazwa modelu" /></label>
        {!isLocalEndpoint && <label className="field">Klucz API<input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} /></label>}
      </div>
      <div className="modal-actions"><button className="btn btn-primary" disabled={!name.trim() || !endpoint.trim()} onClick={() => void save()}>Dodaj</button></div>
    </div>
  );
}
