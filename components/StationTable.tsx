"use client";

/* bosai — StationTable: a searchable reference table over one A.A.S
   master dataset (via the same-origin proxy). Display is capped at 500
   rows; the search box filters before the cap is applied. */

import { useEffect, useMemo, useState } from "react";
import { fetchJson } from "@/lib/core";

export interface StationColumn {
  key: string;
  label: string;
}

// 📥 Pull the row array out of the common response shapes: a bare array,
// {stations: [...]}, or the first array-valued property.
function extractRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    if (Array.isArray(rec.stations)) return rec.stations as Record<string, unknown>[];
    for (const v of Object.values(rec)) {
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

const DISPLAY_CAP = 500;

export default function StationTable({ url, columns }: { url: string; columns: StationColumn[] }) {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetchJson(url, 30_000).then((data) => {
      if (!cancelled) setRows(extractRows(data));
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim();
    if (!q) return rows;
    return rows.filter((r) => columns.some((c) => String(r[c.key] ?? "").includes(q)));
  }, [rows, query, columns]);

  if (rows === null) return <p className="muted">読み込み中…</p>;
  return (
    <div>
      <div className="table-tools">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="検索"
          aria-label="検索"
        />
        <span className="muted">
          {filtered.length}件{filtered.length > DISPLAY_CAP ? `（上位${DISPLAY_CAP}件を表示）` : ""}
        </span>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.slice(0, DISPLAY_CAP).map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key}>{r[c.key] === null || r[c.key] === undefined ? "―" : String(r[c.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
