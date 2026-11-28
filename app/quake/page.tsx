/* bosai — quake detail page (?id=...). */

import type { Metadata } from "next";
import QuakeIdReader from "@/components/QuakeIdReader";

export const metadata: Metadata = {
  title: "地震詳細",
};

export default function QuakePage() {
  return <QuakeIdReader />;
}
