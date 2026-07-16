"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

const Scanner = dynamic(() => import("../sell/Scanner"), { ssr: false });

type Place = { carton: string; location: string | null; qty: number; isRack: boolean };
type SizeRow = { variant_sku: string; size: string; qty_on_hand: number; places: Place[] };
type Style = { scanned: string; style_code: string; name: string; sizes: SizeRow[] };
type Row = {
  carton_id: string; location: string | null; variant_sku: string;
  name: string; size: string; qty: number; is_rack: boolean;
};

// Where is it? Scan the hanging display piece → the whole style, per size,
// and whether each size is on the Rack or still boxed.
export default function FindPage() {
  const [scanning, setScanning] = useState(false);
  const [style, setStyle] = useState<Style | null>(null);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lastScan = useRef<{ code: string; at: number }>({ code: "", at: 0 });

  const lookupSku = useCallback(async (raw: string) => {
    const sku = raw.trim().toUpperCase();
    if (!sku) return;
    setErr(null);
    try {
      const res = await fetch(`/api/cartons/find?sku=${encodeURIComponent(sku)}`);
      if (res.status === 404) { setStyle(null); setErr(`Unknown tag: ${sku}`); return; }
      if (!res.ok) throw new Error();
      setStyle(await res.json());
      setQ(""); setRows([]); setSearched(false);
      navigator.vibrate?.(30);
    } catch {
      setErr("Network error — try again");
    }
  }, []);

  // Find is read-only, so a re-read of the same tag just refreshes the answer;
  // a short gap is enough to stop it thrashing while the tag is held up.
  const onScan = useCallback((text: string) => {
    const code = text.trim();
    if (!code) return;
    const now = Date.now();
    if (code === lastScan.current.code && now - lastScan.current.at < 1500) return;
    lastScan.current = { code, at: now };
    if (/CTN-?\d/i.test(code)) { setErr("That's a carton label — scan a garment tag"); return; }
    lookupSku(code);
  }, [lookupSku]);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setRows([]); setSearched(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/cartons/find?q=${encodeURIComponent(query)}`);
        const d = res.ok ? await res.json() : { results: [] };
        setRows(d.results || []); setSearched(true); setStyle(null);
      } catch { setRows([]); } finally { setSearching(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) { const a = m.get(r.name) || []; a.push(r); m.set(r.name, a); }
    return Array.from(m.entries());
  }, [rows]);

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-sm font-medium text-brand">← Home</Link>
        <h1 className="text-lg font-bold text-brand">Find</h1>
        <Link href="/rack" className="text-sm text-slate-500">Rack</Link>
      </header>

      {scanning ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <Scanner onScan={onScan} />
          <button onClick={() => setScanning(false)} className="btn btn-ghost mt-3 w-full">⏹ Stop camera</button>
        </div>
      ) : (
        <button onClick={() => setScanning(true)} className="btn btn-primary w-full py-5 text-lg">
          📷 Scan the hanging piece
        </button>
      )}

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="…or search by name / SKU"
        className="rounded-2xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-brand"
      />
      {searching && <p className="text-center text-xs text-slate-400">Searching…</p>}
      {err && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{err}</p>}

      {/* ---- scanned style: every size, and where it is ---- */}
      {style && (
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <p className="text-lg font-bold text-brand">{style.name}</p>
          <p className="text-xs text-slate-400">{style.style_code} · scanned {style.scanned}</p>
          <ul className="mt-3 flex flex-col gap-2">
            {style.sizes.map((s) => {
              const out = s.qty_on_hand <= 0;
              return (
                <li
                  key={s.variant_sku}
                  className={`rounded-xl border p-2.5 ${
                    s.variant_sku === style.scanned ? "border-brand bg-brand/5" : "border-slate-200"
                  } ${out ? "opacity-60" : ""}`}
                >
                  <div className="flex items-center gap-3">
                    <span className="w-12 shrink-0 rounded-lg bg-slate-900 px-2 py-1 text-center text-sm font-bold text-white">
                      {s.size}
                    </span>
                    <span className="min-w-0 flex-1">
                      {s.places.length === 0 ? (
                        <span className="text-sm text-slate-400">
                          {out ? "Out of stock" : "Not indexed — check the stall"}
                        </span>
                      ) : (
                        s.places.map((p) => (
                          <span key={p.carton} className="block text-sm">
                            <b className="tabular-nums">{p.qty}</b>{" "}
                            {p.isRack ? (
                              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-emerald-800">
                                in Rack
                              </span>
                            ) : (
                              <>
                                in <span className="font-semibold text-brand">{p.carton}</span>
                                {p.location && <span className="text-xs text-slate-400"> · {p.location}</span>}
                              </>
                            )}
                          </span>
                        ))
                      )}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-base font-bold tabular-nums">{s.qty_on_hand}</span>
                      <span className="block text-[10px] uppercase tracking-wide text-slate-400">in stock</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ---- text search results ---- */}
      {groups.map(([name, list]) => (
        <div key={name} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <p className="font-semibold">{name}</p>
          <ul className="mt-1 divide-y divide-slate-100">
            {list.map((r) => (
              <li key={`${r.carton_id}-${r.variant_sku}`} className="flex items-center gap-3 py-2 text-sm">
                <span className="w-10 shrink-0 rounded-lg bg-slate-100 px-2 py-1 text-center font-semibold">{r.size}</span>
                <span className="min-w-0 flex-1">
                  {r.is_rack ? (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-emerald-800">
                      in Rack
                    </span>
                  ) : (
                    <>
                      <span className="block font-semibold text-brand">{r.carton_id}</span>
                      {r.location && <span className="block text-xs text-slate-400">📍 {r.location}</span>}
                    </>
                  )}
                </span>
                <span className="shrink-0 font-semibold tabular-nums">×{r.qty}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {searched && !searching && rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
          Not on the rack or in any carton — check main stock.
        </p>
      )}
      {!style && !searched && !searching && (
        <p className="rounded-xl bg-slate-100 p-3 text-xs leading-relaxed text-slate-500">
          Scan the piece hanging in the stall to see every size, how many we have,
          and whether it&apos;s on the <b>Rack</b> or still in a <b>carton</b>.
        </p>
      )}
    </main>
  );
}
