import { useEffect, useState } from 'react';
import { api, call, inDesktopApp } from './api';
import { flushSnapshot, onSaveState, type SaveState } from './store';

export function SaveIndicator() {
  const [state, setState] = useState<SaveState>({ status: 'saved' });
  useEffect(() => onSaveState(setState), []);
  return <div role={state.status === 'error' ? 'alert' : 'status'} style={{ position: 'fixed', bottom: 8, left: 12, zIndex: 100, maxWidth: 500, fontSize: 11, background: 'var(--bg, #181818)', color: state.status === 'error' ? '#ff9c91' : 'inherit', padding: '4px 8px', borderRadius: 6 }}>
    {state.status === 'saving' ? 'Zapisywanie…' : state.status === 'saved' ? 'Historia zapisana' : <>Nie zapisano: {state.error} <button onClick={() => void flushSnapshot().catch(() => undefined)}>Ponów zapis</button></>}
  </div>;
}

/** Rejestruje awarię startowego odczytu zamiast pozostawiać wieczny spinner. */
export function RecoveryBoundary() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      setError(event.reason instanceof Error ? event.reason.message : String(event.reason));
    };
    window.addEventListener('unhandledrejection', handler);
    return () => window.removeEventListener('unhandledrejection', handler);
  }, []);
  if (!error) return null;
  return <div className="overlay"><div className="modal" role="alertdialog" aria-modal="true" aria-label="Błąd historii">
    <h2>Nie można wczytać danych</h2><p>{error}</p><p>Nie zastąpiono historii pustymi danymi. Możesz ponowić start lub przywrócić ostatnią poprawną kopię.</p>
    <div className="row"><button className="btn" onClick={() => location.reload()}>Ponów start</button>
      {inDesktopApp && <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await call('recover_snapshot'); location.reload(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>Odzyskaj kopię</button>}
    </div>
  </div></div>;
}

export function BackendControls() {
  return <button className="btn btn-ghost btn-xs" style={{ position: 'fixed', right: 12, bottom: 8, zIndex: 90 }} onClick={() => void call('cancel_operations').catch(() => undefined)} title="Awaryjnie anuluje wspierane żądania modelu i polecenia we wszystkich rozmowach. Nie cofa zmian usług zewnętrznych.">Awaryjny Stop</button>;
}
