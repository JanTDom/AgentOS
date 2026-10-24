// Prosty diff linii (LCS) do podglądu zmian przed zapisem.
import type { DiffLine } from "./types";

export function lineDiff(before: string, after: string): { lines: DiffLine[]; added: number; removed: number } {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length * b.length > 4_000_000) {
    // Zbyt duże pliki: tylko podsumowanie, bez pełnego porównania.
    const common = new Set(a);
    const added = b.filter((line) => !common.has(line)).length;
    const removedSet = new Set(b);
    const removed = a.filter((line) => !removedSet.has(line)).length;
    return { lines: [{ kind: "gap", text: `Plik jest duży — pokazano tylko liczbę zmienionych linii.` }], added, removed };
  }
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const raw: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { raw.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { raw.push({ kind: "del", text: a[i] }); i++; removed++; }
    else { raw.push({ kind: "add", text: b[j] }); j++; added++; }
  }
  while (i < n) { raw.push({ kind: "del", text: a[i++] }); removed++; }
  while (j < m) { raw.push({ kind: "add", text: b[j++] }); added++; }
  return { lines: compact(raw, 3), added, removed };
}

/** Zostawia kontekst wokół zmian, resztę zwija. */
function compact(lines: DiffLine[], context: number): DiffLine[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) { out.push({ kind: "gap", text: `… ${skipped} niezmienionych linii` }); skipped = 0; }
      out.push(line);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ kind: "gap", text: `… ${skipped} niezmienionych linii` });
  return out.slice(0, 400);
}
