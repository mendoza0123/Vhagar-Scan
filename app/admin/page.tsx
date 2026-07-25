"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { money } from "@/lib/format";

const PIN_KEY = "vhagar.admin.pin";

type Variant = {
  variant_sku: string;
  name: string;
  size: string;
  color: string | null;
  price: number;
  needs_price: boolean;
  qty_on_hand: number;
};

export default function AdminPage() {
  const [pin, setPin] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pinError, setPinError] = useState(false);

  // auto-unlock if a verified PIN is already in this session
  useEffect(() => {
    const saved = sessionStorage.getItem(PIN_KEY);
    if (saved) {
      setPin(saved);
      setUnlocked(true);
    }
  }, []);

  const verify = async () => {
    setChecking(true);
    setPinError(false);
    try {
      const res = await fetch("/api/admin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        sessionStorage.setItem(PIN_KEY, pin);
        setUnlocked(true);
      } else {
        setPinError(true);
      }
    } catch {
      setPinError(true);
    } finally {
      setChecking(false);
    }
  };

  if (!unlocked) {
    return (
      <main className="flex min-h-screen flex-col gap-4 p-4">
        <Link href="/" className="text-sm font-medium text-brand">
          ← Home
        </Link>
        <div className="mx-auto mt-20 w-full max-w-xs text-center">
          <div className="text-4xl">🔒</div>
          <h1 className="mt-2 text-xl font-bold text-brand">Admin</h1>
          <p className="mb-4 text-sm text-slate-500">Enter the booth PIN</p>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && verify()}
            type="password"
            inputMode="numeric"
            placeholder="••••"
            className={`w-full rounded-xl border px-4 py-3 text-center text-2xl tracking-widest outline-none focus:border-brand ${
              pinError ? "border-rose-400" : "border-slate-300"
            }`}
          />
          {pinError && <p className="mt-2 text-sm text-rose-600">Wrong PIN.</p>}
          <button onClick={verify} disabled={checking || !pin} className="btn btn-primary mt-4 w-full disabled:opacity-50">
            {checking ? "Checking…" : "Unlock"}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col gap-5 p-4">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-sm font-medium text-brand">
          ← Home
        </Link>
        <h1 className="text-lg font-bold text-brand">Admin</h1>
        <button
          onClick={() => {
            sessionStorage.removeItem(PIN_KEY);
            setUnlocked(false);
            setPin("");
          }}
          className="text-sm text-slate-500"
        >
          Lock
        </button>
      </header>

      <Link
        href="/admin/labels"
        className="flex items-center gap-4 rounded-2xl border border-brand bg-brand p-5 text-white shadow-sm active:scale-[0.99]"
      >
        <span className="text-3xl">🏷️</span>
        <span>
          <span className="block text-lg font-semibold">QR Label Sheet</span>
          <span className="block text-sm text-blue-100">
            Print one sticker per physical piece
          </span>
        </span>
      </Link>

      <Link
        href="/admin/cartons"
        className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm active:scale-[0.99]"
      >
        <span className="text-3xl">📦</span>
        <span>
          <span className="block text-lg font-semibold">Carton QR Labels</span>
          <span className="block text-sm text-slate-500">
            Print box labels with QR + contents list
          </span>
        </span>
      </Link>

      <PriceReview pin={pin} />
      <PriceSetter pin={pin} />
    </main>
  );
}

type PriceStyle = {
  style_code: string; name: string; min_price: number; max_price: number;
  variants: number; pieces: number; sizes: { sku: string; size: string; price: number; qty: number }[];
};

// Catches data-entry price slips (a shirt priced ₹2/₹3/₹4). Lists each style,
// shows the wrong prices, and lets staff push one correct price to all its sizes.
function PriceReview({ pin }: { pin: string }) {
  const [styles, setStyles] = useState<PriceStyle[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/admin/price-review", { cache: "no-store" });
      const d = await res.json();
      setStyles(d.styles || []);
    } catch {
      setErr("Couldn't load price review.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async (style: string) => {
    const price = Number(drafts[style]);
    if (!Number.isFinite(price) || price <= 0) { setErr("Enter a valid price for " + style); return; }
    setSaving(style);
    setErr(null);
    try {
      const res = await fetch("/api/admin/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, style, price }),
      });
      if (!res.ok) {
        const e = await res.json();
        setErr(e.error === "bad_pin" ? "PIN rejected — re-unlock." : "Save failed.");
        return;
      }
      setStyles((list) => list.filter((s) => s.style_code !== style));
    } catch {
      setErr("Network error — try again.");
    } finally {
      setSaving(null);
    }
  };

  if (loading) return null;
  if (styles.length === 0) return null; // nothing wrong → don't clutter admin

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        ⚠ Price review ({styles.length} look wrong)
      </h2>
      <p className="-mt-1 text-xs text-slate-400">
        These styles have a price under ₹100 — almost certainly a typo. Set the right price for all sizes.
      </p>
      {err && <div className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">{err}</div>}

      {styles.map((s) => (
        <div key={s.style_code} className="rounded-2xl border border-rose-300 bg-white p-3 shadow-sm">
          <p className="font-semibold">{s.name}</p>
          <p className="text-xs text-slate-400">{s.style_code} · {s.pieces} pcs</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {s.sizes.map((z) => (
              <span key={z.sku} className="rounded-lg bg-rose-50 px-2 py-0.5 text-xs">
                {z.size} <b className="text-rose-700">{money(z.price)}</b>
              </span>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-slate-400">₹</span>
            <input
              value={drafts[s.style_code] ?? ""}
              onChange={(e) =>
                /^\d*\.?\d*$/.test(e.target.value) &&
                setDrafts((d) => ({ ...d, [s.style_code]: e.target.value }))
              }
              inputMode="decimal"
              placeholder="new price"
              className="w-28 rounded-xl border border-slate-300 px-3 py-2 text-right outline-none focus:border-brand"
            />
            <button
              onClick={() => save(s.style_code)}
              disabled={saving === s.style_code}
              className="btn btn-primary ml-auto px-5 py-2 disabled:opacity-50"
            >
              {saving === s.style_code ? "Saving…" : `Set all ${s.variants}`}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function PriceSetter({ pin }: { pin: string }) {
  const [items, setItems] = useState<Variant[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingSku, setSavingSku] = useState<string | null>(null);
  const [doneSkus, setDoneSkus] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/stock", { cache: "no-store" });
      const rows: Variant[] = await res.json();
      setItems(rows.filter((r) => r.needs_price));
    } catch {
      setErr("Couldn't load variants.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const save = async (sku: string) => {
    const price = Number(drafts[sku]);
    if (!Number.isFinite(price) || price <= 0) {
      setErr("Enter a valid price for " + sku);
      return;
    }
    setSavingSku(sku);
    setErr(null);
    try {
      const res = await fetch("/api/admin/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, sku, price }),
      });
      if (!res.ok) {
        const e = await res.json();
        setErr(e.error === "bad_pin" ? "PIN rejected — re-unlock." : "Save failed.");
        return;
      }
      setDoneSkus((d) => [...d, sku]);
      setItems((list) => list.filter((v) => v.variant_sku !== sku));
    } catch {
      setErr("Network error — try again.");
    } finally {
      setSavingSku(null);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Set prices ({items.length} need a price)
      </h2>

      {err && (
        <div className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">
          {err}
        </div>
      )}

      {loading ? (
        <p className="py-6 text-center text-sm text-slate-400">Loading…</p>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-emerald-300 bg-emerald-50 p-6 text-center text-sm text-emerald-700">
          ✅ All variants have a confirmed price.
          {doneSkus.length > 0 && ` Saved ${doneSkus.length} just now.`}
        </p>
      ) : (
        items.map((v) => (
          <div
            key={v.variant_sku}
            className="rounded-2xl border border-amber-300 bg-white p-3 shadow-sm"
          >
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <p className="truncate font-semibold">
                  {v.name} · {v.size}
                </p>
                <p className="text-xs text-slate-400">
                  {v.variant_sku} · {v.qty_on_hand} in stock
                </p>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="text-slate-400">₹</span>
              <input
                value={drafts[v.variant_sku] ?? ""}
                onChange={(e) =>
                  /^\d*\.?\d*$/.test(e.target.value) &&
                  setDrafts((d) => ({ ...d, [v.variant_sku]: e.target.value }))
                }
                inputMode="decimal"
                placeholder="price"
                className="w-28 rounded-xl border border-slate-300 px-3 py-2 text-right outline-none focus:border-brand"
              />
              <button
                onClick={() => save(v.variant_sku)}
                disabled={savingSku === v.variant_sku}
                className="btn btn-primary ml-auto px-5 py-2 disabled:opacity-50"
              >
                {savingSku === v.variant_sku ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
