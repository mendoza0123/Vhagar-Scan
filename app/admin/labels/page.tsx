"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

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

type MediaMode = "roll" | "a4";
type QtyMode = "perPiece" | "perSku" | "custom";

const PAD_MM = 1.4; // internal padding; keeps content off the Endura edge dead-zone
const SOFT_CAP = 250; // confirm before spooling a run bigger than this

// ---- build the runtime stylesheet that maps the layout to the physical media ----
function buildPrintCss(o: {
  mediaMode: MediaMode;
  labelW: number;
  labelH: number;
  qrMM: number;
  basePt: number;
  a4Cols: number;
  a4Gap: number;
  a4Margin: number;
  showBorder: boolean;
}) {
  const { mediaMode, labelW, labelH, qrMM, basePt, a4Cols, a4Gap, a4Margin, showBorder } = o;
  // Dimensions apply on screen AND print so the preview is WYSIWYG.
  // font-size scales with the label so text fills a big tag and shrinks on a small one
  // (LabelContent text is sized in em, relative to this).
  const dims = `
.qr-label{width:${labelW}mm;height:${labelH}mm;padding:${PAD_MM}mm;font-size:${basePt}pt;border:${
    mediaMode === "a4" && showBorder ? "1px dashed #94a3b8" : "none"
  };}
.qr-label img{width:${qrMM}mm;height:${qrMM}mm;}
${mediaMode === "a4" ? `.label-grid{gap:${a4Gap}mm;grid-template-columns:repeat(${a4Cols}, ${labelW}mm);}` : ""}
`;
  const print =
    mediaMode === "roll"
      ? `@media print{
  @page{size:${labelW}mm ${labelH}mm;margin:0;}
  .qr-label:not(:last-child){break-after:page;page-break-after:always;}
}`
      : `@media print{
  @page{size:A4;margin:${a4Margin}mm;}
  .sheet:not(:last-child){break-after:page;page-break-after:always;}
}`;
  return dims + print;
}

export default function LabelsPage() {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);

  // media + label geometry
  const [mediaMode, setMediaMode] = useState<MediaMode>("roll");
  const [labelW, setLabelW] = useState(45); // matches the loaded Endura roll (45 × 90 mm)
  const [labelH, setLabelH] = useState(90);
  const [layout, setLayout] = useState<"vertical" | "horizontal">("vertical");

  // A4-only
  const [a4Cols, setA4Cols] = useState(4);
  const [a4Rows, setA4Rows] = useState(10);
  const [a4Gap, setA4Gap] = useState(3);
  const [a4Margin, setA4Margin] = useState(8);
  const [showBorder, setShowBorder] = useState(true);

  // what to print
  const [styleCode, setStyleCode] = useState("all");
  const [category, setCategory] = useState("all");
  const [qtyMode, setQtyMode] = useState<QtyMode>("perPiece");
  const [customCopies, setCustomCopies] = useState(1);
  const [sizeSel, setSizeSel] = useState<Set<string>>(new Set()); // empty = all sizes
  const [manual, setManual] = useState<Set<string>>(new Set()); // manually-ticked style_codes
  const [manualQuery, setManualQuery] = useState("");

  // QR cache (keyed by sku + pixel size so resizing regenerates)
  const [qrMap, setQrMap] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const qrCache = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/stock", { cache: "no-store" });
        setRows(await res.json());
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // QR square size in mm (derived from label geometry + chosen layout)
  const horizontal = layout === "horizontal";
  const qrMM = useMemo(() => {
    const v = horizontal
      ? Math.min(labelH - 2 * PAD_MM, labelW * 0.45)
      : Math.min(labelW - 2 * PAD_MM, labelH * 0.55);
    return Math.max(8, Math.round(v * 10) / 10); // ≥8mm, 0.1mm precision
  }, [labelW, labelH, horizontal]);
  const qrPx = Math.max(96, Math.round(qrMM * 8)); // 8 dots/mm @ 203 dpi
  // Base font scales with the label's shorter side: ~5.5pt on a 25mm tag → ~10pt on a 45mm tag.
  const basePt = Math.max(5, Math.min(16, Math.round(Math.min(labelW, labelH) * 0.22 * 10) / 10));

  const styles = useMemo(() => {
    const m = new Map<string, string>();
    rows.forEach((r) => m.set(r.style_code, r.name));
    return Array.from(m.entries())
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const categories = useMemo(
    () => Array.from(new Set(rows.map((r) => r.category).filter(Boolean) as string[])).sort(),
    [rows]
  );

  // one entry per sticker to print
  const stickers = useMemo(() => {
    const useManual = manual.size > 0;
    const filtered = rows.filter(
      (r) =>
        // per-piece needs stock (0 → 0 labels); "1 per SKU" / custom print a new
        // size's QR even at 0 stock, so you can sticker before restocking.
        (qtyMode === "perPiece" ? r.qty_on_hand > 0 : true) &&
        // manual picks override the Style/Category filters when any are ticked.
        (useManual
          ? manual.has(r.style_code)
          : (styleCode === "all" || r.style_code === styleCode) &&
            (category === "all" || r.category === category)) &&
        // size filter — active whenever exactly one style is selected (via the
        // Style dropdown OR a single manual tick)
        (sizeSel.size === 0 || sizeSel.has(r.size))
    );
    const copiesOf = (r: StockRow) =>
      qtyMode === "perPiece" ? r.qty_on_hand : qtyMode === "perSku" ? 1 : Math.max(1, customCopies);
    const out: { key: string; row: StockRow }[] = [];
    for (const r of filtered) {
      const n = copiesOf(r);
      for (let i = 0; i < n; i++) out.push({ key: `${r.variant_sku}-${i}`, row: r });
    }
    return out;
  }, [rows, styleCode, category, qtyMode, customCopies, manual, sizeSel]);

  // The size filter works when exactly ONE style is selected — either via the
  // Style dropdown, or a single tick in the manual picker.
  const effStyle = useMemo(() => {
    if (manual.size === 1) return Array.from(manual)[0];
    if (manual.size === 0 && styleCode !== "all") return styleCode;
    return null;
  }, [manual, styleCode]);

  // switching to a different (or no) single style resets the size filter
  useEffect(() => {
    setSizeSel(new Set());
  }, [effStyle]);

  // sizes available for that style (for the size-filter chips)
  const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"];
  const styleSizes = useMemo(() => {
    if (!effStyle) return [];
    const set = new Set(rows.filter((r) => r.style_code === effStyle).map((r) => r.size));
    return Array.from(set).sort((a, b) => {
      const ia = SIZE_ORDER.indexOf(a.toUpperCase()), ib = SIZE_ORDER.indexOf(b.toUpperCase());
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, effStyle]);

  const manualFiltered = useMemo(() => {
    const q = manualQuery.trim().toLowerCase();
    return q ? styles.filter((s) => `${s.name} ${s.code}`.toLowerCase().includes(q)) : styles;
  }, [manualQuery, styles]);
  const allShownSelected = manualFiltered.length > 0 && manualFiltered.every((s) => manual.has(s.code));

  const uniqueSkus = useMemo(
    () => Array.from(new Set(stickers.map((s) => s.row.variant_sku))),
    [stickers]
  );

  // generate any QR codes we don't have at the current pixel size (cached)
  useEffect(() => {
    const keyOf = (s: string) => `${s}@${qrPx}`;
    const missing = uniqueSkus.filter((s) => !qrCache.current.has(keyOf(s)));
    if (missing.length === 0) {
      setQrMap(Object.fromEntries(qrCache.current));
      return;
    }
    let cancelled = false;
    (async () => {
      setGenerating(true);
      const QRCode = (await import("qrcode")).default;
      for (const sku of missing) {
        if (cancelled) return;
        try {
          const url = await QRCode.toDataURL(sku, {
            margin: 4, // generous quiet zone for thermal fade
            width: qrPx,
            errorCorrectionLevel: "M",
            color: { dark: "#000000", light: "#FFFFFF" },
          });
          qrCache.current.set(keyOf(sku), url);
        } catch {
          /* skip */
        }
      }
      if (!cancelled) {
        setQrMap(Object.fromEntries(qrCache.current));
        setGenerating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uniqueSkus, qrPx]);

  // inject the runtime stylesheet (hydration-safe: client-only, one <style> node)
  useEffect(() => {
    let el = document.getElementById("label-print-css") as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = "label-print-css";
      document.head.appendChild(el);
    }
    el.textContent = buildPrintCss({
      mediaMode,
      labelW,
      labelH,
      qrMM,
      basePt,
      a4Cols,
      a4Gap,
      a4Margin,
      showBorder,
    });
  }, [mediaMode, labelW, labelH, qrMM, basePt, a4Cols, a4Gap, a4Margin, showBorder]);

  // remove the injected styles on unmount so they can't affect other pages (e.g. the bill)
  useEffect(() => () => document.getElementById("label-print-css")?.remove(), []);

  const qrFor = (sku: string) => qrMap[`${sku}@${qrPx}`];
  const ready = uniqueSkus.every((s) => qrFor(s));

  // A4 pagination (deterministic page breaks)
  const perPage = Math.max(1, a4Cols * a4Rows);
  const pages = useMemo(() => {
    if (mediaMode !== "a4") return [];
    const out: { key: string; row: StockRow }[][] = [];
    for (let i = 0; i < stickers.length; i += perPage) out.push(stickers.slice(i, i + perPage));
    return out;
  }, [stickers, perPage, mediaMode]);

  const widthTooWide = labelW > 108; // Endura max print width
  const sizeInvalid = labelW < 20 || labelW > 118 || labelH < 10 || labelH > 300;
  const canPrint = ready && stickers.length > 0 && !widthTooWide && !sizeInvalid && !generating;

  const doPrint = () => {
    const pageCount = mediaMode === "roll" ? stickers.length : pages.length;
    if (
      stickers.length > SOFT_CAP &&
      !window.confirm(
        `This will print ${stickers.length} labels (${pageCount} ${
          mediaMode === "roll" ? "roll labels" : "A4 pages"
        }). Continue?`
      )
    )
      return;
    window.print();
  };

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4">
      {/* ---------- controls (hidden when printing) ---------- */}
      <div className="no-print flex flex-col gap-3">
        <header className="flex items-center justify-between">
          <Link href="/admin" className="text-sm font-medium text-brand">
            ← Admin
          </Link>
          <h1 className="text-lg font-bold text-brand">QR Labels</h1>
          <span className="w-12" />
        </header>

        {/* media mode */}
        <div className="flex gap-2">
          {(
            [
              ["roll", "🧻 Roll (Endura)"],
              ["a4", "📄 A4 sheet"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMediaMode(m)}
              className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium ${
                mediaMode === m
                  ? "border-brand bg-brand text-white"
                  : "border-slate-200 bg-white text-slate-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* label size */}
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Label size (mm) — match the loaded roll
          </p>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Width" value={labelW} onChange={setLabelW} min={20} max={118} />
            <NumField label="Height" value={labelH} onChange={setLabelH} min={10} max={300} />
          </div>
          <div className="mt-2 flex gap-2">
            {(
              [
                ["vertical", "QR on top"],
                ["horizontal", "QR on left"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setLayout(v)}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${
                  layout === v
                    ? "border-brand bg-brand text-white"
                    : "border-slate-200 bg-white text-slate-600"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            QR ≈ {qrMM.toFixed(1)} mm ({qrPx}px @ 203 dpi) ·{" "}
            {horizontal ? "QR left / text right" : "QR on top / text below"}
          </p>
          {widthTooWide && (
            <p className="mt-1 text-xs font-medium text-rose-600">
              ⚠ Width exceeds the Endura 108 mm print width — narrow the label.
            </p>
          )}
          {sizeInvalid && !widthTooWide && (
            <p className="mt-1 text-xs font-medium text-rose-600">
              ⚠ Size out of range (W 20–118 mm, H 10–300 mm).
            </p>
          )}
        </div>

        {/* A4-only options */}
        {mediaMode === "a4" && (
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              A4 sheet grid
            </p>
            <div className="grid grid-cols-2 gap-2">
              <NumField label="Columns" value={a4Cols} onChange={setA4Cols} min={1} max={12} />
              <NumField label="Rows / page" value={a4Rows} onChange={setA4Rows} min={1} max={30} />
              <NumField label="Gap (mm)" value={a4Gap} onChange={setA4Gap} min={0} max={20} />
              <NumField label="Margin (mm)" value={a4Margin} onChange={setA4Margin} min={0} max={25} />
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={showBorder}
                onChange={(e) => setShowBorder(e.target.checked)}
              />
              Show dashed cut-borders
            </label>
          </div>
        )}

        {/* quantity */}
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            How many of each
          </p>
          <div className="flex gap-2">
            {(
              [
                ["perPiece", "Per piece"],
                ["perSku", "1 per SKU"],
                ["custom", "Custom"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setQtyMode(m)}
                className={`flex-1 rounded-lg border px-2 py-2 text-sm font-medium ${
                  qtyMode === m
                    ? "border-brand bg-brand text-white"
                    : "border-slate-200 bg-white text-slate-600"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {qtyMode === "custom" && (
            <div className="mt-2 w-32">
              <NumField label="Copies each" value={customCopies} onChange={setCustomCopies} min={1} max={50} />
            </div>
          )}
        </div>

        {/* filters */}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-slate-500">
            Style
            <select
              value={styleCode}
              onChange={(e) => setStyleCode(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
            >
              <option value="all">All styles</option>
              {styles.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-500">
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
            >
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* size filter — only print the sizes you need for the chosen style */}
        {effStyle && styleSizes.length > 0 && (
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Sizes to print{sizeSel.size > 0 && <span className="text-brand"> · {Array.from(sizeSel).join(", ")}</span>}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setSizeSel(new Set())}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${sizeSel.size === 0 ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}
              >
                All sizes
              </button>
              {styleSizes.map((s) => (
                <button
                  key={s}
                  onClick={() =>
                    setSizeSel((prev) => {
                      const n = new Set(prev);
                      if (n.has(s)) n.delete(s);
                      else n.add(s);
                      return n;
                    })
                  }
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${sizeSel.has(s) ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}
                >
                  {sizeSel.has(s) ? "✓ " : ""}{s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* manual multi-select — reprint specific styles the printer skipped */}
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Pick styles manually
              {manual.size > 0 && <span className="text-brand"> · {manual.size} selected</span>}
            </p>
            {manual.size > 0 && (
              <button onClick={() => setManual(new Set())} className="text-xs text-slate-400 underline">
                Clear
              </button>
            )}
          </div>
          {manual.size > 0 && (
            <p className="mt-1 text-xs text-slate-400">Manual picks are active — Style &amp; Category above are ignored.</p>
          )}
          <input
            value={manualQuery}
            onChange={(e) => setManualQuery(e.target.value)}
            placeholder="Search styles to tick (e.g. Epson, Sparrow)…"
            className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <button
            onClick={() =>
              setManual((prev) => {
                const n = new Set(prev);
                if (allShownSelected) manualFiltered.forEach((s) => n.delete(s.code));
                else manualFiltered.forEach((s) => n.add(s.code));
                return n;
              })
            }
            className="mt-2 flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm font-medium hover:bg-slate-50"
          >
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${allShownSelected ? "border-brand bg-brand text-white" : "border-slate-300"}`}>
              {allShownSelected ? "✓" : ""}
            </span>
            Select all
            <span className="ml-auto text-xs font-normal text-slate-400">{manualFiltered.length} shown</span>
          </button>
          <div className="mt-1 max-h-56 space-y-1 overflow-y-auto pr-1">
            {manualFiltered.map((s) => {
              const on = manual.has(s.code);
              return (
                <button
                  key={s.code}
                  onClick={() =>
                    setManual((prev) => {
                      const n = new Set(prev);
                      if (n.has(s.code)) n.delete(s.code);
                      else n.add(s.code);
                      return n;
                    })
                  }
                  className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${on ? "border-brand bg-brand/5" : "border-slate-200 hover:bg-slate-50"}`}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${on ? "border-brand bg-brand text-white" : "border-slate-300"}`}>
                    {on ? "✓" : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {s.name} <span className="text-xs text-slate-400">{s.code}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* count + print */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-slate-600">
            <span className="font-semibold">{stickers.length}</span> sticker
            {stickers.length === 1 ? "" : "s"}
            {mediaMode === "a4" && stickers.length > 0 && (
              <span className="text-slate-400"> · {pages.length} A4 page(s)</span>
            )}
            {mediaMode === "roll" && stickers.length > 0 && (
              <span className="text-slate-400"> · 1 label/page</span>
            )}
          </span>
          <button onClick={doPrint} disabled={!canPrint} className="btn btn-primary px-5 py-2 disabled:opacity-50">
            🖨 Print
          </button>
        </div>

        {generating && (
          <p className="text-center text-xs text-slate-400">
            Generating QR codes… ({uniqueSkus.filter((s) => qrFor(s)).length}/{uniqueSkus.length})
          </p>
        )}
        {loading && <p className="text-center text-sm text-slate-400">Loading stock…</p>}

        <div className="rounded-xl bg-slate-100 p-3 text-xs leading-relaxed text-slate-500">
          <p className="font-semibold text-slate-600">Print settings (Kores Endura 2801)</p>
          {mediaMode === "roll" ? (
            <p>
              In the print dialog pick the <b>Endura</b> printer, set <b>Paper/Stock</b> to your die-cut
              label size, <b>Margins: None</b>, <b>Scale: 100% (Default)</b>, and turn off
              headers/footers. Each label prints as one page so the roll advances one die-cut per label.
            </p>
          ) : (
            <p>
              Pick your printer, <b>Paper: A4</b>, <b>Scale: 100%</b>, <b>Margins: Default/None</b>.
              Labels print in a {a4Cols}-column grid; cut along the dashed guides.
            </p>
          )}
          <p className="mt-1">Colour is printed as a word (thermal is black-and-white). QR encodes the SKU.</p>
        </div>
      </div>

      {/* ---------- printable area (WYSIWYG preview) ---------- */}
      <div className="overflow-x-auto">
        <div className="print-area">
          {mediaMode === "roll" ? (
            <div className="flex flex-col items-start gap-1 print:gap-0">
              {stickers.map(({ key, row }) => (
                <div key={key} className="qr-label">
                  <LabelContent row={row} qrUrl={qrFor(row.variant_sku)} horizontal={horizontal} qrMM={qrMM} />
                </div>
              ))}
            </div>
          ) : (
            pages.map((page, pi) => (
              <section key={pi} className="sheet mb-4 print:mb-0">
                <div className="label-grid">
                  {page.map(({ key, row }) => (
                    <div key={key} className="qr-label">
                      <LabelContent
                        row={row}
                        qrUrl={qrFor(row.variant_sku)}
                        horizontal={horizontal}
                        qrMM={qrMM}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </main>
  );
}

// ---------- one label's content (mono, text-only colour) ----------
function LabelContent({
  row,
  qrUrl,
  horizontal,
  qrMM,
}: {
  row: StockRow;
  qrUrl?: string;
  horizontal: boolean;
  qrMM: number;
}) {
  const placeholder = (
    <div
      className="shrink-0 bg-slate-100"
      style={{ width: `${qrMM}mm`, height: `${qrMM}mm` }}
      aria-hidden
    />
  );
  const qr = qrUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={qrUrl} alt={row.variant_sku} className="shrink-0" />
  ) : (
    placeholder
  );

  // Font sizes are in em, relative to .qr-label's font-size (which scales with the label).
  const text = (
    <div className="min-w-0 leading-[1.12]">
      <p className="text-[0.65em] font-semibold uppercase tracking-[0.15em] text-black">Vhagar</p>
      <p className="line-clamp-2 break-words text-[1em] font-bold leading-[1.05] text-black">
        {row.name}
      </p>
      {row.color && <p className="text-[0.82em] text-black">{row.color}</p>}
      <p className="text-[0.82em] text-black">Size {row.size}</p>
      <p className="text-[0.82em] text-black">{row.variant_sku}</p>
    </div>
  );

  return horizontal ? (
    <div className="flex h-full w-full items-center gap-[1.2mm]">
      {qr}
      <div className="min-w-0 flex-1 text-left">{text}</div>
    </div>
  ) : (
    <div className="flex h-full w-full flex-col items-center justify-center gap-[0.4mm] text-center">
      {qr}
      <div className="w-full text-center">{text}</div>
    </div>
  );
}

// ---------- tiny labelled number input ----------
function NumField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
}) {
  return (
    <label className="text-xs text-slate-500">
      {label}
      <input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        onChange={(e) => onChange(Math.round(Number(e.target.value)))}
        className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm outline-none focus:border-brand"
      />
    </label>
  );
}
