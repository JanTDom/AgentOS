import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, ChevronDown, Cloud, HardDrive, Search, Square } from "lucide-react";
import { formatTokens, modelName } from "./modelCatalog";
import { useApp } from "./context";
import { isLocal, statusLabel, type ConversationStatus, type DiffLine } from "./types";

export function StatusDot({ status }: { status: ConversationStatus }) {
  return <span className={`dot dot-${status}`} title={statusLabel[status]} aria-label={statusLabel[status]} />;
}

export function StatusPill({ status, stopping }: { status: ConversationStatus; stopping?: boolean }) {
  return <span className={`pill pill-${status}`}><StatusDot status={status} />{stopping ? "Zatrzymywanie…" : statusLabel[status]}</span>;
}

export function EmptyState({ icon, title, text, children }: { icon?: ReactNode; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <strong>{title}</strong>
      {text && <p>{text}</p>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}

/** Wybór modelu: dostawca + model, z informacją, czy dane opuszczają Maca. */
export function ModelPicker({ providerId, model, onChange, compact }: { providerId: string; model: string; onChange: (providerId: string, model: string) => void; compact?: boolean }) {
  const { snapshot, usableProviders, go } = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  const provider = snapshot.providers.find((p) => p.id === providerId);
  const local = provider ? isLocal(provider) : false;
  const current = model || provider?.model || "";
  const q = query.trim().toLowerCase();
  const groups = usableProviders.map((p) => {
    const base = p.models?.length ? p.models : [];
    const ids = p.model && !base.includes(p.model) ? [p.model, ...base] : base;
    const items = ids
      .map((id) => ({ id, name: modelName(p, id), ctx: formatTokens(p.catalog?.find((m) => m.id === id)?.context) }))
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    return { p, items };
  });
  const total = usableProviders.reduce((n, p) => n + (p.models?.length ?? 1), 0);
  return (
    <div className="picker" ref={ref}>
      <button className={`chip ${compact ? "chip-compact" : ""}`} onClick={() => setOpen((o) => !o)} title={local ? "Model lokalny — dane zostają na tym Macu" : "Model w chmurze — treść rozmowy i plików trafia do dostawcy"}>
        {local ? <HardDrive size={13} /> : <Cloud size={13} />}
        <span className="ellipsis">{provider ? `${provider.name} · ${current ? modelName(provider, current) : "wybierz model"}` : "Wybierz model"}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="menu menu-models">
          {total > 8 && (
            <div className="menu-search">
              <Search size={13} className="muted" />
              <input autoFocus className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Szukaj modelu…" />
            </div>
          )}
          {usableProviders.length === 0 && <div className="menu-note">Brak gotowych modeli. <button className="link" onClick={() => go({ screen: "models" })}>Podłącz model</button></div>}
          {groups.filter((g) => g.items.length > 0).map(({ p, items }) => (
            <div key={p.id} className="menu-group">
              <div className="menu-head">{isLocal(p) ? <HardDrive size={12} /> : <Cloud size={12} />} {p.name}<small>{isLocal(p) ? "na tym Macu" : "w chmurze"}</small></div>
              {items.map((m) => (
                <button key={m.id} className={`menu-item model-item ${p.id === providerId && m.id === current ? "on" : ""}`} title={m.id} onClick={() => { onChange(p.id, m.id); setOpen(false); }}>
                  <span className="ellipsis">{m.name}</span>
                  {m.ctx && <small className="muted">{m.ctx}</small>}
                </button>
              ))}
            </div>
          ))}
          {q && groups.every((g) => g.items.length === 0) && <div className="menu-note">Brak modelu pasującego do „{query}”.</div>}
          <button className="menu-item muted" onClick={() => go({ screen: "models" })}>Zarządzaj modelami…</button>
        </div>
      )}
    </div>
  );
}

export function Composer({ id, value, onChange, onSend, onStop, placeholder, busy, disabled, hint, children, autoFocus }: {
  id?: string; value: string; onChange: (v: string) => void; onSend: () => void; onStop?: () => void;
  placeholder: string; busy?: boolean; disabled?: boolean; hint?: string; children?: ReactNode; autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [value]);
  return (
    <div className={`composer ${disabled ? "is-disabled" : ""}`}>
      <textarea
        id={id}
        ref={ref}
        autoFocus={autoFocus}
        value={value}
        rows={2}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (value.trim() && !disabled) onSend();
          }
        }}
      />
      <div className="composer-bar">
        <div className="composer-tools">{children}</div>
        <span className="composer-hint">{hint ?? "Enter — wyślij · Shift+Enter — nowa linia"}</span>
        {busy && onStop ? (
          <button className="btn btn-stop" onClick={onStop} title="Zatrzymaj (⌘.)"><Square size={12} fill="currentColor" /> Zatrzymaj</button>
        ) : (
          <button className="send" onClick={onSend} disabled={!value.trim() || disabled} aria-label="Wyślij"><ArrowUp size={17} /></button>
        )}
      </div>
    </div>
  );
}

export function DiffView({ lines, max = 400 }: { lines: DiffLine[]; max?: number }) {
  return (
    <pre className="diff">
      {lines.slice(0, max).map((line, i) => (
        <div key={i} className={`diff-${line.kind}`}>
          <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "gap" ? "⋯" : " "}</span>
          {line.text || " "}
        </div>
      ))}
    </pre>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
