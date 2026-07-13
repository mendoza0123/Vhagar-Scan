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

      <PriceSetter pin={pin} />
    </main>
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
