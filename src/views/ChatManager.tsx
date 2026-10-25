import { useState } from 'react';
import { Trash2, RotateCcw } from 'lucide-react';
import { useApp } from '../context';
import { restoreChat, trashChat, type SnapshotWithTrash } from '../chatTrash';
import { flushSnapshot } from '../store';

export function ChatManager() {
  const { snapshot, mutate, runner, notify, confirmDialog, go } = useApp();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const trash = (snapshot as SnapshotWithTrash).trash ?? [];
  const remove = async (id: string) => {
    if (runner.isActive(id)) { notify('Najpierw zatrzymaj tę rozmowę.', 'warn'); return; }
    if (!await confirmDialog('Przenieść rozmowę do kosza? Pliki projektu i wykonane operacje pozostaną bez zmian. Rozmowę można przywrócić poniżej.', 'Usuń czat')) return;
    setBusy(true);
    try {
      // Ponowna kontrola po zamknięciu okna potwierdzenia.
      mutate(s => trashChat(s, id, runner.isActive(id)));
      await flushSnapshot();
      notify('Rozmowa przeniesiona do kosza.');
    } catch (e) { notify(String(e), 'bad'); } finally { setBusy(false); }
  };
  const restore = async (id: string) => {
    setBusy(true);
    try { mutate(s => restoreChat(s, id)); await flushSnapshot(); notify('Przywrócono rozmowę.'); }
    catch (e) { notify(String(e), 'bad'); } finally { setBusy(false); }
  };
  return <section className="panel" aria-labelledby="chat-manager-title">
    <h3 id="chat-manager-title"><Trash2 size={15} /> Rozmowy i kosz</h3>
    <p className="muted small">Usunięcie czatu nie cofa zmian w projekcie. Kosz i kopie bezpieczeństwa przechowują treść rozmów; to nie jest trwałe wymazanie danych.</p>
    <label className="field">Szukaj starych czatów<input className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Tytuł rozmowy…" /></label>
    <div className="list" style={{ maxHeight: 300, overflowY: 'auto' }}>
      {snapshot.conversations.filter(c => c.title.toLowerCase().includes(query.toLowerCase())).map(c => <div className="list-row" key={c.id}>
        <button className="link grow ellipsis" onClick={() => go({ screen: 'conversation', conversationId: c.id })}>{c.title}</button>
        <button className="btn btn-ghost btn-xs" disabled={busy || runner.isActive(c.id)} aria-label={`Usuń czat: ${c.title}`} onClick={() => void remove(c.id)}><Trash2 size={13} /> Usuń</button>
      </div>)}
      {!snapshot.conversations.length && <p className="muted small">Brak rozmów.</p>}
    </div>
    <h4>Kosz ({trash.length})</h4>
    {trash.map(t => <div className="row" key={t.conversation.id}>
      <span className="grow ellipsis">{t.conversation.title}</span>
      <button className="btn btn-ghost btn-xs" disabled={busy} aria-label={`Przywróć czat: ${t.conversation.title}`} onClick={() => void restore(t.conversation.id)}><RotateCcw size={13} /> Przywróć</button>
    </div>)}
    {!trash.length && <p className="muted small">Kosz jest pusty.</p>}
  </section>;
}
