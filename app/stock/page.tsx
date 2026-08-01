"use client";

import { createElement, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { money } from "@/lib/format";
import { matchesType, type ProductType } from "@/lib/product-type";

type StockRow = {
  variant_sku: string;
  style_code: string;
  name: string;
  color: string | null;
  size: string;
  price: number;
  needs_price: boolean;
  qty_on_hand: number;
  category: string | null;
};

type Group = {
  style_code: string;
  name: string;
  color: string | null;
  category: string | null;
  rows: StockRow[];
  total: number;
};

// Live company-wide stock (all channels) from the IMS, keyed by canonical style_code.
type ImsStyle = {
  name: string;
  in_hand: number;
  sizes: Record<string, number>;
  image_url: string | null;
};

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"];
const sizeRank = (s: string) => {
  const i = SIZE_ORDER.indexOf(s.toUpperCase());
  return i === -1 ? 99 : i;
};

const REFRESH_MS = 5000;        // Neon booth stock poll
const IMS_REFRESH_MS = 20000;   // IMS live (all-channels) stock poll — GAS caches 45s

export default function StockPage() {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [query, setQuery] = useState("");
  const [typeFil, setTypeFil] = useState<"all" | ProductType>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [ims, setIms] = useState<Record<string, ImsStyle>>({});
  // optional per-style 3D model URLs (public/models.json: { style_code: "<glb url>" })
  const [models, setModels] = useState<Record<string, string>>({});
  const [viewer, setViewer] = useState<{ name: string; imageUrl?: string; modelUrl?: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/stock", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setRows(await res.json());
      setError(false);
      setUpdatedAt(Date.now());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  // poll, but pause when the tab is hidden (save the 4G hotspot)
  useEffect(() => {
    load();
    const start = () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(load, REFRESH_MS);
    };
    const onVis = () => {
      if (document.hidden) {
        if (timer.current) clearInterval(timer.current);
      } else {
        load();
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer.current) clearInterval(timer.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // live company-wide stock + photos from the IMS (once configured); harmless {} until then.
  // Polled slower than booth stock (IMS is a reference + GAS caches 45s); pauses when tab hidden.
  useEffect(() => {
    const loadIms = () =>
      fetch("/api/ims", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.styles && setIms(d.styles))
        .catch(() => {});
    loadIms();
    const id = setInterval(() => {
      if (!document.hidden) loadIms();
    }, IMS_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // optional 3D models map (empty until you add .glb URLs to public/models.json)
  useEffect(() => {
    fetch("/models.json")
      .then((r) => (r.ok ? r.json() : {}))
      .then((m) => setModels(m || {}))
      .catch(() => {});
  }, []);

  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter(
      (r) =>
        matchesType(typeFil, r.category) &&
        (!q ||
          r.name.toLowerCase().includes(q) ||
          r.variant_sku.toLowerCase().includes(q) ||
          r.style_code.toLowerCase().includes(q) ||
          (r.category || "").toLowerCase().includes(q))
    );

    const map = new Map<string, Group>();
    for (const r of filtered) {
      let g = map.get(r.style_code);
      if (!g) {
        g = {
          style_code: r.style_code,
          name: r.name,
          color: r.color,
          category: r.category,
          rows: [],
          total: 0,
        };
        map.set(r.style_code, g);
      }
      g.rows.push(r);
      g.total += r.qty_on_hand;
    }
    const arr = Array.from(map.values());
    arr.forEach((g) => g.rows.sort((a, b) => sizeRank(a.size) - sizeRank(b.size)));
    arr.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }, [rows, query, typeFil]);

  const totals = useMemo(() => {
    const pieces = rows.reduce((s, r) => s + r.qty_on_hand, 0);
    const low = rows.filter((r) => r.qty_on_hand > 0 && r.qty_on_hand <= 1).length;
    const out = rows.filter((r) => r.qty_on_hand <= 0).length;
    return { pieces, low, out };
  }, [rows]);

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-sm font-medium text-brand">
          ← Home
        </Link>
        <h1 className="text-lg font-bold text-brand">Live Stock</h1>
        <Link href="/sell" className="text-sm text-slate-500">
          Sell
        </Link>
      </header>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {totals.pieces} pieces · {groups.length} styles
          {totals.low > 0 && <span className="text-amber-600"> · {totals.low} low</span>}
          {totals.out > 0 && <span className="text-rose-600"> · {totals.out} out</span>}
        </span>
        <span className={error ? "text-rose-500" : "text-emerald-600"}>
          {error ? "⚠ offline — retrying" : updatedAt ? "● live" : "…"}
        </span>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search style, SKU, category…"
        className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-brand"
      />

      <div className="grid grid-cols-3 gap-2">
        {([["all", "All"], ["shirt", "Shirts"], ["tshirt", "T-shirts"]] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setTypeFil(v)}
            className={`rounded-xl border px-2 py-2 text-sm font-medium ${typeFil === v ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="py-10 text-center text-sm text-slate-400">Loading stock…</p>
      ) : groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">No matches.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => {
            const im = ims[g.style_code]; // keyed by canonical code; matches Neon style_code
            // IMS (all channels) below the booth count => online has sold some; warn.
            const imsLow = im != null && im.in_hand < g.total;
            return (
            <div
              key={g.style_code}
              className={`rounded-2xl border bg-white p-3 shadow-sm ${
                g.total <= 0 ? "border-slate-200 opacity-60" : "border-slate-200"
              }`}
            >
              <div className="mb-2 flex items-start gap-3">
                <Thumb
                  url={im?.image_url ?? undefined}
                  name={g.name}
                  modelUrl={models[g.style_code]}
                  onOpen={() =>
                    setViewer({ name: g.name, imageUrl: im?.image_url ?? undefined, modelUrl: models[g.style_code] })
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{g.name}</p>
                  <p className="text-xs text-slate-400">
                    {g.style_code}
                    {g.color ? ` · ${g.color}` : ""}
                    {g.category ? ` · ${g.category}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="text-xs text-slate-500">
                    <span className="font-semibold text-slate-700">{g.total}</span> booth
                  </span>
                  {im && (
                    <span
                      title={`Live company stock, all channels (S ${im.sizes.S} · M ${im.sizes.M} · L ${im.sizes.L} · XL ${im.sizes.XL} · 2XL ${im.sizes["2XL"]} · 3XL ${im.sizes["3XL"]})`}
                      className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                        imsLow ? "bg-amber-100 text-amber-800" : "bg-sky-50 text-sky-700"
                      }`}
                    >
                      {imsLow ? "⚠ " : ""}{im.in_hand} live
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.rows.map((r) => {
                  const out = r.qty_on_hand <= 0;
                  const low = r.qty_on_hand > 0 && r.qty_on_hand <= 1;
                  return (
                    <span
                      key={r.variant_sku}
                      title={r.needs_price ? "needs price" : money(r.price)}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-sm font-medium ${
                        out
                          ? "border-slate-200 bg-slate-100 text-slate-400 line-through"
                          : low
                          ? "border-amber-300 bg-amber-50 text-amber-800"
                          : "border-slate-200 bg-slate-50 text-slate-700"
                      }`}
                    >
                      {r.size}
                      <span className={`tabular-nums ${out ? "" : "font-bold"}`}>
                        {r.qty_on_hand}
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
            );
          })}
        </div>
      )}

      <p className="pb-6 pt-2 text-center text-xs text-slate-400">
        Auto-refreshes every {REFRESH_MS / 1000}s · amber chip = low (≤1) · grey = out ·{" "}
        <span className="text-slate-500">booth</span> = sellable here ·{" "}
        <span className="text-sky-700">live</span> = company stock (all channels);{" "}
        <span className="text-amber-700">⚠ live &lt; booth</span> = online has sold some
      </p>

      {viewer && <Viewer item={viewer} onClose={() => setViewer(null)} />}
    </main>
  );
}

// Full-screen viewer: interactive 3D model when the style has a .glb, else a large photo.
function Viewer({
  item,
  onClose,
}: {
  item: { name: string; imageUrl?: string; modelUrl?: string };
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    // lazy-load Google's <model-viewer> only when a 3D model is shown
    if (item.modelUrl && !customElements.get("model-viewer")) {
      const s = document.createElement("script");
      s.type = "module";
      s.src = "https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js";
      document.head.appendChild(s);
    }
    return () => document.removeEventListener("keydown", onKey);
  }, [item.modelUrl, onClose]);

  const bigImg = item.imageUrl ? item.imageUrl.replace(/=s\d+$/, "=s1200") : undefined;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-4"
    >
      <button onClick={onClose} className="absolute right-4 top-3 text-4xl leading-none text-white/80">
        ×
      </button>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl">
        {item.modelUrl
          ? createElement("model-viewer" as any, {
              src: item.modelUrl,
              "camera-controls": "",
              "auto-rotate": "",
              ar: "",
              "shadow-intensity": "1",
              style: { width: "100%", height: "72vh", background: "#111", borderRadius: "14px" },
            })
          : bigImg ? (
              <div className="max-h-[82vh] overflow-auto rounded-xl">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={bigImg}
                  alt={item.name}
                  referrerPolicy="no-referrer"
                  onClick={() => setZoom((z) => !z)}
                  className={`mx-auto w-auto rounded-xl object-contain transition-transform ${
                    zoom ? "max-h-none scale-[1.8] cursor-zoom-out" : "max-h-[82vh] cursor-zoom-in"
                  }`}
                />
              </div>
            ) : (
              <p className="text-center text-white">No image available</p>
            )}
        <p className="mt-3 text-center text-sm font-medium text-white">
          {item.name}
          {item.modelUrl ? " · 3D — drag to rotate" : bigImg ? " · tap to zoom" : ""}
        </p>
      </div>
    </div>
  );
}

// Clickable product thumbnail (opens the viewer). Letter-placeholder fallback;
// a "3D" tag when the style has a model. Image source is the IMS.
function Thumb({
  url,
  name,
  modelUrl,
  onOpen,
}: {
  url?: string;
  name: string;
  modelUrl?: string;
  onOpen?: () => void;
}) {
  const [err, setErr] = useState(false);
  const showImg = url && !err;
  const clickable = !!onOpen && (showImg || !!modelUrl);
  return (
    <button
      type="button"
      onClick={clickable ? onOpen : undefined}
      aria-label={clickable ? `View ${name}` : name}
      className={`relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-slate-200 ${
        clickable ? "cursor-zoom-in" : "cursor-default"
      }`}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={name}
          onError={() => setErr(true)}
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center bg-slate-100 text-lg font-bold text-slate-300">
          {(name || "?").charAt(0).toUpperCase()}
        </span>
      )}
      {modelUrl && (
        <span className="absolute bottom-0 right-0 bg-brand px-1 text-[8px] font-bold leading-tight text-white">
          3D
        </span>
      )}
    </button>
  );
}
