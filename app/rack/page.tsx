"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { staffName } from "@/lib/staff";
import { oneWordColour } from "@/lib/short-colour";

const Scanner = dynamic(() => import("../sell/Scanner"), { ssr: false });

type Line = { sku: string; name: string; size: string; qty: number; stock: number };
type DesignHit = { style_code: string; name: string; color: string | null; qty_on_hand: number };
type SizeHit = { variant_sku: string; name: string; size: string; qty_on_hand: number };

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
  // Which way pieces flow: unpack a box onto the rack (folded), onto the display
  // (hanging showpieces), or put rack pieces back into the box they came out of.
  const [mode, setMode] = useState<"rack" | "display" | "return">("rack");
  const [done, setDone] = useState<{ kind: "rack"; to: "rack" | "display"; r: MoveResult } | { kind: "return"; r: ReturnResult } | null>(null);

  const scanState = useRef<Map<string, { lastSeen: number; armed: boolean }>>(new Map());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const REARM_GAP_MS = 800; // tag must leave the frame this long to count again

  // Pick by hand, for a tag that won't scan or when typing is quicker: search,
  // then a design (one name like "HS POLO" covers 16 designs), then its size.
  const [pq, setPq] = useState("");
  const [designs, setDesigns] = useState<DesignHit[] | null>(null); // null = nothing searched
  const [design, setDesign] = useState("");
  const [sizes, setSizes] = useState<SizeHit[]>([]);
  const [pick, setPick] = useState("");

  const showToast = useCallback((msg: string, tone: "ok" | "warn" = "ok") => {
    setToast({ msg, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }, []);

  // Never more of a size on the list than we own: 1 in stock moves 1. Read
  // through a ref so the async scan handler sees the list as it is now.
  const linesRef = useRef<Line[]>([]);
  linesRef.current = lines;
  const onList = (sku: string) => lines.find((l) => l.sku === sku)?.qty ?? 0;
  const noMore = (v: { qty_on_hand: number }) =>
    v.qty_on_hand <= 0 ? "None in stock" : `Only ${v.qty_on_hand} in stock — all on the list`;

  // false = refused, the size is already at its stock
  const addLine = useCallback((v: { variant_sku: string; name: string; size: string; qty_on_hand: number }) => {
    const have = linesRef.current.find((l) => l.sku === v.variant_sku)?.qty ?? 0;
    if (have >= v.qty_on_hand) return false;
    setLines((prev) => {
      const i = prev.findIndex((l) => l.sku === v.variant_sku);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: next[i].qty + 1, stock: v.qty_on_hand };
        return next;
      }
      return [...prev, { sku: v.variant_sku, name: v.name, size: v.size, qty: 1, stock: v.qty_on_hand }];
    });
    setDone(null);
    return true;
  }, []);

  useEffect(() => {
    setDesign("");
    const q = pq.trim();
    if (q.length < 2) { setDesigns(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/variants?by=style&q=${encodeURIComponent(q)}`);
        const d: DesignHit[] = res.ok ? await res.json() : [];
        if (!live) return;
        setDesigns(d);
        if (d.length === 1) setDesign(d[0].style_code); // "AR-301" names one design
      } catch {
        if (live) setDesigns([]);
      }
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [pq]);

  useEffect(() => {
    setSizes([]);
    setPick("");
    if (!design) return;
    let live = true;
    fetch(`/api/variants?style=${encodeURIComponent(design)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: SizeHit[]) => { if (live) setSizes(d); })
      .catch(() => { if (live) showToast("No signal — pick the design again", "warn"); });
    return () => { live = false; };
  }, [design, showToast]);

  const addPicked = () => {
    const v = sizes.find((x) => x.variant_sku === pick);
    if (!v) return;
    if (!addLine(v)) {
      feedback(false);
      showToast(`${v.size}: ${noMore(v)}`, "warn");
      return;
    }
    feedback(true);
    showToast(`${v.name} · ${v.size}`);
    setPick(""); // keep the design: its next size is one tap away
  };

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
        if (!addLine(v)) {
          feedback(false);
          showToast(`${v.name} · ${v.size}: ${noMore(v)}`, "warn");
          return;
        }
        feedback(true);
        showToast(`${v.name} · ${v.size}`);
      } catch {
        feedback(false);
        showToast("Network error — not counted, scan again", "warn");
      }
    },
    [showToast, addLine]
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
      prev.flatMap((l) =>
        l.sku !== sku ? [l] : l.qty + d <= 0 ? [] : [{ ...l, qty: Math.min(l.qty + d, l.stock) }]
      )
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
          action: mode === "return" ? "return" : mode === "display" ? "display" : "move",
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        feedback(false);
        showToast(d.message || "Could not move — try again", "warn");
        return; // keep the list so staff can retry on a flaky hotspot
      }
      feedback(true);
      setDone(mode === "return" ? { kind: "return", r: d } : { kind: "rack", to: mode as "rack" | "display", r: d });
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
        <h1 className="text-lg font-bold text-brand">Move pieces</h1>
        <Link href="/find" className="text-sm text-slate-500">Find</Link>
      </header>

      {/* which way the pieces flow */}
      <div className="grid grid-cols-3 gap-2">
        {([["rack", "🧺 To Rack"], ["display", "👕 To Display"], ["return", "↩ To carton"]] as const).map(([m, label]) => (
          <button
            key={m}
            onClick={() => { setMode(m); setDone(null); }}
            className={`rounded-xl border px-2 py-2.5 text-sm font-semibold ${mode === m ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="rounded-xl bg-slate-100 p-3 text-xs leading-relaxed text-slate-500">
        {mode === "rack" ? (
          <>Unpacking a box onto the rack? Scan every piece, then <b>Move to Rack</b> (folded stock).
          Only changes <b>where</b> a piece is — never stock.</>
        ) : mode === "display" ? (
          <>Hanging pieces on display? Scan them, then <b>Move to Display</b> — they become the
          showpieces. Location only; stock never changes.</>
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

      {/* pick by hand — no camera needed */}
      <section className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Or pick by hand</p>
        <input
          value={pq}
          onChange={(e) => setPq(e.target.value)}
          placeholder="Type a product or code — lio linen, AR-301…"
          className="rounded-xl border border-slate-300 px-4 py-2.5 text-base outline-none focus:border-brand"
        />
        {designs !== null &&
          (designs.length === 0 ? (
            <p className="px-1 text-xs text-slate-400">Nothing matches “{pq.trim()}”.</p>
          ) : (
            <select
              value={design}
              onChange={(e) => setDesign(e.target.value)}
              className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base outline-none focus:border-brand"
            >
              <option value="">Pick the design ({designs.length} found)…</option>
              {designs.map((d) => (
                <option key={d.style_code} value={d.style_code}>
                  {d.name} · {d.style_code}{d.color ? ` · ${oneWordColour(d.color)}` : ""} ({d.qty_on_hand} pcs)
                </option>
              ))}
            </select>
          ))}
        {design && (
          <div className="flex gap-2">
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              disabled={sizes.length === 0}
              className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base outline-none focus:border-brand disabled:opacity-50"
            >
              <option value="">{sizes.length ? "Pick the size…" : "Loading sizes…"}</option>
              {sizes.map((x) => (
                <option key={x.variant_sku} value={x.variant_sku} disabled={onList(x.variant_sku) >= x.qty_on_hand}>
                  {x.size} · {x.qty_on_hand} in stock
                  {onList(x.variant_sku) > 0 ? ` · ${onList(x.variant_sku)} on list` : ""}
                </option>
              ))}
            </select>
            <button onClick={addPicked} disabled={!pick} className="btn btn-primary shrink-0 px-5 disabled:opacity-40">
              ＋ Add
            </button>
          </div>
        )}
      </section>

      {done && done.kind === "rack" && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
          ✅ Moved <b>{done.r.moved}</b> piece{done.r.moved === 1 ? "" : "s"} to the {done.to === "display" ? "display" : "rack"}
          {done.r.from_cartons > 0 && <> · {done.r.from_cartons} taken out of carton(s)</>}
          {done.r.capped > 0 && (
            <p className="mt-1 text-amber-800">
              ⚠ {done.r.capped} skipped — that would put more on the {done.to === "display" ? "display" : "rack"} than we own
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
            Scan a tag, or pick a piece by hand above.
          </p>
        ) : (
          lines.map((l) => (
            <div key={l.sku} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{l.name}</span>
                <span className="text-xs text-slate-400">
                  {l.size} · {l.sku} · {l.qty >= l.stock ? <b className="text-amber-700">all {l.stock} in stock</b> : `${l.stock} in stock`}
                </span>
              </span>
              <button onClick={() => bump(l.sku, -1)} className="h-10 w-10 rounded-xl border border-slate-300 text-xl font-bold active:bg-slate-100">−</button>
              <span className="w-8 text-center text-lg font-semibold tabular-nums">{l.qty}</span>
              <button onClick={() => bump(l.sku, 1)} disabled={l.qty >= l.stock} aria-label="One more" className="h-10 w-10 rounded-xl border border-slate-300 text-xl font-bold active:bg-slate-100 disabled:opacity-30">+</button>
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
            {busy ? "Moving…" : mode === "return" ? `↩ Return ${total} to carton` : mode === "display" ? `👕 Move ${total} to Display` : `🧺 Move ${total} to Rack`}
          </button>
          <button onClick={() => { setLines([]); scanState.current.clear(); }} className="mt-2 w-full text-xs text-slate-400 underline">
            Clear list
          </button>
        </div>
      )}
    </main>
  );
}
