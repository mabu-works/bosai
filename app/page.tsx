/* bosai — top page (the live dashboard). */

import type { Metadata } from "next";
import Dashboard from "@/components/Dashboard";

export const metadata: Metadata = {
  title: "bosai | 防災情報ダッシュボード",
};

export default function HomePage() {
  return <Dashboard />;
}
