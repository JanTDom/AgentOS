import { lineDiff } from './diff';
import { restoreChat, trashChat } from './chatTrash';
import { emptySnapshot, type Conversation, type InstalledSkill } from './types';
import { enabledSkills, resolveSkill, searchInstalledSkills, skillsSection } from './skillsCatalog';

function ok(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const chat: Conversation = { id: 'c1', projectId: null, title: 'Stary czat', status: 'done', createdAt: '2026-01-01', updatedAt: '2026-01-01', providerId: 'openai', model: 'm', items: [], api: [], changes: [], usage: { input: 0, output: 0 } };
const trashed = trashChat({ ...structuredClone(emptySnapshot), conversations: [chat] }, 'c1', false);
ok(trashed.conversations.length === 0 && trashed.trash?.length === 1, 'trash failed');
const restored = restoreChat(trashed, 'c1');
ok(restored.conversations[0]?.id === 'c1' && restored.trash?.length === 0, 'restore failed');
let blocked = false;
try { trashChat({ ...emptySnapshot, conversations: [chat] }, 'c1', true); } catch { blocked = true; }
ok(blocked, 'active chat deletion not blocked');
const diff = lineDiff('a\nb', 'a\nc');
ok(diff.added === 1 && diff.removed === 1 && diff.complete, 'diff failed');
const huge = lineDiff('a\n'.repeat(2100), 'b\n'.repeat(2100));
ok(!huge.complete, 'large diff should be marked incomplete');

const makeSkill = (index: number, patch: Partial<InstalledSkill> = {}): InstalledSkill => ({
  key: `global/skill-${index}`,
  scope: 'global',
  slug: `skill-${index}`,
  name: `Skill ${index}`,
  description: `Instructions for topic ${index}`,
  dir: `/skills/skill-${index}`,
  location: 'AgentOS',
  fileCount: 1,
  hasScripts: false,
  removable: true,
  ...patch,
});
const skills = Array.from({ length: 212 }, (_, index) => makeSkill(index + 1));
const prompt = skillsSection(skills);
ok(prompt.includes('Dostępne umiejętności: 212'), 'skills prompt should report complete library size');
ok(prompt.includes('[global/skill-212]'), 'skills prompt must include skills past the former 60-item limit');
ok(searchInstalledSkills(skills, 'TOPIC 212').length === 1, 'local search should match final skill description case-insensitively');
ok(searchInstalledSkills(skills, '').length === 212, 'empty local query should return all skills without a limit');
ok(resolveSkill(skills, 'global/skill-212')?.name === 'Skill 212', 'resolveSkill should accept exact skill key');
const duplicate = [makeSkill(1, { name: 'Duplicate' }), makeSkill(2, { name: 'Duplicate' })];
let ambiguityRejected = false;
try { resolveSkill(duplicate, 'Duplicate'); } catch (error) { ambiguityRejected = error instanceof Error && error.message.includes('Niejednoznaczna'); }
ok(ambiguityRejected, 'duplicate names must request an explicit exact identifier');
const projectSkill = makeSkill(300, { key: '.agentos/skills/skill-300', scope: 'project' });
const active = enabledSkills([skills[0], projectSkill], ['global/skill-1', 'project-1|.agentos/skills/skill-300'], 'project-1');
ok(active.length === 0, 'disabled global and project skills must remain hidden from agent');

console.log('frontend logic tests: ok (including full installed skills catalog)');
