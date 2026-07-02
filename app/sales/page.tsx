"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { money, billDateTime } from "@/lib/format";

type SaleRow = {
  id: number;
  bill_no: string | null;
  subtotal: number;
  discount: number;
  total: number;
  payment_method: string;
  customer_name: string | null;
  sold_by: string | null;
  status: string;
  created_at: string;
  item_count: number;
};

const REFRESH_MS = 8000;

export default function SalesPage() {
  const [scope, setScope] = useState<"today" | "all">("today");
  const [data, setData] = useState<{ sales: SaleRow[]; grandTotal: number; count: number }>({
    sales: [],
    grandTotal: 0,
    count: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = async (s: "today" | "all") => {
    try {
      const res = await fetch(`/api/sales${s === "today" ? "?date=today" : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      setData(await res.json());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    load(scope);
    const t = setInterval(() => {
      if (!document.hidden) load(scope);
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [scope]);

  const pieces = useMemo(
    () => data.sales.reduce((n, s) => n + (s.item_count || 0), 0),
    [data.sales]
  );

  const exportHref = `/api/sales/export${scope === "today" ? "?date=today" : ""}`;

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-sm font-medium text-brand">
          ← Home
        </Link>
        <h1 className="text-lg font-bold text-brand">Sales Log</h1>
        <Link href="/sell" className="text-sm text-slate-500">
          Sell
        </Link>
      </header>

      {/* scope toggle */}
      <div className="flex gap-2">
        {(["today", "all"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={`flex-1 rounded-xl border px-4 py-2 text-sm font-medium ${
              scope === s
                ? "border-brand bg-brand text-white"
                : "border-slate-200 bg-white text-slate-600"
            }`}
          >
            {s === "today" ? "Today" : "All"}
          </button>
        ))}
      </div>

      {/* grand total card */}
      <div className="rounded-2xl border border-brand/20 bg-brand/5 p-4">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">
              {scope === "today" ? "Today's takings" : "All takings"}
            </p>
            <p className="text-3xl font-bold text-brand">{money(data.grandTotal)}</p>
          </div>
          <div className="text-right text-xs text-slate-500">
            <p>
              {data.count} bill{data.count === 1 ? "" : "s"}
            </p>
            <p>{pieces} items</p>
            <p className={error ? "text-rose-500" : "text-emerald-600"}>
              {error ? "⚠ offline" : "● live"}
            </p>
          </div>
        </div>
        <a
          href={exportHref}
          className="btn btn-ghost mt-3 w-full"
          // let the browser download the CSV
        >
          ⬇ Export CSV ({scope})
        </a>
      </div>

      {/* list */}
      {loading ? (
        <p className="py-10 text-center text-sm text-slate-400">Loading…</p>
      ) : data.sales.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          No sales {scope === "today" ? "yet today" : "recorded"}.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.sales.map((s) => (
            <li key={s.id}>
              <Link
                href={`/sale/${s.id}`}
                className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm active:bg-slate-50"
              >
                <div className="min-w-0">
                  <p className="font-semibold">{s.bill_no || `#${s.id}`}</p>
                  <p className="text-xs text-slate-400">
                    {billDateTime(s.created_at)} · {s.item_count} item
                    {s.item_count === 1 ? "" : "s"}
                    {s.sold_by ? ` · ${s.sold_by}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-bold">{money(s.total)}</p>
                  {s.discount > 0 && (
                    <p className="text-xs text-slate-400">−{money(s.discount)}</p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
