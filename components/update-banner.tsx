"use client";

import { useEffect, useState } from "react";

// A deploy doesn't reach a phone that already has the page open — staff keep the
// POS up all day, so a shipped fix can look like it never landed. This notices
// the build changing underneath them and offers a reload. It never reloads on
// its own: that would lose a half-built cart mid-sale.
export function UpdateBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let loaded: string | null = null;
    let live = true;

    const check = async () => {
      // Don't interrupt someone mid-sale, and don't poll in a background tab.
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { id } = await res.json();
        if (!live || !id) return;
        if (loaded === null) loaded = id;
        else if (id !== loaded) setStale(true);
      } catch {
        /* offline on the booth hotspot — just try again later */
      }
    };

    check();
    // cheap: one tiny request every few minutes, plus whenever the phone comes
    // back to the screen, which is when staff actually look at it
    const timer = setInterval(check, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", check);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="sticky top-0 z-50 flex items-center gap-3 bg-brand px-4 py-2 text-sm text-white shadow">
      <span className="flex-1">A newer version is ready.</span>
      <button
        onClick={() => window.location.reload()}
        className="rounded-lg bg-white/20 px-3 py-1 font-semibold"
      >
        Reload
      </button>
      <button onClick={() => setStale(false)} aria-label="Dismiss" className="px-1 opacity-70">
        ✕
      </button>
    </div>
  );
}
