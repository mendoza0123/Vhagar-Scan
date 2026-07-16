"use client";

import { useEffect, useState } from "react";
import { PIN_KEY, STAFF_KEY } from "@/lib/staff";

// Same PIN + endpoint as the Admin gate — so one PIN unlocks the whole site
// (and Admin), and it's the same booth PIN (ADMIN_PIN). Session-scoped: re-asks
// when the tab/session is closed, persists across refreshes and navigation.
//
// The PIN is shared by the whole booth, so on its own it can't say WHO is
// selling. The name is therefore mandatory too: it becomes the operator's ID
// for the session and is stamped onto their sales (sold_by) and rack moves.
export function SiteGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "locked" | "open">("checking");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Both are required — a session that predates the name still gets asked.
    const open = sessionStorage.getItem(PIN_KEY) && sessionStorage.getItem(STAFF_KEY);
    setState(open ? "open" : "locked");
  }, []);

  const ready = name.trim().length >= 2 && pin.length > 0;

  const unlock = async () => {
    if (!ready) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        sessionStorage.setItem(PIN_KEY, pin);
        sessionStorage.setItem(STAFF_KEY, name.trim());
        setState("open");
      } else {
        setErr("Wrong PIN.");
      }
    } catch {
      setErr("No signal — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {children}
      {state !== "open" && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-brand p-4">
          <div className="w-full max-w-xs rounded-2xl bg-white p-6 text-center shadow-xl">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/lockup-black.png" alt="Vhagar" className="mx-auto h-16 w-auto" />
            {state === "checking" ? (
              <p className="mt-3 text-sm text-slate-400">Loading…</p>
            ) : (
              <>
                <p className="mb-4 mt-2 text-sm text-slate-500">
                  Your name and the booth PIN to continue
                </p>
                <input
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && unlock()}
                  placeholder="Your name"
                  autoCapitalize="words"
                  autoComplete="off"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-center text-lg outline-none focus:border-brand"
                />
                <input
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && unlock()}
                  type="password"
                  inputMode="numeric"
                  placeholder="••••"
                  className={`mt-2 w-full rounded-xl border px-4 py-3 text-center text-2xl tracking-widest outline-none focus:border-brand ${
                    err ? "border-rose-400" : "border-slate-300"
                  }`}
                />
                {err && <p className="mt-2 text-sm text-rose-600">{err}</p>}
                <button
                  onClick={unlock}
                  disabled={busy || !ready}
                  className="btn btn-primary mt-4 w-full disabled:opacity-50"
                >
                  {busy ? "Checking…" : "Unlock"}
                </button>
                <p className="mt-3 text-xs text-slate-400">
                  Your sales are recorded under this name.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
