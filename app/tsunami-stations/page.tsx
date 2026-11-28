/* bosai — tsunami station master list. */

import type { Metadata } from "next";
import StationTable from "@/components/StationTable";

export const metadata: Metadata = {
  title: "津波観測点",
};

export default function TsunamiStationsPage() {
  return (
    <div>
      <h1>津波観測点</h1>
      <StationTable
        url="/api/a2s/master/tsunami-stations"
        columns={[
          { key: "name", label: "観測点" },
          { key: "lat", label: "緯度" },
          { key: "lon", label: "経度" },
        ]}
      />
    </div>
  );
}
