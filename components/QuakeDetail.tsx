"use client";

/* bosai — quake detail: fetch the merged quake list, pick the record by
   id, and show its summary, intensity tables (by prefecture from area
   points, and the station list) and the report/marker maps. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchA2sQuakes, type MergedQuake } from "@/lib/a2s";
import { TSUNAMI_LABELS, depthLabel, parseJstTime, fmtTime, scaleLabel } from "@/lib/core";
import { loadAndResolveQuakePoints } from "@/lib/map-data";
import { buildIntensityMarkerCanvas, buildIntensityReportCanvas } from "@/lib/map-render";
import CanvasSlot from "./CanvasSlot";
import ScaleBadge from "./ScaleBadge";

function fmtDateTime(s: string): string {
  const d = parseJstTime(s);
  if (!d) return s;
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(d)}`;
}

export default function QuakeDetail({ quakeId }: { quakeId: string | null }) {
  const [record, setRecord] = useState<MergedQuake | null>(null);
  const [state, setState] = useState<"loading" | "found" | "missing">("loading");

  useEffect(() => {
    let cancelled = false;
    if (!quakeId) {
      setState("missing");
      return;
    }
    void fetchA2sQuakes(undefined, 100).then((list) => {
      if (cancelled) return;
      const found = list.find((q) => q.id === quakeId || q.ids.includes(quakeId)) ?? null;
      setRecord(found);
      setState(found ? "found" : "missing");
    });
    return () => {
      cancelled = true;
    };
  }, [quakeId]);

  if (state === "loading") return <p className="muted">読み込み中…</p>;
  if (state === "missing" || !record) {
    return (
      <div>
        <p>指定された地震が見つかりませんでした（72時間を過ぎた地震は表示できません）。</p>
        <p>
          <Link href="/quakes">地震一覧へ</Link>
        </p>
      </div>
    );
  }

  // 📊 Prefecture summary from area points; station list from measured
  // points, strongest first.
  const prefRows = record.points
    .filter((p) => p.isArea)
    .map((p) => ({ name: p.pref, scale: p.scale }))
    .sort((a, b) => b.scale - a.scale);
  const stationRows = record.points
    .filter((p) => !p.isArea)
    .sort((a, b) => b.scale - a.scale);

  return (
    <div>
      <h1>
        {fmtDateTime(record.time)}ごろ {record.hypocenter}の地震
      </h1>
      <p className="quake-summary">
        <ScaleBadge scale={record.maxScale} size="lg" /> 最大震度 {scaleLabel(record.maxScale)} ／{" "}
        {record.magnitude !== null ? `M${record.magnitude}` : "M―"} ／ 深さ{depthLabel(record.depthKm)}
      </p>
      <p className="muted">{TSUNAMI_LABELS[record.tsunamiKind] ?? ""}</p>
      <CanvasSlot
        build={async () => {
          const { points } = await loadAndResolveQuakePoints(record);
          return buildIntensityReportCanvas(points, record);
        }}
      />
      <CanvasSlot
        build={async () => {
          const { points } = await loadAndResolveQuakePoints(record);
          return buildIntensityMarkerCanvas(points, record);
        }}
      />
      {prefRows.length > 0 ? (
        <>
          <h2>都道府県別の最大震度</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>都道府県</th>
                <th>最大震度</th>
              </tr>
            </thead>
            <tbody>
              {prefRows.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td>
                    <ScaleBadge scale={r.scale} size="sm" /> {scaleLabel(r.scale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {stationRows.length > 0 ? (
        <>
          <h2>震度観測点（{stationRows.length}地点）</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>観測点</th>
                <th>震度</th>
              </tr>
            </thead>
            <tbody>
              {stationRows.map((p) => (
                <tr key={p.addr}>
                  <td>{p.addr}</td>
                  <td>
                    <ScaleBadge scale={p.scale} size="sm" /> {scaleLabel(p.scale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      <p>
        <Link href="/quakes">地震一覧へ</Link>
      </p>
    </div>
  );
}
