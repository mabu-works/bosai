/* bosai — response shaping for the A.A.S master data used by the
   reference pages (rivers). Pure functions that accept both the wrapped
   A.A.S contract shape and the bare payload shape, following the same
   normalisation approach as lib/map-data.ts. */

// 🏞️ One river, summarised from its line geometry.
export interface RiverRow {
  name: string;
  lineCount: number;
  pointCount: number;
}

// 📌 Turn river data ({rivers: {name: {lines: [...]}}} or the rivers map
// itself) into display rows. Rivers whose lines are not an array are
// dropped; the point count totals the [lon, lat] pairs across all lines.
// Row order follows the data order.
export function riverRowsOf(data: unknown): RiverRow[] | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  const rivers =
    rec.rivers && typeof rec.rivers === "object" && !Array.isArray(rec.rivers)
      ? (rec.rivers as Record<string, unknown>)
      : rec;
  const rows: RiverRow[] = [];
  for (const [name, entry] of Object.entries(rivers)) {
    if (!entry || typeof entry !== "object") continue;
    const lines = (entry as Record<string, unknown>).lines;
    if (!Array.isArray(lines)) continue;
    let pointCount = 0;
    for (const line of lines) {
      if (Array.isArray(line)) pointCount += line.length;
    }
    rows.push({ name, lineCount: lines.length, pointCount });
  }
  return rows;
}
