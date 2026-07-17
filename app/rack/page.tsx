"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { staffName } from "@/lib/staff";

const Scanner = dynamic(() => import("../sell/Scanner"), { ssr: false });

type Line = { sku: string; name: string; size: string; qty: number };

// Short beep + buzz so staff get feedback without looking at the screen.
// (Same contract as the sell screen.)
function feedback(ok: boolean) {
  try {
    navigator.vibrate?.(ok ? 30 : [40, 40, 40]);
  } catch {
    /* noop */
  }
  try {
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!Ctx) return;
    const ac = new Ctx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.frequency.value = ok ? 880 : 220;
    gain.gain.setValueAtTime(0.0001, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.16);
    osc.start();
    osc.stop(ac.currentTime + 0.17);
    osc.onended = () => ac.close();
  } catch {
    /* noop */
  }
}

// Unpack a carton onto the rack: rapid-scan every piece, then Move to Rack.
// Pieces of the same style+size share ONE QR, so scanning the same tag twice is
// two real pieces — the tally counts every presentation on purpose.
type MoveResult = { moved: number; from_cartons: number; capped: number };
type ReturnResult = { returned: number; skipped: number; details: { sku: string; carton: string; qty: number }[] };

export default function RackPage() {
  const [scanning, setScanning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "warn" } | null>(null);
  const [busy, setBusy] = useState(false);
  // Which way pieces flow: unpack a box onto the rack, or put rack pieces back
  // into the box they came out of (wrong pull, closing down a display, etc.)
  const [mode, setMode] = useState<"rack" | "return">("rack");
  const [done, setDone] = useState<{ kind: "rack"; r: MoveResult } | { kind: "return"; r: ReturnResult } | null>(null);

  const scanState = useRef<Map<string, { lastSeen: number; armed: boolean }>>(new Map());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const REARM_GAP_MS = 800; // tag must leave the frame this long to count again

  const showToast = useCallback((msg: string, tone: "ok" | "warn" = "ok") => {
    setToast({ msg, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }, []);

  const addSku = useCallback(
    async (raw: string) => {
      const sku = raw.trim().toUpperCase();
      if (!sku) return;
      if (/CTN-?\d/i.test(sku)) {
        feedback(false);
        showToast("That's a carton label — scan the garments", "warn");
        return;
      }
      try {
        const res = await fetch(`/api/variants/${encodeURIComponent(sku)}`);
        if (res.status === 404) {
          feedback(false);
          showToast(`Unknown tag: ${sku}`, "warn");
          return;
        }
        if (!res.ok) throw new Error("lookup failed");
        const v = await res.json();
        setLines((prev) => {
          const i = prev.findIndex((l) => l.sku === v.variant_sku);
          if (i >= 0) {
            const next = [...prev];
            next[i] = { ...next[i], qty: next[i].qty + 1 };
            return next;
          }
          return [...prev, { sku: v.variant_sku, name: v.name, size: v.size, qty: 1 }];
        });
        setDone(null);
        feedback(true);
        showToast(`${v.name} · ${v.size}`);
      } catch {
        feedback(false);
        showToast("Network error — not counted, scan again", "warn");
      }
    },
    [showToast]
  );

  // One add per tag presentation; ignore the ~10/sec re-reads while it's held up.
  const onScan = useCallback(
    (text: string) => {
      const code = text.trim();
      if (!code) return;
      const now = Date.now();
      const st = scanState.current.get(code) || { lastSeen: 0, armed: true };
      if (now - st.lastSeen > REARM_GAP_MS) st.armed = true;
      st.lastSeen = now;
      if (st.armed) {
        st.armed = false;
        scanState.current.set(code, st);
        addSku(code);
      } else {
        scanState.current.set(code, st);
      }
    },
    [addSku]
  );

  const bump = (sku: string, d: number) =>
    setLines((prev) =>
      prev.flatMap((l) => (l.sku === sku ? (l.qty + d <= 0 ? [] : [{ ...l, qty: l.qty + d }]) : [l]))
    );

  const total = lines.reduce((n, l) => n + l.qty, 0);

  const move = async () => {
    if (lines.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/rack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: lines.map((l) => ({ sku: l.sku, qty: l.qty })),
          by: staffName(), // who did it
          action: mode === "return" ? "return" : "move",
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        feedback(false);
        showToast(d.message || "Could not move — try again", "warn");
        return; // keep the list so staff can retry on a flaky hotspot
      }
      feedback(true);
      setDone(mode === "return" ? { kind: "return", r: d } : { kind: "rack", r: d });
      setLines([]);
      scanState.current.clear();
    } catch {
      feedback(false);
      showToast("No signal — list kept, try again", "warn");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4 pb-40">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-sm font-medium text-brand">← Home</Link>
        <h1 className="text-lg font-bold text-brand">Move to Rack</h1>
        <Link href="/find" className="text-sm text-slate-500">Find</Link>
      </header>

      {/* which way the pieces flow */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => { setMode("rack"); setDone(null); }}
          className={`rounded-xl border px-3 py-2.5 text-sm font-semibold ${mode === "rack" ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}
        >
          ➡ To Rack
        </button>
        <button
          onClick={() => { setMode("return"); setDone(null); }}
          className={`rounded-xl border px-3 py-2.5 text-sm font-semibold ${mode === "return" ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}
        >
          ↩ Back to carton
        </button>
      </div>

      <p className="rounded-xl bg-slate-100 p-3 text-xs leading-relaxed text-slate-500">
        {mode === "rack" ? (
          <>Unpacking a box? Scan every piece, then <b>Move to Rack</b>. This only changes
          <b> where</b> a piece is — it never changes stock.</>
        ) : (
          <>Putting pieces back? Scan them — each goes back into <b>the box it came out of</b>.
          Location only; stock never changes.</>
        )}
      </p>

      <section>
        {scanning ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <Scanner onScan={onScan} />
            <button onClick={() => setScanning(false)} className="btn btn-ghost mt-3 w-full">⏹ Stop camera</button>
          </div>
        ) : (
          <button onClick={() => setScanning(true)} className="btn btn-primary w-full py-6 text-lg">
            📷 Start scanning
          </button>
        )}
      </section>

      {done && done.kind === "rack" && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
          ✅ Moved <b>{done.r.moved}</b> piece{done.r.moved === 1 ? "" : "s"} to the rack
          {done.r.from_cartons > 0 && <> · {done.r.from_cartons} taken out of carton(s)</>}
          {done.r.capped > 0 && (
            <p className="mt-1 text-amber-800">
              ⚠ {done.r.capped} skipped — that would put more on the rack than we own
              (already moved, or scanned twice).
            </p>
          )}
        </div>
      )}
      {done && done.kind === "return" && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
          ✅ Returned <b>{done.r.returned}</b> piece{done.r.returned === 1 ? "" : "s"} to carton
          {done.r.details.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {done.r.details.map((d, i) => (
                <li key={i}>
                  {d.qty} × {d.sku} → <b className="font-mono">{d.carton}</b>
                </li>
              ))}
            </ul>
          )}
          {done.r.skipped > 0 && (
            <p className="mt-1 text-amber-800">
              ⚠ {done.r.skipped} skipped — not on the rack, or no box to return to.
            </p>
          )}
        </div>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          To {mode === "return" ? "return" : "move"} ({total})
        </h2>
        {lines.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
            Scan a garment tag to start.
          </p>
        ) : (
          lines.map((l) => (
            <div key={l.sku} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{l.name}</span>
                <span className="text-xs text-slate-400">{l.size} · {l.sku}</span>
              </span>
              <button onClick={() => bump(l.sku, -1)} className="h-10 w-10 rounded-xl border border-slate-300 text-xl font-bold active:bg-slate-100">−</button>
              <span className="w-8 text-center text-lg font-semibold tabular-nums">{l.qty}</span>
              <button onClick={() => bump(l.sku, 1)} className="h-10 w-10 rounded-xl border border-slate-300 text-xl font-bold active:bg-slate-100">+</button>
            </div>
          ))
        )}
      </section>

      {toast && (
        <div className={`fixed left-1/2 top-4 z-40 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-medium shadow-lg ${
          toast.tone === "ok" ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"
        }`}>
          {toast.msg}
        </div>
      )}

      {lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md border-t border-slate-200 bg-white/95 p-3 backdrop-blur">
          <button onClick={move} disabled={busy} className="btn btn-primary w-full py-4 text-lg disabled:opacity-50">
            {busy ? "Moving…" : mode === "return" ? `↩ Return ${total} to carton` : `➡ Move ${total} to Rack`}
          </button>
          <button onClick={() => { setLines([]); scanState.current.clear(); }} className="mt-2 w-full text-xs text-slate-400 underline">
            Clear list
          </button>
        </div>
      )}
    </main>
  );
}
