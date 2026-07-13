"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

// Reuse the exact scanner from /sell (camera, client-only).
const Scanner = dynamic(() => import("../sell/Scanner"), { ssr: false });

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"];
const sizeRank = (s: string) => {
  const i = SIZE_ORDER.indexOf((s || "").toUpperCase());
  return i < 0 ? 99 : i;
};
const isCarton = (s: string) => /^CTN[-]?\d/i.test(s.trim());
const norm = (s: string) => s.trim().toUpperCase();

// Beep + buzz — copied from /sell so staff get eyes-free feedback.
function feedback(ok: boolean) {
  try { navigator.vibrate?.(ok ? 30 : [40, 40, 40]); } catch {}
  try {
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!Ctx) return;
    const ac = new Ctx();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.frequency.value = ok ? 880 : 220;
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.16);
    o.start(); o.stop(ac.currentTime + 0.17);
    o.onended = () => ac.close();
  } catch {}
}

type Mode = "find" | "carton" | "pack" | "labels";
type Carton = { carton_id: string; label: string | null; location: string | null; qty: number };
type FindSize = { variant_sku: string; size: string; qty_on_hand: number; cartons: Carton[] };
type FindData = { target_sku: string; style_code: string; name: string; sizes: FindSize[] };
type CartonData = {
  carton: { carton_id: string; label: string | null; location: string | null; note: string | null };
  items: { variant_sku: string; name: string; size: string; qty: number; qty_on_hand: number }[];
};

const MODES: [Mode, string, string][] = [
  ["find", "🔎", "Find"],
  ["carton", "📦", "Carton"],
  ["pack", "➕", "Pack"],
  ["labels", "🖨", "Labels"],
];

export default function CartonsPage() {
  const [mode, setMode] = useState<Mode>("find");
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "warn" } | null>(null);

  const [q, setQ] = useState("");
  const [findData, setFindData] = useState<FindData | null>(null);
  const [selSize, setSelSize] = useState<string | null>(null);

  const [cartonInput, setCartonInput] = useState("");
  const [cartonData, setCartonData] = useState<CartonData | null>(null);

  const [packCarton, setPackCarton] = useState("");
  const [packLoc, setPackLoc] = useState("");
  const [tally, setTally] = useState<{ sku: string; name: string; size: string; n: number }[]>([]);

  const [labStart, setLabStart] = useState(1);
  const [labCount, setLabCount] = useState(12);
  const [labQrs, setLabQrs] = useState<{ id: string; url: string }[]>([]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, tone: "ok" | "warn" = "ok") => {
    setToast({ msg, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // one-add-per-tag-presentation dedupe (copied from /sell)
  const scanState = useRef<Map<string, { lastSeen: number; armed: boolean }>>(new Map());
  const REARM = 800;

  const doFind = useCallback(async (sku: string) => {
    try {
      const res = await fetch(`/api/cartons/find?sku=${encodeURIComponent(norm(sku))}`);
      if (res.status === 404) { feedback(false); showToast(`Unknown tag: ${norm(sku)}`, "warn"); return; }
      if (!res.ok) throw new Error();
      const d: FindData = await res.json();
      d.sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
      setFindData(d);
      setSelSize(d.sizes.find((s) => s.variant_sku === d.target_sku)?.size ?? d.sizes[0]?.size ?? null);
      feedback(true);
    } catch { feedback(false); showToast("Network error", "warn"); }
  }, [showToast]);

  const doCarton = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/cartons/${encodeURIComponent(norm(id))}`);
      if (res.status === 404) { feedback(false); setCartonData(null); showToast(`${norm(id)} not indexed yet`, "warn"); return; }
      if (!res.ok) throw new Error();
      setCartonData(await res.json()); feedback(true);
    } catch { feedback(false); showToast("Network error", "warn"); }
  }, [showToast]);

  const packOne = useCallback(async (sku: string) => {
    const carton = norm(packCarton);
    if (!carton) { feedback(false); showToast("Scan a carton first", "warn"); return; }
    try {
      const res = await fetch("/api/cartons", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ carton, items: [{ sku, qty: 1 }], mode: "add", location: packLoc.trim() || undefined }),
      });
      if (!res.ok) throw new Error();
      let name = norm(sku), size = "";
      try { const v = await (await fetch(`/api/variants/${encodeURIComponent(norm(sku))}`)).json(); if (v?.name) { name = v.name; size = v.size; } } catch {}
      setTally((prev) => {
        const i = prev.findIndex((t) => t.sku === norm(sku));
        if (i >= 0) { const n = [...prev]; n[i] = { ...n[i], n: n[i].n + 1 }; return n; }
        return [{ sku: norm(sku), name, size, n: 1 }, ...prev];
      });
      feedback(true); showToast(`+1 ${name} ${size}`, "ok");
    } catch { feedback(false); showToast("Not saved — rescan", "warn"); }
  }, [packCarton, packLoc, showToast]);

  const undoPack = useCallback(async (sku: string) => {
    const carton = norm(packCarton); if (!carton) return;
    try {
      await fetch("/api/cartons", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ carton, items: [{ sku, qty: -1 }], mode: "add" }),
      });
    } catch {}
    setTally((prev) => prev.map((t) => (t.sku === sku ? { ...t, n: t.n - 1 } : t)).filter((t) => t.n > 0));
  }, [packCarton]);

  // unified scan dispatch
  const onScan = useCallback((text: string) => {
    const code = text.trim(); if (!code) return;
    const now = Date.now();
    const st = scanState.current.get(code) || { lastSeen: 0, armed: true };
    if (now - st.lastSeen > REARM) st.armed = true;
    st.lastSeen = now;
    if (!st.armed) { scanState.current.set(code, st); return; }
    st.armed = false; scanState.current.set(code, st);

    const carton = isCarton(code);
    if (mode === "pack") {
      if (carton) { setPackCarton(norm(code)); setTally([]); feedback(true); showToast(`Packing ${norm(code)}`, "ok"); }
      else packOne(code);
      return;
    }
    if (carton) { setMode("carton"); setCartonInput(norm(code)); doCarton(code); return; }
    if (mode === "carton") { feedback(false); showToast("That's a garment — use Find", "warn"); return; }
    doFind(code);
  }, [mode, doFind, doCarton, packOne, showToast]);

  // manual search (find mode) — first hit resolves the style
  useEffect(() => {
    if (mode !== "find") return;
    const s = q.trim(); if (s.length < 2) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/variants?q=${encodeURIComponent(s)}`);
        const arr = res.ok ? await res.json() : [];
        if (arr[0]) doFind(arr[0].variant_sku);
      } catch {}
    }, 350);
    return () => clearTimeout(t);
  }, [q, mode, doFind]);

  const genLabels = useCallback(async () => {
    const QRCode = (await import("qrcode")).default;
    const out: { id: string; url: string }[] = [];
    const n = Math.max(1, Math.min(200, Math.trunc(labCount) || 1));
    for (let i = 0; i < n; i++) {
      const id = `CTN-${String(Math.trunc(labStart) + i).padStart(4, "0")}`;
      out.push({ id, url: await QRCode.toDataURL(id, { margin: 2, width: 240, errorCorrectionLevel: "M" }) });
    }
    setLabQrs(out);
  }, [labStart, labCount]);

  const sel = findData?.sizes.find((s) => s.size === selSize) || null;

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4">
      <header className="flex items-center justify-between no-print">
        <Link href="/" className="text-sm font-medium text-brand">← Home</Link>
        <h1 className="text-lg font-bold text-brand">Cartons</h1>
        <span className="w-12" />
      </header>

      {/* mode switch */}
      <div className="grid grid-cols-4 gap-2 no-print">
        {MODES.map(([m, emoji, label]) => (
          <button
            key={m}
            onClick={() => { setMode(m); setScanning(false); }}
            className={`rounded-xl border px-2 py-2 text-sm font-medium ${mode === m ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}
          >
            {emoji} {label}
          </button>
        ))}
      </div>

      {/* scanner (find/carton/pack) */}
      {mode !== "labels" && (
        <section className="no-print">
          {scanning ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
              <Scanner onScan={onScan} />
              <button onClick={() => setScanning(false)} className="btn btn-ghost mt-3 w-full">⏹ Stop camera</button>
            </div>
          ) : (
            <button onClick={() => setScanning(true)} className="btn btn-primary w-full py-5 text-lg">📷 Start camera</button>
          )}
        </section>
      )}

      {/* ---------------- FIND ---------------- */}
      {mode === "find" && (
        <section className="flex flex-col gap-3 no-print">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Scan a sample, or search name / SKU"
            className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-brand"
          />
          {!findData ? (
            <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
              Scan the displayed piece (or search) to see which carton holds each size.
            </p>
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="font-semibold">{findData.name}</p>
              <p className="text-xs text-slate-400">{findData.style_code}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {findData.sizes.map((s) => {
                  const boxes = s.cartons.length;
                  return (
                    <button
                      key={s.variant_sku}
                      onClick={() => setSelSize(s.size)}
                      className={`rounded-xl border px-3 py-2 text-sm font-semibold ${selSize === s.size ? "border-brand bg-brand text-white" : boxes ? "border-slate-300 bg-white" : "border-slate-200 bg-slate-50 text-slate-400"}`}
                    >
                      {s.size}
                      <span className={`ml-1.5 text-xs font-normal ${selSize === s.size ? "text-white/80" : "text-slate-400"}`}>
                        {boxes ? `${boxes} box${boxes > 1 ? "es" : ""}` : "—"}
                      </span>
                    </button>
                  );
                })}
              </div>
              {sel && (
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <p className="text-xs text-slate-400">
                    {sel.size} · {sel.qty_on_hand} in stock total
                  </p>
                  {sel.cartons.length === 0 ? (
                    <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                      Not indexed to a carton — check the main stock pile.
                    </p>
                  ) : (
                    <ul className="mt-2 flex flex-col gap-2">
                      {sel.cartons.map((c) => (
                        <li key={c.carton_id} className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                          <span>
                            <span className="block text-base font-bold text-brand">{c.carton_id}</span>
                            {c.location && <span className="block text-xs text-slate-500">{c.location}</span>}
                          </span>
                          <span className="text-lg font-bold tabular-nums">{c.qty} pcs</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ---------------- CARTON LOOKUP ---------------- */}
      {mode === "carton" && (
        <section className="flex flex-col gap-3 no-print">
          <div className="flex gap-2">
            <input
              value={cartonInput}
              onChange={(e) => setCartonInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && cartonInput.trim() && doCarton(cartonInput)}
              placeholder="Scan or type a carton (CTN-0001)"
              className="flex-1 rounded-xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-brand"
            />
            <button onClick={() => cartonInput.trim() && doCarton(cartonInput)} className="btn btn-primary px-5">Go</button>
          </div>
          {cartonData && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="text-lg font-bold text-brand">{cartonData.carton.carton_id}</p>
                {cartonData.carton.location && <p className="text-sm text-slate-500">{cartonData.carton.location}</p>}
              </div>
              {cartonData.items.length === 0 ? (
                <p className="mt-3 text-sm text-slate-400">No pieces indexed yet. Use Pack to add.</p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100">
                  {cartonData.items.map((it) => (
                    <li key={it.variant_sku} className="flex items-center justify-between py-2 text-sm">
                      <span>
                        <span className="block font-medium">{it.name} · {it.size}</span>
                        <span className="text-xs text-slate-400">{it.variant_sku} · {it.qty_on_hand} in stock</span>
                      </span>
                      <span className="text-base font-bold tabular-nums">{it.qty}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {/* ---------------- PACK ---------------- */}
      {mode === "pack" && (
        <section className="flex flex-col gap-3 no-print">
          <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex gap-2">
              <input
                value={packCarton}
                onChange={(e) => setPackCarton(norm(e.target.value))}
                placeholder="Scan/type the carton (CTN-0001)"
                className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-base outline-none focus:border-brand"
              />
            </div>
            {packCarton && (
              <input
                value={packLoc}
                onChange={(e) => setPackLoc(e.target.value)}
                placeholder="Location (optional, e.g. Rack A)"
                className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-2 text-sm outline-none focus:border-brand"
              />
            )}
          </div>

          {!packCarton ? (
            <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
              Scan a carton QR to start packing, then scan each piece going in.
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-500">
                Packing <span className="font-bold text-brand">{packCarton}</span> — scan pieces in.
              </p>
              {tally.length === 0 ? (
                <p className="text-center text-sm text-slate-400">No pieces yet this session.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {tally.map((t) => (
                    <li key={t.sku} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{t.name} · {t.size}</span>
                        <span className="text-xs text-slate-400">{t.sku}</span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="text-lg font-bold tabular-nums">×{t.n}</span>
                        <button onClick={() => undoPack(t.sku)} className="rounded-lg border border-slate-300 px-3 py-1 text-sm active:bg-slate-100">−1</button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      {/* ---------------- LABELS (print carton QRs) ---------------- */}
      {mode === "labels" && (
        <section className="flex flex-col gap-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm no-print">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Print carton QR labels</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs text-slate-500">Start #
                <input type="number" value={labStart} min={1} onChange={(e) => setLabStart(Math.max(1, Number(e.target.value)))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand" />
              </label>
              <label className="text-xs text-slate-500">Count
                <input type="number" value={labCount} min={1} max={200} onChange={(e) => setLabCount(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand" />
              </label>
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={genLabels} className="btn btn-ghost flex-1">Generate</button>
              <button onClick={() => window.print()} disabled={labQrs.length === 0} className="btn btn-primary flex-1 disabled:opacity-50">🖨 Print</button>
            </div>
            <p className="mt-2 text-xs text-slate-400">Stick these on the boxes. A box registers itself the first time you pack into it.</p>
          </div>

          {labQrs.length > 0 && (
            <div className="print-area grid grid-cols-3 gap-3">
              {labQrs.map((l) => (
                <div key={l.id} className="flex break-inside-avoid flex-col items-center rounded-lg border border-slate-200 p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={l.url} alt={l.id} className="w-full" style={{ imageRendering: "pixelated" }} />
                  <span className="mt-1 text-sm font-bold">{l.id}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {toast && (
        <div className={`fixed left-1/2 top-4 z-40 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-medium shadow-lg no-print ${toast.tone === "ok" ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}`}>
          {toast.msg}
        </div>
      )}
    </main>
  );
}
