/* bosai — volcano master list. Coordinates are crater representative
   points, not alert ranges. */

import type { Metadata } from "next";
import StationTable from "@/components/StationTable";

export const metadata: Metadata = {
  title: "火山",
};

export default function VolcanoesPage() {
  return (
    <div>
      <h1>火山</h1>
      <p className="muted">座標は火口の代表点であり、警戒範囲を示すものではありません。</p>
      <StationTable
        url="/api/a2s/master/volcanoes"
        columns={[
          { key: "name", label: "火山名" },
          { key: "lat", label: "緯度" },
          { key: "lon", label: "経度" },
        ]}
      />
    </div>
  );
}
