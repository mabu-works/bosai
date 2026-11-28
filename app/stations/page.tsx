/* bosai — intensity station master list. */

import type { Metadata } from "next";
import StationTable from "@/components/StationTable";

export const metadata: Metadata = {
  title: "震度観測点",
};

export default function StationsPage() {
  return (
    <div>
      <h1>震度観測点</h1>
      <StationTable
        url="/api/a2s/master/stations"
        columns={[
          { key: "addr", label: "観測点" },
          { key: "lat", label: "緯度" },
          { key: "lon", label: "経度" },
        ]}
      />
    </div>
  );
}
