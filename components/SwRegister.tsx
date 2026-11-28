"use client";

/* bosai — SwRegister: register the service worker once on mount. */

import { useEffect } from "react";

export default function SwRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // 📌 Registration failure must not break the page.
      });
    }
  }, []);
  return null;
}
