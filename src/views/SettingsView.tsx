import { Monitor, Moon, ShieldCheck, Sun } from "lucide-react";
import { useApp } from "../context";
import { accessModeLabel, type AccessMode, type Theme } from "../types";

export function SettingsView() {
  const { snapshot, mutate } = useApp();
  const themes: Array<[Theme, string, typeof Sun]> = [["system", "Jak system", Monitor], ["light", "Jasny", Sun], ["dark", "Ciemny", Moon]];
  return (
    <div className="page">
      <header className="page-head"><div><h1>Ustawienia</h1></div></header>
      <div className="settings-stack">
        <section className="panel">
          <h3>Wygląd</h3>
          <div className="segmented segmented-row">
            {themes.map(([id, label, Icon]) => (
              <button key={id} className={snapshot.theme === id ? "on" : ""} onClick={() => mutate((s) => ({ ...s, theme: id }))}><Icon size={15} /><strong>{label}</strong></button>
            ))}
          </div>
        </section>
        <section className="panel">
          <h3>Domyślny dostęp dla nowych projektów</h3>
          <div className="segmented">
            {(Object.keys(accessModeLabel) as AccessMode[]).map((mode) => (
              <button key={mode} className={snapshot.defaultAccessMode === mode ? "on" : ""} onClick={() => mutate((s) => ({ ...s, defaultAccessMode: mode }))}>
                <strong>{accessModeLabel[mode].short}</strong><span>{accessModeLabel[mode].long}</span>
              </button>
            ))}
          </div>
          <p className="muted small">Każdy projekt może mieć własne ustawienie (Projekt → Ustawienia projektu).</p>
        </section>
        <section className="panel">
          <h3><ShieldCheck size={15} /> Granice bezpieczeństwa (zawsze włączone)</h3>
          <ul className="plain-list">
            <li>Agent pracuje tylko w folderach dodanych jako projekty i nie wychodzi poza nie.</li>
            <li>Agent nie usuwa plików i nie zapisuje do katalogu .git.</li>
            <li>Przed każdym zapisem powstaje kopia poprzedniej wersji — zmianę można cofnąć w rozmowie lub w zakładce Zmiany.</li>
            <li>Polecenia terminala wymagają Twojej zgody za każdym razem i mają limit 2 minut.</li>
            <li>Klucze API są przechowywane w pęku kluczy macOS, nie w plikach projektu.</li>
            <li>Modele lokalne mogą łączyć się wyłącznie z tym komputerem.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Skróty klawiaturowe</h3>
          <div className="shortcuts">
            <span>Nowe zadanie</span><kbd>⌘N</kbd>
            <span>Szukaj projektów i rozmów</span><kbd>⌘K</kbd>
            <span>Zatrzymaj agenta w otwartej rozmowie</span><kbd>⌘.</kbd>
            <span>Ustawienia</span><kbd>⌘,</kbd>
            <span>Wyślij wiadomość</span><kbd>Enter</kbd>
            <span>Nowa linia</span><kbd>Shift Enter</kbd>
          </div>
        </section>
      </div>
    </div>
  );
}
