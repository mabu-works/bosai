"use client";

/* bosai — AmedasTable: the AMeDAS station master (via the A.A.S proxy)
   joined with the latest JMA observations (fetched directly from JMA:
   latest_time.txt, then the 10-minute-floored map snapshot). Rows are
   kept when any of temperature, 10-minute precipitation or wind is
   present. */

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/core";
import {
  AMEDAS_LATEST_URL,
  AMEDAS_MAP_URL,
  AMEDAS_TABLE_URL,
  WIND_DIRS,
  amedasTimestamp,
  buildAmedasRows,
  type AmedasRow,
} from "@/lib/stats";

export default function AmedasTable() {
  const [rows, setRows] = useState<AmedasRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const table = await fetchJson(AMEDAS_TABLE_URL, 30_000);
        const latestText = await fetch(AMEDAS_LATEST_URL).then((r) => (r.ok ? r.text() : ""));
        const latest = new Date(latestText.trim());
        if (Number.isNaN(latest.getTime())) throw new Error("latest_time");
        const data = await fetchJson(AMEDAS_MAP_URL(amedasTimestamp(latest)), 30_000);
        if (cancelled) return;
        setRows(buildAmedasRows(table, data));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return <p className="muted">アメダス観測データを取得できませんでした。</p>;
  if (rows === null) return <p className="muted">読み込み中…</p>;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>観測所</th>
          <th>気温</th>
          <th>湿度</th>
          <th>降水量（10分）</th>
          <th>風向</th>
          <th>風速</th>
          <th>積雪</th>
          <th>海面気圧</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td>{r.name}</td>
            <td>{r.temp !== null ? `${r.temp}℃` : "―"}</td>
            <td>{r.humidity !== null ? `${r.humidity}%` : "―"}</td>
            <td>{r.precip10 !== null ? `${r.precip10}mm` : "―"}</td>
            <td>{r.windDir !== null ? WIND_DIRS[Math.round(r.windDir / 22.5) % 16] : "―"}</td>
            <td>{r.wind !== null ? `${r.wind}m/s` : "―"}</td>
            <td>{r.snow !== null ? `${r.snow}cm` : "―"}</td>
            <td>{r.pressure !== null ? `${r.pressure}hPa` : "―"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
