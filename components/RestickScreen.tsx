"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GridStyle, RestickBatch, RestickBatchRow, RestickSize } from "@/lib/restick";

// QR re-stick: pick a product → count the pieces per size → Save (stock
// becomes the count, old codes retire, one fresh code per piece) → Print.
// Each saved re-stick can then be edited, voided (undone) or deleted.
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
  tile: "group overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-sm transition hover:border-brand",
  imgBox: "bg-slate-100",
  faint: "text-slate-300",
  sheet: "bg-white",
  rowHover: "hover:bg-slate-50",
  accent: "text-brand",
  sizeBox: "bg-slate-100 text-slate-800",
  step: "flex h-11 w-11 items-center justify-center rounded-xl border border-slate-300 bg-white text-xl font-bold text-slate-700 active:bg-slate-100 disabled:opacity-30",
  count: "h-11 w-14 rounded-xl border border-slate-300 bg-white text-center text-lg font-bold outline-none focus:border-brand",
  action: "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700",
  danger: "rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700",
  panel: "rounded-xl border border-slate-200 bg-slate-50 p-3",
};

type Design = { style_code: string; name: string; color: string | null; qty: number; restuck_at: string | null };
type Style = { style_code: string; name: string; color: string | null; sizes: RestickSize[]; batches: RestickBatchRow[] };
type Family = {
  family: string; qty: number; image: string | null; done: number;
  designs: (GridStyle & { design: string })[];
};
type RowMsg = { id: string; tone: "ok" | "err"; text: string; added?: string[]; removed?: string[] };

// "LIO LINEN 17" → family LIO LINEN, design 17 — the same rule as the IMS
// dashboard's Top sellers cards: the family is the leading words with no digits.
function splitFamily(name: string): { family: string; design: string } {
  const tokens = name.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && !/\d/.test(tokens[i])) i++;
  const family = tokens.slice(0, i).join(" ") || name;
  return { family: family.toUpperCase(), design: tokens.slice(i).join(" ") || "—" };
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (ch) =>
        (Number(ch) ^ (Math.random() * 16) >> (Number(ch) / 4)).toString(16));

// − [ n ] +  — tap + once per piece while counting, or type the number.
// "" means "not counted" (the size is left alone).
type Update = (prev: string) => string;
function Stepper({ value, onChange, label }: { value: string; onChange: (f: Update) => void; label: string }) {
  const n = value === "" ? null : Number(value);
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button type="button" aria-label={`One less ${label}`} disabled={n == null || n <= 0}
              onClick={() => onChange((p) => (p === "" || Number(p) <= 0 ? p : String(Number(p) - 1)))} className={C.step}>−</button>
      <input
        value={value}
        onChange={(e) => { const v = e.target.value.replace(/[^\d]/g, "").slice(0, 3); onChange(() => v); }}
        inputMode="numeric"
        placeholder="—"
        aria-label={`Counted ${label}`}
        className={C.count}
      />
      <button type="button" aria-label={`One more ${label}`}
              onClick={() => onChange((p) => String(Math.min(999, (p === "" ? 0 : Number(p)) + 1)))} className={C.step}>+</button>
    </div>
  );
}

function DiffBadge({ was, now }: { was: number; now: number | null }) {
  if (now == null || !Number.isFinite(now)) return null;
  const d = now - was;
  if (d === 0) return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">✓ same</span>;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${d > 0 ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
      {d > 0 ? "+" : "−"}{Math.abs(d)}
    </span>
  );
}

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
  const [grid, setGrid] = useState<GridStyle[]>([]);
  const [family, setFamily] = useState<Family | null>(null);
  const [allRecent, setAllRecent] = useState(false);
  // editing a saved re-stick
  const [editing, setEditing] = useState<RestickBatch | null>(null);
  const [editCounts, setEditCounts] = useState<Record<string, string>>({});
  const [editRack, setEditRack] = useState<number | null>(null);
  const [editRemark, setEditRemark] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<RowMsg | null>(null);

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

  const loadGrid = useCallback(() => {
    fetch("/api/restick?grid=1", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d?.styles)) setGrid(d.styles); })
      .catch(() => { /* offline: keep what we have */ });
  }, []);
  useEffect(loadGrid, [loadGrid]);

  // most pieces first — the biggest piles are the most work
  const families = useMemo<Family[]>(() => {
    const m = new Map<string, Family>();
    for (const g of grid) {
      const { family, design } = splitFamily(g.name);
      const f = m.get(family) || { family, qty: 0, image: null, done: 0, designs: [] };
      f.qty += g.qty;
      if (g.restuck) f.done++;
      if (!f.image && g.image) f.image = g.image;
      f.designs.push({ ...g, design });
      m.set(family, f);
    }
    const out = Array.from(m.values());
    out.forEach((f) => f.designs.sort((a, b) => b.qty - a.qty));
    return out.sort((a, b) => b.qty - a.qty);
  }, [grid]);

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

  const open = (code: string) => { setError(null); setQ(""); setDesigns([]); setFamily(null); loadStyle(code, false); };
  const closeStyle = () => { setStyle(null); setCounts({}); setSaved(null); setError(null); };
  const refreshAll = () => { loadRecent(); loadGrid(); if (style) loadStyle(style.style_code, true); };

  const ticked = useMemo(
    () => (style?.sizes || []).filter((s) => (counts[s.sku] ?? "").trim() !== ""),
    [style, counts]
  );
  const pieces = ticked.reduce((n, s) => n + (Number(counts[s.sku]) || 0), 0);
  const badCount = ticked.some((s) => !/^\d{1,3}$/.test(counts[s.sku].trim()));

  // POS writes need the PIN and a name; the IMS knows who is logged in
  const posReady = () => {
    if (source !== "pos") return true;
    if (!pin) { setError("Open Admin and enter the PIN first."); return false; }
    if (!by) { setError("Pick who is counting (top of the screen)."); return false; }
    return true;
  };

  async function save() {
    if (!style || ticked.length === 0 || badCount || !posReady()) return;
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
      loadGrid();
      loadStyle(style.style_code, true);
    } catch {
      // same batch id on the next tap, so a save that did land isn't doubled
      setError("Not saved — no signal. Your counts are kept; tap Save again.");
    } finally {
      setSaving(false);
    }
  }

  // ---- edit / void / delete a saved re-stick ----
  async function startEdit(id: string) {
    setRowMsg(null);
    setBusyId(id);
    try {
      const r = await fetch(`/api/restick/${id}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) { setRowMsg({ id, tone: "err", text: d?.message || "Couldn't open it." }); return; }
      setEditing(d);
      setEditCounts(Object.fromEntries((d as RestickBatch).lines.map((l) => [l.sku, String(l.counted)])));
      setEditRack(d.rack);
      setEditRemark(d.remark || "");
    } catch {
      setRowMsg({ id, tone: "err", text: "No signal — try again." });
    } finally {
      setBusyId(null);
    }
  }

  async function saveEdit() {
    if (!editing || !posReady()) return;
    const changed = editing.lines.filter((l) => editCounts[l.sku] !== "" && Number(editCounts[l.sku]) !== l.counted);
    if (editing.lines.some((l) => !/^\d{1,3}$/.test(editCounts[l.sku] ?? ""))) {
      setRowMsg({ id: editing.id, tone: "err", text: "Every size needs a count from 0 to 999." });
      return;
    }
    if (changed.length && !confirm(
      `Change the count?\n\n${changed.map((l) => `${l.size}: ${l.counted} → ${editCounts[l.sku]}`).join("\n")}\n\n` +
      "Stock moves by the difference. Extra pieces get new codes; fewer pieces retire the last codes."
    )) return;
    setBusyId(editing.id);
    try {
      const r = await fetch(`/api/restick/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rack: editRack, remark: editRemark,
          lines: changed.map((l) => ({ sku: l.sku, counted: Number(editCounts[l.sku]) })),
          pin, by,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setRowMsg({ id: editing.id, tone: "err", text: d.message || "Not saved. Try again." }); return; }
      setRowMsg({ id: editing.id, tone: "ok", text: "Saved.", added: d.added || [], removed: d.removed || [] });
      setEditing(null);
      refreshAll();
    } catch {
      setRowMsg({ id: editing.id, tone: "err", text: "No signal — not saved. Try again." });
    } finally {
      setBusyId(null);
    }
  }

  async function voidOne(b: RestickBatchRow) {
    if (!posReady()) return;
    if (!confirm(
      `Void the re-stick of ${b.name} (${b.sizes})?\n\n` +
      "Stock goes back to what IMS had before, its codes retire and the old codes it replaced come back. " +
      "It stays in this list, marked voided."
    )) return;
    setBusyId(b.id);
    setRowMsg(null);
    try {
      const r = await fetch(`/api/restick/${b.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "void", pin, by }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setRowMsg({ id: b.id, tone: "err", text: d.message || "Not voided. Try again." }); return; }
      setRowMsg({ id: b.id, tone: "ok", text: "Voided — stock and codes are back as before. Peel its stickers." });
      if (editing?.id === b.id) setEditing(null);
      refreshAll();
    } catch {
      setRowMsg({ id: b.id, tone: "err", text: "No signal — not voided. Try again." });
    } finally {
      setBusyId(null);
    }
  }

  async function deleteOne(b: RestickBatchRow) {
    if (!posReady()) return;
    if (!confirm(
      `Delete the re-stick of ${b.name} (${b.sizes})?\n\n` +
      (b.voided_at ? "It is already voided; this removes it from the list." :
        "It is undone first (stock and codes back as before), then removed from the list.") +
      " The stock history keeps a note of it."
    )) return;
    setBusyId(b.id);
    setRowMsg(null);
    try {
      const r = await fetch(`/api/restick/${b.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, by }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setRowMsg({ id: b.id, tone: "err", text: d.message || "Not deleted. Try again." }); return; }
      if (editing?.id === b.id) setEditing(null);
      refreshAll();
    } catch {
      setRowMsg({ id: b.id, tone: "err", text: "No signal — not deleted. Try again." });
    } finally {
      setBusyId(null);
    }
  }

  const printLink = (id: string, label: string, cls: string, codes?: string[]) => (
    <a href={printBase + id + (codes?.length ? `&codes=${encodeURIComponent(codes.join(","))}` : "")}
       target={printInNewTab ? "_blank" : undefined} rel="noreferrer" className={cls}>
      {label}
    </a>
  );

  const shownRecent = allRecent ? recent : recent.slice(0, 5);
  const recentBlock = recent.length > 0 && (
    <div className="max-w-2xl">
      <h3 className={`mb-2 text-xs font-semibold uppercase ${C.muted}`}>Recent re-sticks</h3>
      <ul className={`${C.card} ${C.divide}`}>
        {shownRecent.map((b) => {
          const voided = !!b.voided_at;
          const busy = busyId === b.id;
          const msg = rowMsg?.id === b.id ? rowMsg : null;
          return (
            <li key={b.id} className="space-y-2 px-4 py-3 text-sm">
              <div className="flex items-start gap-3">
                <span className={`min-w-0 flex-1 ${voided ? "opacity-60" : ""}`}>
                  <span className={`block truncate font-semibold ${voided ? "line-through" : ""}`}>
                    {b.name} <span className={`font-normal ${C.muted}`}>· {b.pcs} pcs</span>
                  </span>
                  <span className={`block text-xs ${C.muted}`}>
                    {b.at} · {b.created_by || "—"} · {b.source.toUpperCase()}{b.rack ? ` · Rack ${b.rack}` : ""}
                  </span>
                  <span className={`block text-xs ${C.muted}`}>{b.sizes}{b.remark ? ` · “${b.remark}”` : ""}</span>
                  {voided && <span className={`block text-xs font-semibold ${C.down}`}>Voided {b.voided_at}{b.voided_by ? ` by ${b.voided_by}` : ""}</span>}
                </span>
                {!voided && b.pcs > 0 && printLink(b.id, b.printed_at ? "Reprint" : "Print", `${b.printed_at ? C.ghost : C.primary} shrink-0 px-3 py-2 text-sm`)}
              </div>

              <div className="flex flex-wrap gap-2">
                {!voided && (
                  <button onClick={() => (editing?.id === b.id ? setEditing(null) : startEdit(b.id))} disabled={busy} className={C.action}>
                    {editing?.id === b.id ? "Close edit" : "Edit"}
                  </button>
                )}
                {!voided && <button onClick={() => voidOne(b)} disabled={busy} className={C.action}>Void</button>}
                <button onClick={() => deleteOne(b)} disabled={busy} className={C.danger}>Delete</button>
                {busy && <span className={`self-center text-xs ${C.muted}`}>Working…</span>}
              </div>

              {msg && (
                <div className={msg.tone === "err" ? C.err : C.warn}>
                  <p>{msg.text}</p>
                  {msg.added && msg.added.length > 0 && (
                    <p className="mt-1">
                      {msg.added.length} new code{msg.added.length === 1 ? "" : "s"} —{" "}
                      {printLink(b.id, "print just these", "font-semibold underline", msg.added)}
                    </p>
                  )}
                  {msg.removed && msg.removed.length > 0 && (
                    <p className="mt-1">Peel these stickers: <span className="font-mono">{msg.removed.join(", ")}</span></p>
                  )}
                </div>
              )}

              {editing?.id === b.id && (
                <div className={`${C.panel} space-y-3`}>
                  <ul className={C.divide}>
                    {editing.lines.map((l) => {
                      const v = editCounts[l.sku] ?? "";
                      return (
                        <li key={l.sku} className="flex items-center gap-3 py-2">
                          <span className={`flex h-11 w-12 shrink-0 items-center justify-center rounded-lg font-bold ${C.sizeBox}`}>{l.size}</span>
                          <span className="min-w-0 flex-1 text-xs">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className={C.muted}>counted</span> <b className="text-sm">{l.counted}</b>
                              <DiffBadge was={l.counted} now={v === "" ? null : Number(v)} />
                            </span>
                            <span className={`block ${C.muted}`}>IMS had {l.ims_qty} before</span>
                          </span>
                          <Stepper value={v} label={l.size} onChange={(f) => setEditCounts((c) => ({ ...c, [l.sku]: f(c[l.sku] ?? "") }))} />
                        </li>
                      );
                    })}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    {[null, 1, 2, 3, 4, 5].map((r) => (
                      <button key={r ?? 0} onClick={() => setEditRack(r)} className={`${C.chip} ${editRack === r ? C.chipOn : C.chipOff}`}>
                        {r == null ? "No rack" : `Rack ${r}`}
                      </button>
                    ))}
                  </div>
                  <input value={editRemark} onChange={(e) => setEditRemark(e.target.value)} maxLength={200}
                         placeholder="Remark (optional)" className={C.input} />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} disabled={busy} className={`${C.primary} flex-1`}>{busy ? "Saving…" : "Save changes"}</button>
                    <button onClick={() => setEditing(null)} className={`${C.ghost} flex-1`}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {recent.length > 5 && (
        <button onClick={() => setAllRecent((v) => !v)} className={`mt-2 text-sm font-semibold ${C.muted}`}>
          {allRecent ? "Show fewer" : `Show all ${recent.length}`}
        </button>
      )}
    </div>
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

      {!style && q.trim().length < 2 && recentBlock}

      {!style && q.trim().length < 2 && families.length > 0 && (
        <div className={C.card}>
          <p className="border-b px-4 py-2 text-sm font-semibold">
            Products <span className={`font-normal ${C.muted}`}>· tap a product for its designs</span>
          </p>
          <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 xl:grid-cols-5">
            {families.map((f) => {
              const all = f.done === f.designs.length;
              return (
                <button key={f.family} onClick={() => setFamily(f)} className={C.tile}>
                  <div className={`relative flex h-24 items-center justify-center overflow-hidden ${C.imgBox}`}>
                    {f.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={f.image} alt={f.family} referrerPolicy="no-referrer" loading="lazy"
                           className="h-full w-full object-cover transition group-hover:scale-105" />
                    ) : (
                      <span className={`text-3xl font-bold ${C.faint}`}>{f.family[0]}</span>
                    )}
                    <span className={`absolute left-1.5 top-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-bold text-white ${all ? "bg-emerald-600" : "bg-black/60"}`}>
                      {all ? "✓ done" : `${f.done}/${f.designs.length}`}
                    </span>
                  </div>
                  <div className="p-3">
                    <p className="truncate text-sm font-semibold">{f.family}</p>
                    <p className={`text-xs ${C.muted}`}>
                      {f.designs.length} design{f.designs.length === 1 ? "" : "s"} · {f.qty} pcs
                    </p>
                    <p className={`text-sm font-bold ${all ? C.up : ""}`}>
                      {all ? "All re-stuck" : f.done ? `${f.done} of ${f.designs.length} re-stuck` : "Not started"}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {family && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-6" onClick={() => setFamily(null)}>
          <div className={`max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl p-5 shadow-xl sm:rounded-2xl ${C.sheet}`} onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">{family.family}</h2>
                <p className={`text-sm ${C.muted}`}>{family.qty} pcs · {family.done} of {family.designs.length} re-stuck</p>
              </div>
              <button onClick={() => setFamily(null)} className={`${C.ghost} px-3 py-1.5 text-sm`}>✕ Close</button>
            </div>
            <p className={`mb-1 text-xs ${C.muted}`}>Tap a design to count it.</p>
            <ul className={C.divide}>
              {family.designs.map((d) => (
                <li key={d.style_code}>
                  <button onClick={() => open(d.style_code)} className={`flex w-full items-center gap-3 rounded-lg py-2.5 text-left transition ${C.rowHover}`}>
                    <div className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg ${C.imgBox}`}>
                      {d.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={d.image} alt={d.name} referrerPolicy="no-referrer" loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <span className={`text-sm font-bold ${C.faint}`}>{d.design[0]}</span>
                      )}
                    </div>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {family.family} <span className={C.accent}>{d.design}</span>
                      </span>
                      <span className={`text-xs ${C.muted}`}>{d.qty} pc{d.qty === 1 ? "" : "s"} · {d.style_code}</span>
                    </span>
                    <span className={`shrink-0 text-xs font-semibold ${d.restuck ? C.up : C.muted}`}>{d.restuck ? "✓ re-stuck" : "count ›"}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {style && (
        <div className={`${C.card} max-w-2xl space-y-4 p-4`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">{style.name}</h2>
              <p className={`font-mono text-xs ${C.muted}`}>{style.style_code}{style.color ? ` · ${style.color}` : ""}</p>
            </div>
            <button onClick={closeStyle} className={`${C.ghost} px-3 py-1.5 text-sm`}>← Products</button>
          </div>

          <p className={`text-xs ${C.muted}`}>
            Count every piece of a size — boxes and display included. Tap + once per piece, or type the number.
            Sizes left at — are not touched.
          </p>

          <ul className={C.divide}>
            {style.sizes.map((s) => {
              const v = counts[s.sku] ?? "";
              const boxed = s.boxes.reduce((a, b) => a + b.qty, 0);
              return (
                <li key={s.sku} className="flex items-center gap-3 py-3">
                  <span className={`flex h-11 w-12 shrink-0 items-center justify-center rounded-lg font-bold ${C.sizeBox}`}>{s.size}</span>
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={C.muted}>IMS</span>
                      <b className="text-base">{s.qty}</b>
                      <DiffBadge was={s.qty} now={v === "" ? null : Number(v)} />
                    </p>
                    {s.last_at && <p className={`text-xs ${C.up}`}>✓ re-stuck {s.last_at}</p>}
                    {boxed > 0 && <p className={`truncate text-xs ${C.muted}`}>{s.boxes.map((b) => `${b.box} ${b.qty}`).join(" · ")}</p>}
                    {s.last_at && s.codes !== s.qty && (
                      <p className="text-xs font-semibold text-amber-700">⚠ {s.codes} codes for {s.qty} pcs — re-stick again</p>
                    )}
                  </div>
                  <Stepper value={v} label={s.size} onChange={(f) => setCounts((c) => ({ ...c, [s.sku]: f(c[s.sku] ?? "") }))} />
                </li>
              );
            })}
          </ul>

          <div>
            <label className={`mb-1 block text-xs font-semibold uppercase ${C.muted}`}>In store (optional)</label>
            <div className="flex flex-wrap gap-2">
              {[null, 1, 2, 3, 4, 5].map((r) => (
                <button key={r ?? 0} onClick={() => setRack(r)} className={`${C.chip} ${rack === r ? C.chipOn : C.chipOff}`}>
                  {r == null ? "No rack" : `Rack ${r}`}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className={`mb-1 block text-xs font-semibold uppercase ${C.muted}`}>Remark (optional)</label>
            <input value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={200} className={C.input} />
          </div>

          <button onClick={save} disabled={saving || loading || ticked.length === 0 || badCount} className={`${C.primary} w-full`}>
            {saving ? "Saving…" : ticked.length === 0 ? "Count a size to start" : `Save ${pieces} piece${pieces === 1 ? "" : "s"} & make labels`}
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

      {style && recentBlock}
    </div>
  );
}
