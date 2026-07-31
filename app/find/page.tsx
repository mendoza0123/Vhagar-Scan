"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { staffName } from "@/lib/staff";

const Scanner = dynamic(() => import("../sell/Scanner"), { ssr: false });

type Place = { carton: string; location: string | null; qty: number; isRack: boolean; isDisplay?: boolean };
type SizeRow = { variant_sku: string; size: string; qty_on_hand: number; places: Place[] };
type Style = { scanned: string; style_code: string; name: string; sizes: SizeRow[] };
type Row = {
  carton_id: string; location: string | null; variant_sku: string;
  name: string; size: string; qty: number; is_rack: boolean; is_display?: boolean;
};

const SIZE_SORT = ["XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL", "4XL"];
const sizeRank = (s: string) => {
  const i = SIZE_SORT.indexOf(s.toUpperCase());
  return i === -1 ? 99 : i;
};

// "EARTH PLAIN 06" → family EARTH PLAIN, design 06. The family is the leading
// words with no digits; everything from the first digit-bearing token on is the
// design code. ("PLAY Y5A183B" → PLAY / Y5A183B.)
function splitFamily(name: string): { family: string; design: string } {
  const tokens = name.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && !/\d/.test(tokens[i])) i++;
  const family = tokens.slice(0, i).join(" ") || name;
  return { family: family.toUpperCase(), design: tokens.slice(i).join(" ") || "—" };
}

// Tiny pencil affordance shown on every location line (Rack / Display / carton)
// to open the move sheet.
function EditBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="ml-1.5 shrink-0 rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-500 active:bg-slate-100"
      aria-label="Move this piece"
    >
      ✎
    </button>
  );
}

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
  const [place, setPlace] = useState<"all" | "rack" | "display" | "box">("all");
  const [sizeFil, setSizeFil] = useState<string>("all");
  const [openFam, setOpenFam] = useState<string | null>(null);
  // browse-first: the whole index loads on open so staff see product cards
  // without typing; 5 at a time, A→Z, "More" reveals the rest.
  const [browseRows, setBrowseRows] = useState<Row[]>([]);
  const [visFam, setVisFam] = useState(5);
  // location editor — move a line between Rack / Display / a carton, any direction.
  // `from` is the source container: 'RACK' | 'DISPLAY' | a carton_no.
  const [editing, setEditing] = useState<{ sku: string; name: string; size: string; qty: number; from: string } | null>(null);
  const [editQty, setEditQty] = useState(1);
  const [editDest, setEditDest] = useState<"RACK" | "DISPLAY" | "pick" | "off" | "origin">("RACK");
  const [editBox, setEditBox] = useState("");
  const [boxes, setBoxes] = useState<string[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);
  const lastScan = useRef<{ code: string; at: number }>({ code: "", at: 0 });

  const loadBrowse = useCallback(async () => {
    try {
      const res = await fetch("/api/cartons/find?browse=1");
      const d = res.ok ? await res.json() : { results: [] };
      setBrowseRows(d.results || []);
    } catch {
      /* browse list is a convenience — search still works without it */
    }
  }, []);
  useEffect(() => { loadBrowse(); }, [loadBrowse]);

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

  // no query typed → browse the whole index; typed → server search results
  const browsing = q.trim().length < 2;
  const activeRows = browsing ? browseRows : rows;

  const sizes = useMemo(
    () => [...new Set(activeRows.map((r) => r.size.toUpperCase()))].sort((a, b) => sizeRank(a) - sizeRank(b)),
    [activeRows]
  );

  // filters → family cards → designs inside each card
  const families = useMemo(() => {
    const filtered = activeRows.filter(
      (r) =>
        (place === "all" ||
          (place === "rack" ? r.is_rack : place === "display" ? r.is_display : !r.is_rack && !r.is_display)) &&
        (sizeFil === "all" || r.size.toUpperCase() === sizeFil)
    );
    const fams = new Map<string, { total: number; designs: Map<string, Row[]> }>();
    for (const r of filtered) {
      const { family, design } = splitFamily(r.name);
      const f = fams.get(family) || { total: 0, designs: new Map() };
      f.total += r.qty;
      const d = f.designs.get(design) || [];
      d.push(r);
      f.designs.set(design, d);
      fams.set(family, f);
    }
    return Array.from(fams.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [activeRows, place, sizeFil]);

  const visibleFams = browsing ? families.slice(0, visFam) : families;

  // ---- location editor ----
  const openEdit = async (sku: string, name: string, size: string, qty: number, from: string) => {
    setEditing({ sku, name, size, qty, from });
    setEditQty(1);
    // sensible default destination: rack keeps its "back to origin", staged/boxed
    // pieces default to the rack (the usual "bring it out front" move).
    setEditDest(from === "RACK" ? "origin" : "RACK");
    setEditBox("");
    if (boxes.length === 0) {
      try {
        const res = await fetch("/api/cartons");
        const d = res.ok ? await res.json() : { cartons: [] };
        setBoxes((d.cartons || []).map((c: any) => c.carton_id));
      } catch { /* dropdown just stays empty; origin/remove still work */ }
    }
  };

  const saveEdit = async () => {
    if (!editing || (editDest === "pick" && !editBox)) return;
    setSavingEdit(true);
    setErr(null);
    try {
      const to =
        editDest === "pick" ? editBox : editDest === "off" ? null : editDest; // 'RACK' | 'DISPLAY' | box | null(off)
      const body =
        editDest === "origin"
          ? { action: "return", items: [{ sku: editing.sku, qty: editQty }], by: staffName() }
          : { action: "relocate", sku: editing.sku, qty: editQty, from: editing.from, to, by: staffName() };
      const res = await fetch("/api/rack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) { setErr(d.message || "Could not update — try again."); return; }
      setEditing(null);
      navigator.vibrate?.(30);
      // refresh whatever the screen is showing
      loadBrowse();
      const query = q.trim();
      if (query.length >= 2) {
        const r2 = await fetch(`/api/cartons/find?q=${encodeURIComponent(query)}`);
        const d2 = r2.ok ? await r2.json() : { results: [] };
        setRows(d2.results || []);
      }
      if (style) lookupSku(style.scanned);
    } catch {
      setErr("No signal — nothing changed, try again.");
    } finally {
      setSavingEdit(false);
    }
  };

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
                            {p.isDisplay ? (
                              <>
                                <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-violet-800">
                                  on Display
                                </span>
                                <EditBtn onClick={() => openEdit(s.variant_sku, style.name, s.size, p.qty, "DISPLAY")} />
                              </>
                            ) : p.isRack ? (
                              <>
                                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-emerald-800">
                                  in Rack
                                </span>
                                <EditBtn onClick={() => openEdit(s.variant_sku, style.name, s.size, p.qty, "RACK")} />
                              </>
                            ) : (
                              <>
                                in <span className="font-semibold text-brand">{p.carton}</span>
                                {p.location && <span className="text-xs text-slate-400"> · {p.location}</span>}
                                <EditBtn onClick={() => openEdit(s.variant_sku, style.name, s.size, p.qty, p.carton)} />
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

      {/* ---- filters (only when there are results to filter) ---- */}
      {activeRows.length > 0 && !style && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-4 gap-2">
            {([["all", "All"], ["rack", "Rack"], ["display", "Display"], ["box", "Cartons"]] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setPlace(v)}
                className={`rounded-xl border px-2 py-2 text-sm font-medium ${place === v ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {sizes.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setSizeFil("all")}
                className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${sizeFil === "all" ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-500"}`}
              >
                All sizes
              </button>
              {sizes.map((s) => (
                <button
                  key={s}
                  onClick={() => setSizeFil(sizeFil === s ? "all" : s)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${sizeFil === s ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-500"}`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- product cards: family → tap → designs → sizes & where ---- */}
      {visibleFams.length > 0 && !style && (
        <div className="grid grid-cols-2 gap-2">
          {visibleFams.map(([fam, f]) => {
            const open = openFam === fam;
            return (
              <div key={fam} className={open ? "col-span-2" : ""}>
                <button
                  onClick={() => setOpenFam(open ? null : fam)}
                  className={`w-full rounded-2xl border p-3 text-left shadow-sm ${open ? "border-brand bg-brand/5" : "border-slate-200 bg-white"}`}
                >
                  <p className="truncate font-bold">{fam}</p>
                  <p className="text-xs text-slate-500">
                    {f.designs.size} design{f.designs.size === 1 ? "" : "s"} · {f.total} pc{f.total === 1 ? "" : "s"}
                    <span className="float-right">{open ? "▲" : "▼"}</span>
                  </p>
                </button>
                {open && (
                  <div className="mt-1 flex flex-col gap-1.5 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                    {Array.from(f.designs.entries()).map(([design, list]) => (
                      <div key={design} className="rounded-xl bg-slate-50 p-2">
                        <p className="text-sm font-semibold">
                          {fam} <span className="text-brand">{design}</span>
                        </p>
                        <ul className="mt-1 divide-y divide-slate-100">
                          {[...list].sort((a, b) => sizeRank(a.size) - sizeRank(b.size)).map((r) => (
                            <li key={`${r.carton_id}-${r.variant_sku}`} className="flex items-center gap-3 py-1.5 text-sm">
                              <span className="w-10 shrink-0 rounded-lg bg-white px-2 py-0.5 text-center font-semibold">{r.size}</span>
                              <span className="min-w-0 flex-1">
                                {r.is_display ? (
                                  <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-violet-800">
                                    on Display
                                  </span>
                                ) : r.is_rack ? (
                                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-emerald-800">
                                    in Rack
                                  </span>
                                ) : (
                                  <span className="font-semibold text-brand">
                                    {r.carton_id}
                                    {r.location && <span className="ml-1 text-xs font-normal text-slate-400">📍 {r.location}</span>}
                                  </span>
                                )}
                              </span>
                              <span className="shrink-0 font-semibold tabular-nums">×{r.qty}</span>
                              <EditBtn
                                onClick={() =>
                                  openEdit(r.variant_sku, r.name, r.size, r.qty, r.is_rack ? "RACK" : r.is_display ? "DISPLAY" : r.carton_id)
                                }
                              />
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {browsing && !style && families.length > visFam && (
        <button
          onClick={() => setVisFam((v) => v + 10)}
          className="btn btn-ghost w-full"
        >
          More products ({families.length - visFam} left) ↓
        </button>
      )}

      {searched && !searching && rows.length > 0 && families.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
          Nothing matches these filters.
        </p>
      )}

      {searched && !searching && rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
          Not on the rack or in any carton — check main stock.
        </p>
      )}
      {!style && !searched && !searching && families.length === 0 && (
        <p className="rounded-xl bg-slate-100 p-3 text-xs leading-relaxed text-slate-500">
          Scan the piece hanging in the stall to see every size, how many we have,
          and whether it&apos;s on the <b>Rack</b> or still in a <b>carton</b>.
        </p>
      )}

      {/* ---- location editor: move a piece between Rack / Display / a carton ---- */}
      {editing && (() => {
        const from = editing.from;
        const srcLabel = from === "RACK" ? "the rack" : from === "DISPLAY" ? "display" : from;
        const btn = (active: boolean, danger = false) =>
          `rounded-xl border px-4 py-2.5 text-left text-sm font-medium ${
            active
              ? danger ? "border-rose-500 bg-rose-500 text-white" : "border-brand bg-brand text-white"
              : "border-slate-200 bg-white text-slate-600"
          }`;
        return (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => setEditing(null)}>
          <div className="w-full max-w-md rounded-t-3xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-brand">Move piece</h3>
            <p className="text-sm text-slate-500">
              {editing.name} · <b>{editing.size}</b> — {editing.qty} on {srcLabel}
            </p>

            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">How many</p>
            <div className="mt-1 flex items-center gap-3">
              <button
                onClick={() => setEditQty((n) => Math.max(1, n - 1))}
                className="h-11 w-11 rounded-xl border border-slate-300 text-xl font-bold active:bg-slate-100"
              >
                −
              </button>
              <span className="w-10 text-center text-xl font-bold tabular-nums">{editQty}</span>
              <button
                onClick={() => setEditQty((n) => Math.min(editing.qty, n + 1))}
                className="h-11 w-11 rounded-xl border border-slate-300 text-xl font-bold active:bg-slate-100"
              >
                +
              </button>
              <span className="text-xs text-slate-400">of {editing.qty}</span>
            </div>

            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Where to</p>
            <div className="mt-1 flex flex-col gap-2">
              {from === "RACK" && (
                <button onClick={() => setEditDest("origin")} className={btn(editDest === "origin")}>
                  ↩ Back to its own box (auto)
                </button>
              )}
              {from !== "RACK" && (
                <button onClick={() => setEditDest("RACK")} className={btn(editDest === "RACK")}>
                  🧥 Onto the Rack
                </button>
              )}
              {from !== "DISPLAY" && (
                <button onClick={() => setEditDest("DISPLAY")} className={btn(editDest === "DISPLAY")}>
                  ✨ Onto Display
                </button>
              )}
              <button onClick={() => setEditDest("pick")} className={btn(editDest === "pick")}>
                📦 Into a carton…
              </button>
              {editDest === "pick" && (
                <select
                  value={editBox}
                  onChange={(e) => setEditBox(e.target.value)}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-base outline-none focus:border-brand"
                >
                  <option value="">Choose a carton…</option>
                  {boxes.filter((b) => b !== from).map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              )}
              <button onClick={() => setEditDest("off")} className={btn(editDest === "off", true)}>
                ✕ Take off {srcLabel} (count correction)
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-400">Location only — stock never changes here.</p>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button onClick={() => setEditing(null)} className="btn btn-ghost">Cancel</button>
              <button
                onClick={saveEdit}
                disabled={savingEdit || (editDest === "pick" && !editBox)}
                className="btn btn-primary disabled:opacity-50"
              >
                {savingEdit ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </main>
  );
}
