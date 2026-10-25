// Prosty diff linii (LCS). Dla dużych plików jawnie informuje o braku pełnego podglądu.
import type { DiffLine } from './types';
export type DiffResult = { lines: DiffLine[]; added: number; removed: number; complete: boolean };
export function lineDiff(before: string, after: string): DiffResult {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length * b.length > 4_000_000) {
    const aa = new Set(a), bb = new Set(b);
    return { lines: [{ kind: 'gap', text: 'Duży plik — pełny podgląd diffu jest niedostępny. Sprawdź cały plik przed zatwierdzeniem.' }], added: b.filter(x => !aa.has(x)).length, removed: a.filter(x => !bb.has(x)).length, complete: false };
  }
  const table: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const raw: DiffLine[] = []; let i = 0, j = 0, added = 0, removed = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) raw.push({ kind: 'same', text: a[i++] }), j++;
    else if (table[i + 1][j] >= table[i][j + 1]) raw.push({ kind: 'del', text: a[i++] }), removed++;
    else raw.push({ kind: 'add', text: b[j++] }), added++;
  }
  while (i < a.length) raw.push({ kind: 'del', text: a[i++] }), removed++;
  while (j < b.length) raw.push({ kind: 'add', text: b[j++] }), added++;
  return { lines: compact(raw, 3), added, removed, complete: true };
}
function compact(lines: DiffLine[], context: number): DiffLine[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((line, index) => { if (line.kind !== 'same') for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true; });
  const out: DiffLine[] = []; let skipped = 0;
  lines.forEach((line, index) => { if (keep[index]) { if (skipped) out.push({ kind: 'gap', text: `… ${skipped} niezmienionych linii` }), skipped = 0; out.push(line); } else skipped++; });
  if (skipped && out.length) out.push({ kind: 'gap', text: `… ${skipped} niezmienionych linii` });
  return out;
}
