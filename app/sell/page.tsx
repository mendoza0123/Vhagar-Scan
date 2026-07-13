"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { money } from "@/lib/format";

// Scanner is client-only (camera). ssr:false keeps html5-qrcode off the server.
const Scanner = dynamic(() => import("./Scanner"), { ssr: false });

type Variant = {
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

type Line = {
  sku: string;
  name: string;
  size: string;
  color: string | null;
  listedPrice: number;
  price: string; // editable; kept as string so partial typing works
  qty: number;
  needs_price: boolean;
  qty_on_hand: number;
};

type Receipt = {
  id: number;
  bill_no: string;
  lines: Line[];
  subtotal: number;
  discount: number;
  total: number;
};

const CART_KEY = "vhagar.cart.v2";
const DISCOUNT_KEY = "vhagar.discount.v2";
const SOLDBY_KEY = "vhagar.soldBy.v1";

// ---- per-line blocking reason (null = ok to bill) ----
function lineBlock(l: Line): string | null {
  const p = Number(l.price);
  if (l.qty_on_hand <= 0) return "Out of stock";
  if (l.qty > l.qty_on_hand) return `Only ${l.qty_on_hand} in stock`;
  if (l.needs_price && (l.price === "" || p <= 0)) return "Confirm a price";
  if (!Number.isFinite(p) || p < 0) return "Enter a valid price";
  return null;
}

// Short beep + buzz so staff get feedback without looking at the screen.
function feedback(ok: boolean) {
  try {
    navigator.vibrate?.(ok ? 30 : [40, 40, 40]);
  } catch {
    /* noop */
  }
  try {
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as
      | typeof AudioContext
      | undefined;
    if (!Ctx) return;
    const ac = new Ctx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.frequency.value = ok ? 880 : 220;
    gain.gain.setValueAtTime(0.0001, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.16);
    osc.start();
    osc.stop(ac.currentTime + 0.17);
    osc.onended = () => ac.close();
  } catch {
    /* noop */
  }
}

export default function SellPage() {
  const [scanning, setScanning] = useState(false);
  const [cart, setCart] = useState<Line[]>([]);
  const [discount, setDiscount] = useState<string>("0");
  const [soldBy, setSoldBy] = useState<string>("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [payment, setPayment] = useState<"cash" | "card" | "upi" | "other">("cash");
  const [channel, setChannel] = useState("Exhibition");
  const [channelOther, setChannelOther] = useState("");
  const [preview, setPreview] = useState(false);
  const saleChannel = channel === "Other" ? channelOther.trim() || "Other" : channel;
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "warn" } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Variant[]>([]);
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState<"idle" | "checking" | "submitting">("idle");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Per-code scan state. A QR tag held in front of the camera fires the decode
  // callback ~10×/sec; we add it ONCE per presentation, then re-arm that code
  // only after it leaves the frame (a gap with no detections) so the same
  // physical tag can't pile up multiple times.
  const scanState = useRef<Map<string, { lastSeen: number; armed: boolean }>>(new Map());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- restore cart from localStorage (survive refresh / flaky reload) ----
  useEffect(() => {
    try {
      const c = localStorage.getItem(CART_KEY);
      if (c) setCart(JSON.parse(c));
      const d = localStorage.getItem(DISCOUNT_KEY);
      if (d) setDiscount(d);
      const s = localStorage.getItem(SOLDBY_KEY);
      if (s) setSoldBy(s);
    } catch {
      /* ignore corrupt storage */
    }
    setHydrated(true);
  }, []);

  // ---- persist ----
  useEffect(() => {
    if (hydrated) localStorage.setItem(CART_KEY, JSON.stringify(cart));
  }, [cart, hydrated]);
  useEffect(() => {
    if (hydrated) localStorage.setItem(DISCOUNT_KEY, discount);
  }, [discount, hydrated]);
  useEffect(() => {
    if (hydrated) localStorage.setItem(SOLDBY_KEY, soldBy);
  }, [soldBy, hydrated]);

  const showToast = useCallback((msg: string, tone: "ok" | "warn" = "ok") => {
    setToast({ msg, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // ---- add a variant (from scan or search) ----
  const addVariant = useCallback(
    (v: Variant) => {
      setCart((prev) => {
        const i = prev.findIndex((l) => l.sku === v.variant_sku);
        if (i >= 0) {
          const next = [...prev];
          next[i] = { ...next[i], qty: next[i].qty + 1, qty_on_hand: v.qty_on_hand };
          return next;
        }
        return [
          ...prev,
          {
            sku: v.variant_sku,
            name: v.name,
            size: v.size,
            color: v.color,
            listedPrice: v.price,
            price: v.needs_price ? "" : String(v.price),
            qty: 1,
            needs_price: v.needs_price,
            qty_on_hand: v.qty_on_hand,
          },
        ];
      });
      setError(null);
    },
    []
  );

  // ---- look up a scanned/typed SKU and add it ----
  const lookupAndAdd = useCallback(
    async (rawSku: string) => {
      const sku = rawSku.trim().toUpperCase();
      if (!sku) return;
      if (/CTN-?\d/i.test(sku)) {
        // bare carton id OR the IMS carton-URL QR — either way, not a garment
        feedback(false);
        showToast("That's a carton — open Find in Cartons", "warn");
        return;
      }
      try {
        const res = await fetch(`/api/variants/${encodeURIComponent(sku)}`);
        if (res.status === 404) {
          feedback(false);
          showToast(`Unknown tag: ${sku}`, "warn");
          return;
        }
        if (!res.ok) throw new Error("lookup failed");
        const v: Variant = await res.json();
        addVariant(v);
        feedback(true);
        showToast(
          `Added ${v.name} · ${v.size}${v.qty_on_hand <= 0 ? " (out of stock!)" : ""}`,
          v.qty_on_hand <= 0 ? "warn" : "ok"
        );
      } catch {
        feedback(false);
        showToast("Network error — tag not added, try again", "warn");
      }
    },
    [addVariant, showToast]
  );

  // ---- scan handler: one add per tag presentation ----
  const REARM_GAP_MS = 800; // tag must be away this long before it counts again
  const onScan = useCallback(
    (text: string) => {
      const code = text.trim();
      if (!code) return;
      const now = Date.now();
      const st = scanState.current.get(code) || { lastSeen: 0, armed: true };
      // Absent for a while → this is a fresh presentation of the tag.
      if (now - st.lastSeen > REARM_GAP_MS) st.armed = true;
      st.lastSeen = now;
      if (st.armed) {
        st.armed = false; // consume this presentation; ignore continuous re-reads
        scanState.current.set(code, st);
        lookupAndAdd(code);
      } else {
        scanState.current.set(code, st);
      }
    },
    [lookupAndAdd]
  );

  // ---- manual search (debounced) ----
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/variants?q=${encodeURIComponent(q)}`);
        setResults(res.ok ? await res.json() : []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  // ---- cart mutations ----
  const setQty = (sku: string, qty: number) =>
    setCart((prev) =>
      qty <= 0
        ? prev.filter((l) => l.sku !== sku)
        : prev.map((l) => (l.sku === sku ? { ...l, qty } : l))
    );
  const setPrice = (sku: string, price: string) => {
    if (price !== "" && !/^\d*\.?\d*$/.test(price)) return; // digits + one dot
    setCart((prev) => prev.map((l) => (l.sku === sku ? { ...l, price } : l)));
  };
  const removeLine = (sku: string) => setCart((prev) => prev.filter((l) => l.sku !== sku));
  const clearCart = () => {
    setCart([]);
    setDiscount("0");
    setError(null);
  };

  // ---- totals ----
  const subtotal = useMemo(
    () => cart.reduce((s, l) => s + (Number(l.price) || 0) * l.qty, 0),
    [cart]
  );
  const discountNum = Math.min(Math.max(0, Number(discount) || 0), subtotal);
  const total = Math.max(0, subtotal - discountNum);
  const blockingLines = cart.filter((l) => lineBlock(l) !== null);
  const canCheckout = cart.length > 0 && blockingLines.length === 0 && status === "idle";

  // ---- checkout: re-check stock, then process_sale ----
  const checkout = async () => {
    if (cart.length === 0) return;
    setPreview(false);
    setError(null);
    setStatus("checking");

    // freshen stock for the cart so we catch other-device sales before posting
    try {
      const skus = cart.map((l) => l.sku).join(",");
      const res = await fetch(`/api/stock?skus=${encodeURIComponent(skus)}`);
      if (res.ok) {
        const fresh: { variant_sku: string; qty_on_hand: number }[] = await res.json();
        const bySku = new Map(fresh.map((r) => [r.variant_sku, r.qty_on_hand]));
        setCart((prev) =>
          prev.map((l) => ({ ...l, qty_on_hand: bySku.get(l.sku) ?? l.qty_on_hand }))
        );
        const short = cart.filter((l) => l.qty > (bySku.get(l.sku) ?? l.qty_on_hand));
        if (short.length > 0) {
          setStatus("idle");
          setError("Stock changed — some lines now exceed what's available. Adjust and retry.");
          feedback(false);
          return;
        }
      }
    } catch {
      // offline re-check failed; process_sale is still the hard guard, so continue
    }

    setStatus("submitting");
    const snapshot = cart.map((l) => ({ ...l }));
    const body = {
      items: cart.map((l) => ({ sku: l.sku, qty: l.qty, price: Number(l.price) })),
      discount: discountNum,
      soldBy: soldBy.trim() || null,
      paymentMethod: payment,
      channel: saleChannel,
      customer: { name: name.trim() || null, phone: phone.trim() || null, address: address.trim() || null },
    };

    try {
      const res = await fetch("/api/sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (res.status === 409 && data.error === "oversell") {
        // surface which lines are short; keep the cart intact
        const bySku = new Map<string, number>(
          (data.stock || []).map((r: any) => [r.variant_sku, r.qty_on_hand])
        );
        setCart((prev) =>
          prev.map((l) => ({ ...l, qty_on_hand: bySku.get(l.sku) ?? l.qty_on_hand }))
        );
        setError(data.message || "Not enough stock — adjust and retry.");
        feedback(false);
        setStatus("idle");
        return;
      }
      if (!res.ok) {
        setError(data.message || "Checkout failed. Please try again.");
        feedback(false);
        setStatus("idle");
        return;
      }

      // success
      setReceipt({
        id: data.id,
        bill_no: data.bill_no,
        lines: snapshot,
        subtotal,
        discount: discountNum,
        total,
      });
      feedback(true);
      clearCart();
      setName("");
      setPhone("");
      setAddress("");
      setPayment("cash");
      setChannel("Exhibition");
      setChannelOther("");
      setStatus("idle");
    } catch {
      // network failure — DO NOT lose the cart; let them retry
      setError("Couldn't reach the server. Cart kept — check signal and retry.");
      feedback(false);
      setStatus("idle");
    }
  };

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4 pb-32">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-sm font-medium text-brand">
          ← Home
        </Link>
        <h1 className="text-lg font-bold text-brand">Scan &amp; Sell</h1>
        <Link href="/stock" className="text-sm text-slate-500">
          Stock
        </Link>
      </header>

      {/* ---- scanner ---- */}
      <section>
        {scanning ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <Scanner onScan={onScan} />
            <button onClick={() => setScanning(false)} className="btn btn-ghost mt-3 w-full">
              ⏹ Stop camera
            </button>
          </div>
        ) : (
          <button onClick={() => setScanning(true)} className="btn btn-primary w-full py-6 text-lg">
            📷 Start camera
          </button>
        )}
      </section>

      {/* ---- manual search ---- */}
      <section className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or SKU (tag won't scan?)"
          className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-brand"
        />
        {searching && <p className="px-1 pt-2 text-xs text-slate-400">Searching…</p>}
        {results.length > 0 && (
          <ul className="mt-2 max-h-64 divide-y divide-slate-100 overflow-auto">
            {results.map((v) => (
              <li key={v.variant_sku}>
                <button
                  onClick={() => {
                    addVariant(v);
                    showToast(`Added ${v.name} · ${v.size}`);
                    setQuery("");
                    setResults([]);
                  }}
                  className="flex w-full items-center justify-between gap-2 py-3 text-left active:bg-slate-50"
                >
                  <span>
                    <span className="block text-sm font-medium">
                      {v.name} · {v.size}
                    </span>
                    <span className="block text-xs text-slate-400">
                      {v.variant_sku} · {v.qty_on_hand} in stock
                    </span>
                  </span>
                  <span className="text-sm font-semibold text-slate-600">
                    {v.needs_price ? "—" : money(v.price)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- cart ---- */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Cart ({cart.reduce((n, l) => n + l.qty, 0)})
          </h2>
          {cart.length > 0 && (
            <button onClick={clearCart} className="text-xs text-slate-400 underline">
              Clear
            </button>
          )}
        </div>

        {cart.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
            Scan a tag or search to add items.
          </p>
        ) : (
          cart.map((l) => {
            const block = lineBlock(l);
            return (
              <div
                key={l.sku}
                className={`rounded-2xl border bg-white p-3 shadow-sm ${
                  block ? "border-rose-300" : "border-slate-200"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{l.name}</p>
                    <p className="text-xs text-slate-400">
                      {l.size}
                      {l.color ? ` · ${l.color}` : ""} · {l.sku}
                    </p>
                  </div>
                  <button
                    onClick={() => removeLine(l.sku)}
                    className="shrink-0 rounded-lg px-2 py-1 text-slate-400 active:bg-slate-100"
                    aria-label="Remove"
                  >
                    ✕
                  </button>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3">
                  {/* qty stepper */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setQty(l.sku, l.qty - 1)}
                      className="h-10 w-10 rounded-xl border border-slate-300 text-xl font-bold active:bg-slate-100"
                    >
                      −
                    </button>
                    <span className="w-8 text-center text-lg font-semibold">{l.qty}</span>
                    <button
                      onClick={() => setQty(l.sku, l.qty + 1)}
                      className="h-10 w-10 rounded-xl border border-slate-300 text-xl font-bold active:bg-slate-100"
                    >
                      +
                    </button>
                  </div>

                  {/* editable price */}
                  <div className="flex items-center gap-1">
                    <span className="text-slate-400">₹</span>
                    <input
                      value={l.price}
                      onChange={(e) => setPrice(l.sku, e.target.value)}
                      inputMode="decimal"
                      placeholder={l.needs_price ? "set price" : String(l.listedPrice)}
                      className={`w-24 rounded-xl border px-3 py-2 text-right text-base outline-none focus:border-brand ${
                        l.needs_price && (l.price === "" || Number(l.price) <= 0)
                          ? "border-amber-400 bg-amber-50"
                          : "border-slate-300"
                      }`}
                    />
                  </div>
                </div>

                <div className="mt-2 flex items-center justify-between">
                  {block ? (
                    <span className="rounded-md bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
                      ⚠ {block}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">
                      {l.qty_on_hand} in stock
                      {l.needs_price ? " · price confirmed" : ""}
                    </span>
                  )}
                  <span className="text-sm font-semibold">
                    {money((Number(l.price) || 0) * l.qty)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </section>

      {/* ---- customer + payment (captured at the booth) ---- */}
      {cart.length > 0 && (
        <section className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Point of sale</p>
          <div className="grid grid-cols-4 gap-2">
            {["Exhibition", "Shopify", "Flipkart", "Other"].map((c) => (
              <button
                key={c}
                onClick={() => setChannel(c)}
                className={`rounded-xl border px-2 py-2 text-sm font-medium ${channel === c ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}
              >
                {c}
              </button>
            ))}
          </div>
          {channel === "Other" && (
            <input value={channelOther} onChange={(e) => setChannelOther(e.target.value)} placeholder="Type channel" className="rounded-xl border border-slate-300 px-4 py-2.5 text-base outline-none focus:border-brand" />
          )}

          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Customer &amp; payment</p>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="rounded-xl border border-slate-300 px-4 py-2.5 text-base outline-none focus:border-brand" />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Mobile no." className="rounded-xl border border-slate-300 px-4 py-2.5 text-base outline-none focus:border-brand" />
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Address (optional)" className="rounded-xl border border-slate-300 px-4 py-2.5 text-base outline-none focus:border-brand" />
          <div className="grid grid-cols-4 gap-2 pt-1">
            {(["cash", "card", "upi", "other"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPayment(p)}
                className={`rounded-xl border px-2 py-2 text-sm font-medium ${payment === p ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}
              >
                {{ cash: "Cash", card: "Card", upi: "UPI", other: "Other" }[p]}
              </button>
            ))}
          </div>
          <input
            value={soldBy}
            onChange={(e) => setSoldBy(e.target.value)}
            placeholder="Sold by (optional)"
            className="mt-1 rounded-xl border border-slate-200 px-4 py-2 text-sm outline-none focus:border-brand"
          />
        </section>
      )}

      {/* ---- error banner ---- */}
      {error && (
        <div className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {/* ---- toast ---- */}
      {toast && (
        <div
          className={`fixed left-1/2 top-4 z-40 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-medium shadow-lg ${
            toast.tone === "ok" ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* ---- sticky checkout bar ---- */}
      {cart.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md border-t border-slate-200 bg-white/95 p-3 backdrop-blur">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-slate-500">Subtotal</span>
            <span className="font-medium">{money(subtotal)}</span>
          </div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-slate-500">Discount</span>
            <div className="flex items-center gap-1">
              <span className="text-slate-400">₹</span>
              <input
                value={discount}
                onChange={(e) =>
                  /^\d*\.?\d*$/.test(e.target.value) && setDiscount(e.target.value)
                }
                inputMode="decimal"
                className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-right outline-none focus:border-brand"
              />
            </div>
          </div>
          <div className="mb-3 flex items-center justify-between text-lg font-bold">
            <span>Total</span>
            <span>{money(total)}</span>
          </div>
          <button
            onClick={() => setPreview(true)}
            disabled={!canCheckout}
            className="btn btn-primary w-full py-4 text-lg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "submitting"
              ? "Processing…"
              : status === "checking"
              ? "Checking stock…"
              : blockingLines.length > 0
              ? `Fix ${blockingLines.length} item${blockingLines.length > 1 ? "s" : ""}`
              : `Review & charge ${money(total)}`}
          </button>
        </div>
      )}

      {/* ---- charge preview (confirm details before the sale) ---- */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
          onClick={() => setPreview(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-auto rounded-t-3xl bg-white p-5 sm:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-brand">Confirm sale</h2>
            <div className="mt-3 divide-y divide-slate-100 border-y border-slate-100">
              {cart.map((l) => (
                <div key={l.sku} className="flex items-center justify-between py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{l.name} · {l.size}</span>
                    <span className="text-xs text-slate-400">{l.qty} × {money(Number(l.price) || 0)}</span>
                  </span>
                  <span className="font-semibold">{money((Number(l.price) || 0) * l.qty)}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-1 text-sm">
              <Row label="Subtotal" value={money(subtotal)} />
              {discountNum > 0 && <Row label="Discount" value={`− ${money(discountNum)}`} />}
              <div className="flex justify-between pt-1 text-lg font-bold">
                <span>Total</span>
                <span>{money(total)}</span>
              </div>
            </div>
            <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
              <p><b>Point of sale:</b> {saleChannel}</p>
              <p><b>Payment:</b> {{ cash: "Cash", card: "Card", upi: "UPI", other: "Other" }[payment]}</p>
              {name && <p><b>Name:</b> {name}</p>}
              {phone && <p><b>Mobile:</b> {phone}</p>}
              {address && <p><b>Address:</b> {address}</p>}
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button onClick={() => setPreview(false)} className="btn btn-ghost">← Back</button>
              <button onClick={checkout} className="btn btn-primary">✓ Confirm &amp; charge</button>
            </div>
          </div>
        </div>
      )}

      {/* ---- receipt overlay ---- */}
      {receipt && <ReceiptOverlay receipt={receipt} onClose={() => setReceipt(null)} />}
    </main>
  );
}

// ---------- receipt overlay ----------
function ReceiptOverlay({ receipt, onClose }: { receipt: Receipt; onClose: () => void }) {
  const share = async () => {
    const lines = receipt.lines
      .map((l) => `${l.qty}× ${l.name} ${l.size} — ${money((Number(l.price) || 0) * l.qty)}`)
      .join("\n");
    const text = `Vhagar Clothing\nBill ${receipt.bill_no}\n${lines}\n\nTotal: ${money(
      receipt.total
    )} (Cash)`;
    try {
      if (navigator.share) await navigator.share({ title: receipt.bill_no, text });
      else {
        await navigator.clipboard.writeText(text);
        alert("Bill copied to clipboard");
      }
    } catch {
      /* user cancelled */
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-auto rounded-t-3xl bg-white p-5 sm:rounded-3xl">
        <div className="mb-3 text-center">
          <div className="text-3xl">✅</div>
          <h2 className="text-xl font-bold text-brand">Sale complete</h2>
          <p className="text-sm text-slate-500">{receipt.bill_no}</p>
        </div>

        <div className="divide-y divide-slate-100 border-y border-slate-100">
          {receipt.lines.map((l) => (
            <div key={l.sku} className="flex items-center justify-between py-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {l.name} · {l.size}
                </span>
                <span className="text-xs text-slate-400">
                  {l.qty} × {money(Number(l.price) || 0)}
                </span>
              </span>
              <span className="font-semibold">{money((Number(l.price) || 0) * l.qty)}</span>
            </div>
          ))}
        </div>

        <div className="mt-3 space-y-1 text-sm">
          <Row label="Subtotal" value={money(receipt.subtotal)} />
          {receipt.discount > 0 && <Row label="Discount" value={`− ${money(receipt.discount)}`} />}
          <div className="flex justify-between pt-1 text-lg font-bold">
            <span>Total</span>
            <span>{money(receipt.total)}</span>
          </div>
          <p className="text-right text-xs text-slate-400">Cash</p>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2">
          <Link href={`/sale/${receipt.id}`} className="btn btn-ghost col-span-2 text-center">
            🖨 View / Print bill
          </Link>
          <button onClick={share} className="btn btn-ghost">
            Share
          </button>
          <button onClick={onClose} className="btn btn-primary">
            ＋ New sale
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-slate-600">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
