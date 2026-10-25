// Trwała kolejka snapshotów. Błąd odczytu nigdy nie oznacza pustej historii.
import { api, inDesktopApp } from './api';
import { defaultProviders, emptySnapshot, type Conversation, type ConversationItem, type Project, type Provider, type Snapshot } from './types';
const LOCAL_KEY = 'agentos-snapshot-v4';
export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const nowIso = () => new Date().toISOString();
type Legacy = Record<string, any>;
function mergeProviders(saved: Partial<Provider>[]): Provider[] {
  const result = defaultProviders.map(base => {
    const match = saved.find(p => p.id === base.id);
    if (!match) return base;
    return { ...base, ...match, id: base.id, kind: base.kind, hasKey: Boolean(match.hasKey) } as Provider;
  });
  for (const item of saved) if (item.id && !result.some(p => p.id === item.id)) result.push({ id: item.id, name: item.name ?? 'Dostawca', kind: item.kind ?? 'custom', model: item.model ?? '', endpoint: item.endpoint ?? '', hasKey: Boolean(item.hasKey), models: item.models, catalog: item.catalog, catalogAt: item.catalogAt });
  return result;
}
function migrateLegacy(old: Legacy): Snapshot {
  const knowledge: Record<string, Legacy> = old.knowledge ?? {};
  const projects: Project[] = (Array.isArray(old.projects) ? old.projects : []).filter((p: Legacy) => p?.id && p.path && !['report', 'research', 'automation', 'product'].includes(p.id)).map((p: Legacy) => {
    const k = knowledge[p.id] ?? {};
    return { id: p.id, name: p.name ?? 'Projekt', path: p.path, createdAt: nowIso(), instructions: typeof k.instructions === 'string' ? k.instructions : '', memory: (Array.isArray(k.memory) ? k.memory : []).map((m: Legacy) => ({ id: m.id ?? uid('mem'), text: m.content ?? '', createdAt: m.updatedAt ?? nowIso(), source: m.source ?? 'migracja' })), accessMode: 'ask', contextFiles: p.contextFiles ?? [] };
  });
  const conversations: Conversation[] = (Array.isArray(old.runs) ? old.runs : []).filter((r: Legacy) => r?.id && !['run-report', 'run-market', 'run-invoices'].includes(r.id)).map((r: Legacy) => {
    const messages: Legacy[] = Array.isArray(r.messages) ? r.messages : [{ role: 'user', content: r.title }, ...(r.response ? [{ role: 'assistant', content: r.response }] : [])];
    return { id: r.id, projectId: projects.some(p => p.id === r.projectId) ? r.projectId : null, title: String(r.title ?? 'Rozmowa').slice(0, 120), status: r.status === 'failed' ? 'failed' : 'done', createdAt: nowIso(), updatedAt: nowIso(), providerId: r.providerId ?? 'anthropic', model: r.model ?? '', items: messages.map(m => ({ id: uid('item'), kind: m.role === 'user' ? 'user' : 'assistant', text: String(m.content ?? ''), at: nowIso() }) as ConversationItem), api: messages.map(m => m.role === 'user' ? { role: 'user', text: String(m.content ?? '') } : { role: 'assistant', text: String(m.content ?? ''), toolCalls: [] }), changes: [], usage: { input: 0, output: 0 } };
  });
  return { ...emptySnapshot, projects, conversations, providers: mergeProviders(Array.isArray(old.providers) ? old.providers : []) };
}
export function normalize(raw: unknown): { snapshot: Snapshot; migrated: boolean } {
  if (raw === null || raw === undefined) return { snapshot: structuredClone(emptySnapshot), migrated: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Nieprawidłowy format historii. Nie nadpisano danych.');
  const v = raw as Legacy;
  if (v.version === 4) {
    if (![v.providers, v.projects, v.conversations].every(Array.isArray)) throw new Error('Uszkodzona struktura historii.');
    for (const c of v.conversations) if (!c || typeof c.id !== 'string' || !Array.isArray(c.items) || !Array.isArray(c.api) || !Array.isArray(c.changes) || !c.usage) throw new Error('Uszkodzona rozmowa. Użyj odzyskiwania.');
    for (const p of v.projects) if (!p || typeof p.path !== 'string' || !Array.isArray(p.memory)) throw new Error('Uszkodzona konfiguracja projektu.');
    return { snapshot: { ...emptySnapshot, ...v, providers: mergeProviders(v.providers) } as Snapshot, migrated: false };
  }
  if (v.version && v.version > 4) throw new Error('Historia pochodzi z nowszej wersji AgentOS. Nie nadpisano danych.');
  if (!Array.isArray(v.runs) && !Array.isArray(v.snapshot?.runs)) throw new Error('Nieznany format historii.');
  return { snapshot: migrateLegacy(v.snapshot ?? v), migrated: true };
}
export function markInterrupted(snapshot: Snapshot): Snapshot {
  return { ...snapshot, conversations: snapshot.conversations.map(c => {
    if (c.status !== 'running' && c.status !== 'waiting') return c;
    return { ...c, status: 'stopped', items: [...c.items.map(item => item.kind === 'approval' && item.status === 'pending' ? { ...item, status: 'rejected' as const } : item.kind === 'action' && item.status === 'running' ? { ...item, status: 'failed' as const } : item.kind === 'plan' && item.decision === 'pending' ? { ...item, decision: 'changed' as const } : item), { id: uid('item'), kind: 'notice', text: 'Praca została przerwana zamknięciem aplikacji. Napisz „kontynuuj”, aby wznowić.', at: nowIso() }] };
  }) };
}
export type SaveState = { status: 'saved' | 'saving' | 'error'; error?: string };
let state: SaveState = { status: 'saved' };
const listeners = new Set<(state: SaveState) => void>();
const publish = (s: SaveState) => { state = s; listeners.forEach(fn => fn(s)); };
export function onSaveState(fn: (state: SaveState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; }
let allowed = false;
let pending: Snapshot | undefined;
let draining: Promise<void> | undefined;
export async function loadSnapshot(): Promise<Snapshot> {
  allowed = false;
  const raw = inDesktopApp ? await api.getSnapshot() : JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? 'null');
  const { snapshot, migrated } = normalize(raw);
  if (migrated && raw && inDesktopApp) await api.backupSnapshot('v3-before-redesign');
  allowed = true;
  return markInterrupted(snapshot);
}
async function drain(): Promise<void> {
  while (pending) {
    const next = pending; pending = undefined; publish({ status: 'saving' });
    try {
      if (inDesktopApp) await api.saveSnapshot(next);
      else window.localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
    } catch (e) {
      pending ??= next;
      publish({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }
  publish({ status: 'saved' });
}
export function flushSnapshot(): Promise<void> {
  if (!allowed) return Promise.reject(new Error('Historia nie została poprawnie wczytana — zapis zablokowany.'));
  if (!draining) draining = drain().finally(() => { draining = undefined; });
  return draining;
}
export function saveSnapshotSoon(snapshot: Snapshot) {
  if (!allowed) { publish({ status: 'error', error: 'Zapis zablokowany po błędzie odczytu.' }); return; }
  pending = structuredClone(snapshot);
  void flushSnapshot().catch(() => undefined);
}
export function hasUnsavedChanges() { return Boolean(pending || draining || state.status === 'error'); }
if (typeof window !== 'undefined') window.addEventListener('beforeunload', e => { if (hasUnsavedChanges()) { e.preventDefault(); e.returnValue = ''; } });
