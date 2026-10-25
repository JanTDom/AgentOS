import type { Conversation, Snapshot } from './types';
export type TrashedChat = { conversation: Conversation; deletedAt: string };
export type SnapshotWithTrash = Snapshot & { trash?: TrashedChat[] };

/** Kosz nie cofa zmian w plikach. Aktywne rozmowy pozostają na liście. */
export function trashChat(snapshot: Snapshot, id: string, active: boolean): SnapshotWithTrash {
  if (active) throw new Error('Najpierw zatrzymaj rozmowę.');
  const conversation = snapshot.conversations.find(c => c.id === id);
  if (!conversation) return snapshot;
  return {
    ...snapshot,
    conversations: snapshot.conversations.filter(c => c.id !== id),
    trash: [...((snapshot as SnapshotWithTrash).trash ?? []), { conversation, deletedAt: new Date().toISOString() }],
  };
}

export function restoreChat(snapshot: Snapshot, id: string): SnapshotWithTrash {
  const trash = (snapshot as SnapshotWithTrash).trash ?? [];
  const entry = trash.find(t => t.conversation.id === id);
  if (!entry || snapshot.conversations.some(c => c.id === id)) return snapshot;
  const conversation = entry.conversation;
  return {
    ...snapshot,
    conversations: [{ ...conversation, projectId: snapshot.projects.some(p => p.id === conversation.projectId) ? conversation.projectId : null }, ...snapshot.conversations],
    trash: trash.filter(t => t.conversation.id !== id),
  };
}
