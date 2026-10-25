import { Monitor, Moon, ShieldCheck, Sun } from 'lucide-react';
import { useApp } from '../context';
import { accessModeLabel, type AccessMode, type Theme } from '../types';
import { ChatManager } from './ChatManager';

export function SettingsView() {
  const { snapshot, mutate } = useApp();
  const themes: Array<[Theme, string, typeof Sun]> = [['system', 'Jak system', Monitor], ['light', 'Jasny', Sun], ['dark', 'Ciemny', Moon]];
  return <div className="page">
    <header className="page-head"><h1>Ustawienia</h1></header>
    <div className="settings-stack">
      <ChatManager />
      <section className="panel"><h3>Wygląd</h3><div className="segmented segmented-row">
        {themes.map(([id, label, Icon]) => <button key={id} aria-pressed={snapshot.theme === id} className={snapshot.theme === id ? 'on' : ''} onClick={() => mutate(s => ({ ...s, theme: id }))}><Icon size={15} /><strong>{label}</strong></button>)}
      </div></section>
      <section className="panel"><h3>Domyślny dostęp nowych projektów</h3><div className="segmented">
        {(Object.keys(accessModeLabel) as AccessMode[]).map(mode => <button key={mode} className={snapshot.defaultAccessMode === mode ? 'on' : ''} aria-pressed={snapshot.defaultAccessMode === mode} onClick={() => mutate(s => ({ ...s, defaultAccessMode: mode }))}><strong>{accessModeLabel[mode].short}</strong><span>{accessModeLabel[mode].long}</span></button>)}
      </div><p className="muted small">Uprawnienia kontroluje również backend. Natywne okno może wymagać dodatkowego potwierdzenia.</p></section>
      <section className="panel"><h3>Zgoda na wszystko</h3><div className="segmented segmented-row">
        <button className={!snapshot.approveAll ? 'on' : ''} onClick={() => mutate(s => ({ ...s, approveAll: false }))}><strong>Wyłączona</strong><span>Operacje podlegają zatwierdzaniu.</span></button>
        <button className={snapshot.approveAll ? 'on' : ''} onClick={() => mutate(s => ({ ...s, approveAll: true }))}><strong>Włączona</strong><span>Automatyczne zatwierdzanie operacji poza trybem odczytu. Włączenie wymaga natywnej zgody.</span></button>
      </div><p className="muted small">Terminal i MCP działają z Twoimi uprawnieniami. Mogą zmieniać dane poza projektem. Cofanie dotyczy zapisów narzędziem plikowym, nie dowolnych poleceń lub zmian produkcyjnych. Stan obowiązuje po poprawnym zapisaniu ustawień.</p></section>
      <section className="panel"><h3><ShieldCheck size={15} /> Granice bezpieczeństwa</h3><ul className="plain-list">
        <li>Narzędzia plikowe sprawdzają ścieżki projektu i blokują zapis do .git. Terminal nie jest sandboxem.</li>
        <li>Zapis pliku wymaga zgodnej wersji bazowej i tworzy kopię poprzedniej treści.</li>
        <li>Polecenia terminala mają limit do 2 minut. Stop jest awaryjnym sygnałem dla wspieranych operacji backendu.</li>
        <li>Anulowanie lokalnego oczekiwania nie cofa operacji już przyjętej przez usługę zewnętrzną.</li>
        <li>Klucze API pozostają w Keychain. Rozmowy i kopie historii są przechowywane lokalnie bez dodatkowego szyfrowania aplikacyjnego.</li>
        <li>Modele lokalne wymagają dokładnego hosta localhost, 127.0.0.1 lub ::1.</li>
      </ul></section>
      <section className="panel"><h3>Skróty klawiaturowe</h3><div className="shortcuts">
        <span>Nowe zadanie</span><kbd>⌘N</kbd><span>Szukaj</span><kbd>⌘K</kbd><span>Zatrzymaj</span><kbd>⌘.</kbd><span>Ustawienia i kosz czatów</span><kbd>⌘,</kbd><span>Wyślij</span><kbd>Enter</kbd><span>Nowa linia</span><kbd>Shift Enter</kbd>
      </div></section>
    </div>
  </div>;
}
