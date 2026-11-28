/* bosai — ScaleBadge: an intensity chip coloured by the map palette. */

import { scaleLabel, scaleStyle } from "@/lib/core";

export default function ScaleBadge({ scale, size = "md" }: { scale: number; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      className={`scale-badge scale-badge-${size}`}
      style={{ backgroundColor: scaleStyle(scale).color, color: scale === 40 ? "#212121" : "#ffffff" }}
    >
      {scaleLabel(scale)}
    </span>
  );
}
