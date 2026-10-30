"use client";

import { useEffect, useState } from "react";
import { BASE_STAFF } from "./staff";

// The "Sold by" names from /api/staff (managed in IMS -> Admin -> POS staff).
// Kept apart from lib/staff.ts because the API route imports that one, and a
// server file can't pull in React hooks.
const LIST_KEY = "vhagar.staff.list.v1";
export function useStaffList(): string[] {
  const [names, setNames] = useState<string[]>(BASE_STAFF);
  useEffect(() => {
    let live = true;
    try {
      const cached = localStorage.getItem(LIST_KEY);
      if (cached) setNames(JSON.parse(cached));
    } catch { /* no cache yet */ }
    const load = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/staff", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!live || !Array.isArray(d?.names) || d.names.length === 0) return;
          setNames(d.names);
          try { localStorage.setItem(LIST_KEY, JSON.stringify(d.names)); } catch { /* full or blocked */ }
        })
        .catch(() => { /* dead hotspot: keep the cached list */ });
    };
    load();
    // the sell screen stays open all day — pick up a name added in IMS when the
    // phone comes back to it
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  return names;
}
