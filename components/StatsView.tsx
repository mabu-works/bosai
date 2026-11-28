"use client";

/* bosai — StatsView: quake statistics over the P2P history API (the one
   page that does not go through A.A.S). Periods of 7/30/90 days;
   counts by scale (including the unknown-scale bucket so the rows sum
   to the total) and by prefecture (a quake counts once per prefecture). */

import { useEffect, useState } from "react";
import { scaleLabel } from "@/lib/core";
import { aggregateQuakeStats, fetchHistory, parseHistoryQuake, type HistoryQuake, type QuakeStats } from "@/lib/stats";
import ScaleBadge from "./ScaleBadge";

const PERIODS = [7, 30, 90];

export default function StatsView() {
  const [days, setDays] = useState(30);
  const [records, setRecords] = useState<HistoryQuake[] | null>(null);
  const [stats, setStats] = useState<QuakeStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries: unknown[] = [];
      entries.push(...(await fetchHistory(551, 5)));
      entries.push(...(await fetchHistory(552, 1)));
      entries.push(...(await fetchHistory(556, 1)));
      if (cancelled) return;
      const parsed = entries.map(parseHistoryQuake).filter((q): q is HistoryQuake => q !== null);
      setRecords(parsed);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (records) setStats(aggregateQuakeStats(records, days));
  }, [records, days]);

  if (records === null || stats === null) return <p className="muted">集計しています…</p>;
  return (
    <div>
      <div className="table-tools">
        {PERIODS.map((p) => (
          <button key={p} type="button" onClick={() => setDays(p)} aria-pressed={days === p}>
            過去{p}日
          </button>
        ))}
        <span className="muted">対象 {stats.total}件</span>
      </div>
      {stats.strongest ? (
        <p>
          期間中の最大: {stats.strongest.time} {stats.strongest.hypocenter} 最大震度 {scaleLabel(stats.strongest.maxScale)}
        </p>
      ) : null}
      <h2>震度別</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>最大震度</th>
            <th>件数</th>
          </tr>
        </thead>
        <tbody>
          {stats.byScale.map((row) => (
            <tr key={row.scale}>
              <td>
                {row.scale > 0 ? (
                  <>
                    <ScaleBadge scale={row.scale} size="sm" /> {scaleLabel(row.scale)}
                  </>
                ) : (
                  "震度不明"
                )}
              </td>
              <td>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>都道府県別（上位10件）</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>都道府県</th>
            <th>件数</th>
          </tr>
        </thead>
        <tbody>
          {stats.byPref.map((row) => (
            <tr key={row.pref}>
              <td>{row.pref}</td>
              <td>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>日別</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>日付</th>
            <th>件数</th>
          </tr>
        </thead>
        <tbody>
          {stats.byDay.map((row) => (
            <tr key={row.date}>
              <td>{row.date}</td>
              <td>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">出典: P2P地震情報 履歴API</p>
    </div>
  );
}
