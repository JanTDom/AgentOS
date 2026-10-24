import { undoChange } from "../agent";
import { useApp } from "../context";
import type { Change } from "../types";

/** Cofanie zmian agenta: pojedynczo albo wszystkich z rozmowy (od najnowszej). */
export function useUndo() {
  const { snapshot, mutate, notify, confirmDialog } = useApp();

  const markUndone = (ids: string[]) =>
    mutate((s) => ({
      ...s,
      conversations: s.conversations.map((c) => ({ ...c, changes: c.changes.map((ch) => (ids.includes(ch.id) ? { ...ch, undone: true } : ch)) })),
    }));

  const laterChange = (change: Change) =>
    snapshot.conversations
      .flatMap((c) => c.changes)
      .find((ch) => !ch.undone && ch.path === change.path && ch.at > change.at && ch.id !== change.id && snapshot.conversations.find((c) => c.id === ch.conversationId)?.projectId === snapshot.conversations.find((c) => c.id === change.conversationId)?.projectId);

  const undo = async (change: Change) => {
    const later = laterChange(change);
    if (later) {
      notify(`Plik ${change.path} ma późniejszą zmianę agenta. Najpierw cofnij ją.`, "warn");
      return false;
    }
    try {
      const message = await undoChange(change, (text) => confirmDialog(text, "Cofnąć zmianę?"));
      markUndone([change.id]);
      notify(message);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "bad");
      return false;
    }
  };

  const undoAll = async (changes: Change[]) => {
    const pending = changes.filter((c) => !c.undone).sort((a, b) => (a.at < b.at ? 1 : -1));
    if (!pending.length) return;
    if (!(await confirmDialog(`Cofnąć ${pending.length} zmian(y) agenta? Pliki wrócą do stanu sprzed tej rozmowy.`, "Cofnij wszystko"))) return;
    const done: string[] = [];
    for (const change of pending) {
      try {
        await undoChange(change, (text) => confirmDialog(text, "Cofnąć zmianę?"));
        done.push(change.id);
      } catch (error) {
        notify(`Zatrzymano cofanie na ${change.path}: ${error instanceof Error ? error.message : String(error)}`, "bad");
        break;
      }
    }
    markUndone(done);
    if (done.length === pending.length) notify(`Cofnięto ${done.length} zmian(y).`);
  };

  return { undo, undoAll };
}
