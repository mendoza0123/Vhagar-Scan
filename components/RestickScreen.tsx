"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RestickBatch, RestickBatchRow, RestickSize } from "@/lib/restick";

// QR re-stick: pick a product → type the counted pieces per size → Save (stock
// becomes the count, old codes retire, one fresh code per piece) → Print.
// The SAME component lives in the POS (components/RestickScreen.tsx) and the
// IMS (components/restick/restick-screen.tsx); only the class strings in C
// differ. Change one, copy it to the other.
const C = {
  card: "rounded-2xl border border-slate-200 bg-white",
  muted: "text-slate-500",
  input: "w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-base outline-none focus:border-brand",
  primary: "rounded-xl bg-brand px-4 py-3 font-semibold text-white disabled:opacity-40",
  ghost: "rounded-xl border border-slate-300 bg-white px-4 py-3 font-semibold text-slate-700",
  chip: "rounded-lg border px-3 py-2 text-sm font-semibold",
  chipOn: "border-brand bg-brand text-white",
  chipOff: "border-slate-300 bg-white text-slate-700",
  up: "text-emerald-700",
  down: "text-rose-700",
  warn: "rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900",
  err: "rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800",
  ok: "rounded-2xl border border-emerald-300 bg-emerald-50 p-4",
  divide: "divide-y divide-slate-100",
};

type Design = { style_code: string; name: string; color: string | null; qty: number; restuck_at: string | null };
type Style = { style_code: string; name: string; color: string | null; sizes: RestickSize[]; batches: RestickBatchRow[] };

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (ch) =>
        (Number(ch) ^ (Math.random() * 16) >> (Number(ch) / 4)).toString(16));

export default function RestickScreen({
  source,
  printBase,
  printInNewTab,
  pin,
  staff,
}: {
  source: "ims" | "pos";
  printBase: string;          // print sheet URL; the batch id is appended
  printInNewTab?: boolean;
  pin?: string | null;        // POS only: the booth PIN the server checks
  staff?: string[];           // POS only: who is counting
}) {
  const [q, setQ] = useState("");
  const [designs, setDesigns] = useState<Design[]>([]);
  const [style, setStyle] = useState<Style | null>(null);
  const [loading, setLoading] = useState(false);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [rack, setRack] = useState<number | null>(null);
  const [remark, setRemark] = useState("");
  const [batchId, setBatchId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<RestickBatch | null>(null);
  const [recent, setRecent] = useState<RestickBatchRow[]>([]);
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const [by, setBy] = useState("");

  const BY_KEY = "vhagar.restick.by";
  useEffect(() => { try { setBy(localStorage.getItem(BY_KEY) || ""); } catch { /* blocked */ } }, []);

  const loadRecent = useCallback(() => {
    fetch("/api/restick", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d?.error) { setError(d.message); return; }
        setRecent(d.batches || []);
        setProg(d.progress || null);
      })
      .catch(() => { /* offline: keep what we have */ });
  }, []);
  useEffect(loadRecent, [loadRecent]);

  // search designs as the coordinator types
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setDesigns([]); return; }
    const t = setTimeout(() => {
      fetch(`/api/restick?q=${encodeURIComponent(s)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setDesigns(d.designs || []))
        .catch(() => setError("No signal — couldn't search."));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const loadStyle = useCallback(async (code: string, keepCounts: boolean) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/restick?style=${encodeURIComponent(code)}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) { setError(d?.message || "Couldn't load that product."); return; }
      setStyle(d);
      if (!keepCounts) { setCounts({}); setRack(null); setRemark(""); setBatchId(newId()); setSaved(null); }
    } catch {
      setError("No signal — couldn't load that product. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  const open = (code: string) => { setError(null); setQ(""); setDesigns([]); loadStyle(code, false); };
  const closeStyle = () => { setStyle(null); setCounts({}); setSaved(null); setError(null); };

  const ticked = useMemo(
    () => (style?.sizes || []).filter((s) => (counts[s.sku] ?? "").trim() !== ""),
    [style, counts]
  );
  const pieces = ticked.reduce((n, s) => n + (Number(counts[s.sku]) || 0), 0);
  const badCount = ticked.some((s) => !/^\d{1,3}$/.test(counts[s.sku].trim()));

  async function save() {
    if (!style || ticked.length === 0 || badCount) return;
    if (source === "pos" && !pin) { setError("Open Admin and enter the PIN first."); return; }
    if (source === "pos" && !by) { setError("Pick who is counting."); return; }
    const diffs = ticked
      .map((s) => ({ s, n: Number(counts[s.sku]) }))
      .filter(({ s, n }) => n !== s.qty)
      .map(({ s, n }) => `${s.size}: ${s.qty} → ${n} (${n > s.qty ? "+" : ""}${n - s.qty})`);
    const boxCuts = ticked
      .map((s) => ({ s, over: s.boxes.reduce((a, b) => a + b.qty, 0) - Number(counts[s.sku]) }))
      .filter(({ over }) => over > 0)
      .map(({ s, over }) => `${s.size}: ${over} taken off the box list`);
    if (diffs.length && !confirm(
      `Set IMS stock to your count?\n\n${diffs.join("\n")}` +
      (boxCuts.length ? `\n\nBoxes list more than you counted:\n${boxCuts.join("\n")}` : "")
    )) return;

    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/restick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: batchId, style: style.style_code, rack, remark,
          lines: ticked.map((s) => ({ sku: s.sku, counted: Number(counts[s.sku]), seen: s.qty })),
          pin, by,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409) {
        // someone sold or re-stuck a size meanwhile: show the new numbers, keep the counts
        setError(d.message || "Stock changed while you were counting — check the sizes again.");
        await loadStyle(style.style_code, true);
        return;
      }
      if (!r.ok) { setError(d.message || "Not saved. Try again."); return; }
      setSaved(d);
      setCounts({});
      loadRecent();
      loadStyle(style.style_code, true);
    } catch {
      // same batch id on the next tap, so a save that did land isn't doubled
      setError("Not saved — no signal. Your counts are kept; tap Save again.");
    } finally {
      setSaving(false);
    }
  }

  const printLink = (id: string, label: string, cls: string) => (
    <a href={printBase + id} target={printInNewTab ? "_blank" : undefined} rel="noreferrer" className={cls}>
      {label}
    </a>
  );

  return (
    <div className="space-y-4">
      {prog && (
        <p className={`text-sm ${C.muted}`}>
          <b className="text-base">{prog.done}</b> of {prog.total} products re-stuck
        </p>
      )}

      {source === "pos" && (
        <div className={`${C.card} p-3`}>
          <label className={`mb-1 block text-xs font-semibold uppercase ${C.muted}`}>Who is counting</label>
          <div className="flex flex-wrap gap-2">
            {(staff || []).map((n) => (
              <button
                key={n}
                onClick={() => { setBy(n); try { localStorage.setItem(BY_KEY, n); } catch { /* blocked */ } }}
                className={`${C.chip} ${by === n ? C.chipOn : C.chipOff}`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

      {!style && (
        <div className="space-y-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search product name or code…"
            className={C.input}
            autoFocus
          />
          {designs.length > 0 && (
            <ul className={`${C.card} ${C.divide}`}>
              {designs.map((d) => (
                <li key={d.style_code}>
                  <button onClick={() => open(d.style_code)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{d.name}</span>
                      <span className={`font-mono text-xs ${C.muted}`}>{d.style_code} · {d.qty} pcs in IMS</span>
                    </span>
                    {d.restuck_at && <span className={`shrink-0 text-xs font-semibold ${C.up}`}>✓ {d.restuck_at}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className={C.err}>{error}</p>}

      {style && (
        <div className={`${C.card} space-y-4 p-4`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">{style.name}</h2>
              <p className={`font-mono text-xs ${C.muted}`}>{style.style_code}{style.color ? ` · ${style.color}` : ""}</p>
            </div>
            <button onClick={closeStyle} className={`text-sm font-semibold ${C.muted}`}>Change</button>
          </div>

          <p className={`text-xs ${C.muted}`}>
            Count every piece of a size — boxes and display included — and type the number. Sizes left empty are not touched.
          </p>

          <ul className={C.divide}>
            {style.sizes.map((s) => {
              const v = counts[s.sku] ?? "";
              const n = v.trim() === "" ? null : Number(v);
              const boxed = s.boxes.reduce((a, b) => a + b.qty, 0);
              return (
                <li key={s.sku} className="flex items-center gap-3 py-3">
                  <span className="w-12 shrink-0 rounded-lg bg-slate-100 py-2 text-center font-bold text-slate-800">{s.size}</span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block">IMS <b>{s.qty}</b>{s.last_at ? <span className={`ml-2 text-xs ${C.up}`}>✓ {s.last_at}</span> : null}</span>
                    {boxed > 0 && (
                      <span className={`block text-xs ${C.muted}`}>{s.boxes.map((b) => `${b.box} ${b.qty}`).join(" · ")}</span>
                    )}
                    {s.last_at && s.codes !== s.qty && (
                      <span className="block text-xs font-semibold text-amber-700">⚠ {s.codes} codes for {s.qty} pcs — re-stick again</span>
                    )}
                  </span>
                  {n != null && Number.isFinite(n) && n !== s.qty && (
                    <span className={`w-10 shrink-0 text-right text-sm font-bold ${n > s.qty ? C.up : C.down}`}>
                      {n > s.qty ? "+" : ""}{n - s.qty}
                    </span>
                  )}
                  <input
                    value={v}
                    onChange={(e) => setCounts((c) => ({ ...c, [s.sku]: e.target.value.replace(/[^\d]/g, "").slice(0, 3) }))}
                    inputMode="numeric"
                    placeholder="—"
                    aria-label={`Counted ${s.size}`}
                    className={`${C.input} w-20 shrink-0 text-center font-bold`}
                  />
                </li>
              );
            })}
          </ul>

          <div>
            <label className={`mb-1 block text-xs font-semibold uppercase ${C.muted}`}>In store (optional)</label>
            <div className="flex flex-wrap gap-2">
              {[null, 1, 2, 3, 4, 5].map((r) => (
                <button key={r ?? 0} onClick={() => setRack(r)} className={`${C.chip} ${rack === r ? C.chipOn : C.chipOff}`}>
                  {r == null ? "—" : `Rack ${r}`}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className={`mb-1 block text-xs font-semibold uppercase ${C.muted}`}>Remark (optional)</label>
            <input value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={200} className={C.input} />
          </div>

          <button onClick={save} disabled={saving || loading || ticked.length === 0 || badCount} className={`${C.primary} w-full`}>
            {saving ? "Saving…" : ticked.length === 0 ? "Type a count to start" : `Save ${pieces} piece${pieces === 1 ? "" : "s"} & make labels`}
          </button>

          {saved && (
            <div className={`${C.ok} space-y-3`}>
              <p className="font-semibold">
                Saved — {saved.codes.length} new code{saved.codes.length === 1 ? "" : "s"}
                {saved.rack ? ` · Rack ${saved.rack}` : ""}
              </p>
              <ul className="text-sm">
                {saved.lines.map((l) => (
                  <li key={l.sku}>
                    {l.size}: {l.ims_qty === l.counted ? `${l.counted} (no change)` : `${l.ims_qty} → ${l.counted}`}
                    {l.retired ? ` · ${l.retired} old code${l.retired === 1 ? "" : "s"} retired` : ""}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                {saved.codes.length > 0 && printLink(saved.id, "Print labels", `${C.primary} flex-1 text-center`)}
                <button onClick={closeStyle} className={`${C.ghost} flex-1`}>Next product</button>
              </div>
            </div>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div>
          <h3 className={`mb-2 text-xs font-semibold uppercase ${C.muted}`}>Recent re-sticks</h3>
          <ul className={`${C.card} ${C.divide}`}>
            {recent.map((b) => (
              <li key={b.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{b.name} <span className={`font-normal ${C.muted}`}>· {b.pcs} pcs</span></span>
                  <span className={`block text-xs ${C.muted}`}>
                    {b.at} · {b.created_by || "—"} · {b.source.toUpperCase()}{b.rack ? ` · Rack ${b.rack}` : ""}
                  </span>
                  <span className={`block text-xs ${C.muted}`}>{b.sizes}{b.remark ? ` · “${b.remark}”` : ""}</span>
                </span>
                {b.pcs > 0 && printLink(b.id, b.printed_at ? "Reprint" : "Print", `${b.printed_at ? C.ghost : C.primary} shrink-0 px-3 py-2 text-sm`)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
