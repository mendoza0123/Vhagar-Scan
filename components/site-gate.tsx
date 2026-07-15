"use client";

import { useEffect, useState } from "react";

// Same key + endpoint as the Admin gate — so one PIN unlocks the whole site
// (and Admin), and it's the same booth PIN (ADMIN_PIN). Session-scoped: re-asks
// when the tab/session is closed, persists across refreshes and navigation.
const PIN_KEY = "vhagar.admin.pin";

export function SiteGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "locked" | "open">("checking");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    setState(sessionStorage.getItem(PIN_KEY) ? "open" : "locked");
  }, []);

  const unlock = async () => {
    if (!pin) return;
    setBusy(true);
    setErr(false);
    try {
      const res = await fetch("/api/admin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        sessionStorage.setItem(PIN_KEY, pin);
        setState("open");
      } else {
        setErr(true);
      }
    } catch {
      setErr(true);
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
                <p className="mb-4 mt-2 text-sm text-slate-500">Enter the booth PIN to continue</p>
                <input
                  value={pin}
                  autoFocus
                  onChange={(e) => setPin(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && unlock()}
                  type="password"
                  inputMode="numeric"
                  placeholder="••••"
                  className={`w-full rounded-xl border px-4 py-3 text-center text-2xl tracking-widest outline-none focus:border-brand ${
                    err ? "border-rose-400" : "border-slate-300"
                  }`}
                />
                {err && <p className="mt-2 text-sm text-rose-600">Wrong PIN.</p>}
                <button onClick={unlock} disabled={busy || !pin} className="btn btn-primary mt-4 w-full disabled:opacity-50">
                  {busy ? "Checking…" : "Unlock"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
