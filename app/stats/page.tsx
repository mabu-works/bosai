/* bosai — quake statistics (P2P history). */

import type { Metadata } from "next";
import StatsView from "@/components/StatsView";

export const metadata: Metadata = {
  title: "統計",
};

export default function StatsPage() {
  return (
    <div>
      <h1>地震の統計</h1>
      <StatsView />
    </div>
  );
}
