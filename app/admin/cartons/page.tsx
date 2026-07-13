"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

const IMS_BASE = "https://ims.vhagar.co"; // carton pages live on the IMS

type PackedCarton = {
  carton_id: string;
  label: string | null;
  location: string | null;
  pieces: number;
  products: { name: string; total: number; sizes: string }[];
};

// Bulk-print carton QR labels (QR opens the IMS carton page; label lists the
// contents). Cartons are packed/edited on the IMS → Cartons screen.
export default function CartonLabelsPage() {
  const [list, setList] = useState<PackedCarton[]>([]);
  const [selIds, setSelIds] = useState<Set<string>>(new Set());
  const [qrs, setQrs] = useState<{ id: string; url: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/cartons", { cache: "no-store" });
        const d = res.ok ? await res.json() : { cartons: [] };
        const packed: PackedCarton[] = (d.cartons || []).filter((c: PackedCarton) => c.pieces > 0);
        setList(packed);
        setSelIds(new Set(packed.map((c) => c.carton_id)));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const QRCode = (await import("qrcode")).default;
      const out: { id: string; url: string }[] = [];
      for (const c of list) {
        if (!selIds.has(c.carton_id)) continue;
        out.push({
          id: c.carton_id,
          url: await QRCode.toDataURL(`${IMS_BASE}/cartons/${c.carton_id}`, { margin: 2, width: 240, errorCorrectionLevel: "M" }),
        });
      }
      setQrs(out);
    } finally {
      setGenerating(false);
    }
  }, [list, selIds]);

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4">
      <header className="no-print flex items-center justify-between">
        <Link href="/admin" className="text-sm font-medium text-brand">← Admin</Link>
        <h1 className="text-lg font-bold text-brand">Carton QR Labels</h1>
        <span className="w-12" />
      </header>

      <div className="no-print rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Pick cartons to print — the label shows the QR + what&apos;s inside
        </p>
        {loading ? (
          <p className="py-6 text-center text-sm text-slate-400">Loading cartons…</p>
        ) : list.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            No packed cartons yet — pack them on the IMS (Cartons → Pack a carton).
          </p>
        ) : (
          <>
            <label className="mt-2 flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={selIds.size === list.length}
                onChange={(e) => setSelIds(e.target.checked ? new Set(list.map((c) => c.carton_id)) : new Set())}
              />
              Select all ({list.length})
            </label>
            <ul className="mt-1 max-h-64 divide-y divide-slate-100 overflow-auto">
              {list.map((c) => (
                <li key={c.carton_id}>
                  <label className="flex items-center gap-2 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selIds.has(c.carton_id)}
                      onChange={(e) =>
                        setSelIds((prev) => {
                          const n = new Set(prev);
                          if (e.target.checked) n.add(c.carton_id);
                          else n.delete(c.carton_id);
                          return n;
                        })
                      }
                    />
                    <span className="font-semibold">{c.carton_id}</span>
                    <span className="text-xs text-slate-400">
                      {c.pieces} pcs · {c.products.length} product{c.products.length === 1 ? "" : "s"}
                      {c.location ? ` · ${c.location}` : ""}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="mt-3 flex gap-2">
          <button onClick={generate} disabled={selIds.size === 0 || generating} className="btn btn-ghost flex-1 disabled:opacity-50">
            {generating ? "Generating…" : "Generate"}
          </button>
          <button onClick={() => window.print()} disabled={qrs.length === 0} className="btn btn-primary flex-1 disabled:opacity-50">
            🖨 Print
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Scanning a label with any phone camera opens that carton&apos;s contents page.
        </p>
      </div>

      {qrs.length > 0 && (
        <div className="print-area grid grid-cols-2 gap-3">
          {qrs.map((l) => {
            const c = list.find((p) => p.carton_id === l.id);
            if (!c) return null;
            return (
              <div key={l.id} className="break-inside-avoid rounded-lg border border-slate-300 p-2.5">
                <div className="flex items-center gap-2.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={l.url} alt={l.id} className="w-20 shrink-0" style={{ imageRendering: "pixelated" }} />
                  <div className="min-w-0">
                    <p className="text-lg font-extrabold leading-tight">{l.id}</p>
                    {c.location && <p className="text-xs text-slate-600">{c.location}</p>}
                    <p className="text-xs text-slate-600">{c.pieces} pcs</p>
                  </div>
                </div>
                <ul className="mt-1.5 border-t border-slate-200 pt-1.5 text-[11px] leading-snug">
                  {c.products.map((p) => (
                    <li key={p.name} className="flex justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">{p.name}</span>
                      <span className="shrink-0 text-slate-600">×{p.total} ({p.sizes})</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
