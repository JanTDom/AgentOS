import { lineDiff } from './diff';
import { restoreChat, trashChat } from './chatTrash';
import { emptySnapshot, type Conversation } from './types';
function ok(v: unknown, m: string) { if (!v) throw new Error(m); }
const chat: Conversation = { id: 'c1', projectId: null, title: 'Stary czat', status: 'done', createdAt: '2026-01-01', updatedAt: '2026-01-01', providerId: 'openai', model: 'm', items: [], api: [], changes: [], usage: { input: 0, output: 0 } };
const trashed = trashChat({ ...structuredClone(emptySnapshot), conversations: [chat] }, 'c1', false);
ok(trashed.conversations.length === 0 && trashed.trash?.length === 1, 'trash failed');
const restored = restoreChat(trashed, 'c1');
ok(restored.conversations[0]?.id === 'c1' && restored.trash?.length === 0, 'restore failed');
let blocked = false; try { trashChat({ ...emptySnapshot, conversations: [chat] }, 'c1', true); } catch { blocked = true; }
ok(blocked, 'active chat deletion not blocked');
const d = lineDiff('a\nb', 'a\nc'); ok(d.added === 1 && d.removed === 1 && d.complete, 'diff failed');
const huge = lineDiff('a\n'.repeat(2100), 'b\n'.repeat(2100)); ok(!huge.complete, 'large diff should be marked incomplete');
console.log('frontend logic tests: ok');
