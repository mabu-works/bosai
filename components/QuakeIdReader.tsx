"use client";

/* bosai — QuakeIdReader: read ?id= from the URL on the client and hand
   the record to QuakeDetail (the detail page is statically generated, so
   the query parameter is only available client-side). */

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import QuakeDetail from "./QuakeDetail";

function Reader() {
  const params = useSearchParams();
  return <QuakeDetail quakeId={params.get("id")} />;
}

export default function QuakeIdReader() {
  return (
    <Suspense fallback={<p className="muted">読み込み中…</p>}>
      <Reader />
    </Suspense>
  );
}
