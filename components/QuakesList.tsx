"use client";

/* bosai — quake list (past 72 hours): merged records, newest first,
   each linking to its detail page. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchA2sQuakes, type MergedQuake } from "@/lib/a2s";
import { depthLabel, fmtTime, parseJstTime } from "@/lib/core";
import ScaleBadge from "./ScaleBadge";

function fmtDateTime(s: string): string {
  const d = parseJstTime(s);
  if (!d) return s;
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(d)}`;
}

export default function QuakesList() {
  const [quakes, setQuakes] = useState<MergedQuake[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchA2sQuakes(undefined, 100).then((list) => {
      if (!cancelled) setQuakes(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (quakes === null) return <p className="muted">読み込み中…</p>;
  if (quakes.length === 0) return <p className="muted">過去72時間に表示できる地震がありません。</p>;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>発生時刻</th>
          <th>震源</th>
          <th>規模</th>
          <th>深さ</th>
          <th>最大震度</th>
        </tr>
      </thead>
      <tbody>
        {quakes.map((q) => (
          <tr key={q.id}>
            <td>
              <Link href={`/quake?id=${encodeURIComponent(q.id)}`}>{fmtDateTime(q.time)}</Link>
            </td>
            <td>{q.hypocenter}</td>
            <td>{q.magnitude !== null ? `M${q.magnitude}` : "―"}</td>
            <td>{depthLabel(q.depthKm)}</td>
            <td>
              <ScaleBadge scale={q.maxScale} size="sm" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
