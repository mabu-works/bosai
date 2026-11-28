/* bosai — AMeDAS latest observations. */

import type { Metadata } from "next";
import AmedasTable from "@/components/AmedasTable";

export const metadata: Metadata = {
  title: "AMeDAS",
};

export default function AmedasPage() {
  return (
    <div>
      <h1>AMeDAS 最新観測</h1>
      <AmedasTable />
      <p className="muted">出典: 気象庁 アメダス</p>
    </div>
  );
}
