/**
 * CSV parsing utilities for the Medley CSV export format.
 * Columns: Nr;Distanse;Tid;Poeng;Dato;Sted;Basseng;D;RK;RA
 */

export function parseCSV(text) {
  if (!text || text.trim().length === 0) return [];
  const cleaned = text.replace(/^\uFEFF/, "").trim();
  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0]
    .split(";")
    .map((h) => h.replace(/^"|"$/g, "").trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    if (vals.length === 0) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (vals[idx] || "").replace(/^"|"$/g, "").trim() || null;
    });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const vals = [];
  let cur = "",
    inQ = false;
  for (const ch of line) {
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === ";" && !inQ) {
      vals.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  vals.push(cur);
  return vals;
}
