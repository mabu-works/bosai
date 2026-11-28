/* bosai — quake list page (past 72 hours). */

import type { Metadata } from "next";
import QuakesList from "@/components/QuakesList";

export const metadata: Metadata = {
  title: "地震一覧",
};

export default function QuakesPage() {
  return (
    <div>
      <h1>地震一覧（過去72時間）</h1>
      <QuakesList />
    </div>
  );
}
