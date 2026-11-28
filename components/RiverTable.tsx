"use client";

/* bosai — RiverTable: river master data (via the A.A.S proxy) summarised
   to line/point counts per river — the raw geometry is never rendered. */

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/core";
import { riverRowsOf, type RiverRow } from "@/lib/master";

export default function RiverTable() {
  const [rows, setRows] = useState<RiverRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchJson("/api/a2s/master/rivers", 30_000).then((data) => {
      if (!cancelled) setRows(riverRowsOf(data) ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (rows === null) return <p className="muted">読み込み中…</p>;
  if (rows.length === 0) return <p className="muted">河川データがありません。</p>;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>河川名</th>
          <th>ライン数</th>
          <th>座標点数</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td>{r.name}</td>
            <td>{r.lineCount}</td>
            <td>{r.pointCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
