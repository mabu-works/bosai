/* bosai — river master list (geometry summarised to counts). */

import type { Metadata } from "next";
import RiverTable from "@/components/RiverTable";

export const metadata: Metadata = {
  title: "河川",
};

export default function RiversPage() {
  return (
    <div>
      <h1>河川</h1>
      <RiverTable />
    </div>
  );
}
