"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Row = {
  carton_id: string;
  location: string | null;
  variant_sku: string;
  name: string;
  size: string;
  qty: number;
};

// Find which carton holds a product: type a name/SKU → carton per size.
// (The index updates itself: packing adds, selling deducts, edits correct.)
export default function FindPage() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setRows([]);
      setSearched(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/cartons/find?q=${encodeURIComponent(query)}`);
        const d = res.ok ? await res.json() : { results: [] };
        setRows(d.results || []);
        setSearched(true);
      } catch {
        setRows([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  // group by product name → its size/carton rows
  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      const arr = m.get(r.name) || [];
      arr.push(r);
      m.set(r.name, arr);
    }
    return Array.from(m.entries());
  }, [rows]);

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-sm font-medium text-brand">← Home</Link>
        <h1 className="text-lg font-bold text-brand">Find in Cartons</h1>
        <span className="w-12" />
      </header>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search product name or SKU (e.g. lio linen)"
        autoFocus
        className="rounded-2xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-brand"
      />
      {searching && <p className="text-center text-xs text-slate-400">Searching…</p>}

      {groups.map(([name, list]) => (
        <div key={name} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <p className="font-semibold">{name}</p>
          <ul className="mt-1 divide-y divide-slate-100">
            {list.map((r) => (
              <li key={`${r.carton_id}-${r.variant_sku}`} className="flex items-center gap-3 py-2 text-sm">
                <span className="w-10 shrink-0 rounded-lg bg-slate-100 px-2 py-1 text-center font-semibold">{r.size}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-brand">{r.carton_id}</span>
                  {r.location && <span className="block text-xs text-slate-400">📍 {r.location}</span>}
                </span>
                <span className="shrink-0 font-semibold tabular-nums">×{r.qty}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {searched && !searching && rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
          Not in any carton — check the display racks or main stock.
        </p>
      )}
      {!searched && !searching && (
        <p className="rounded-xl bg-slate-100 p-3 text-xs leading-relaxed text-slate-500">
          Type a product name to see which box holds each size. Selling from the POS
          automatically deducts pieces from their carton.
        </p>
      )}
    </main>
  );
}
