"use client";

/* bosai — CanvasSlot: run an async canvas builder and place the result.
   The builder may be slow (tile fetches), so the slot shows a loading
   message meanwhile and clears the host when the builder yields null. */

import { useEffect, useRef } from "react";

export default function CanvasSlot({
  build,
  caption,
}: {
  build: () => Promise<HTMLCanvasElement | null>;
  caption?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    const host = ref.current;
    if (host) {
      host.innerHTML = "";
      const loading = document.createElement("p");
      loading.className = "muted";
      loading.textContent = "地図を生成しています…";
      host.appendChild(loading);
    }
    build()
      .then((canvas) => {
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = "";
        if (canvas) {
          canvas.className = "map-canvas";
          ref.current.appendChild(canvas);
        }
      })
      .catch(() => {
        if (!cancelled && ref.current) ref.current.innerHTML = "";
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div>
      <div ref={ref} />
      {caption ? <p className="muted">{caption}</p> : null}
    </div>
  );
}
