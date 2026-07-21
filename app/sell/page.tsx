"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { money } from "@/lib/format";
import { normalizePhone } from "@/lib/phone";

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
// Offer 4 (mystery envelope) result, written by /reward. Survives refresh; a
// checkout or removing the offer consumes it. Same literal in app/reward/page.tsx.
const REWARD_KEY = "vhagar.reward.v1";
const OFFER4_MIN = 4999;
const CAP_MIN = 2499; // free cap on bills of ₹2,499+ (poster)

// The cart persists in localStorage so a flaky-network refresh never loses a
// sale. Flip side: a customer walks off, the browser gets minimized/closed, and
// the next customer's scan lands on top of the old cart. So cart activity is
// timestamped, and coming back after STALE_MS of inactivity starts a FRESH bill
// — the old cart is stashed (never deleted) behind an Undo banner.
const TOUCHED_KEY = "vhagar.cart.touchedAt";
const STASH_KEY = "vhagar.cart.stash.v1";
const STALE_MS = 90_000;

// Freebie options — each can be given in a quantity via +/- on the sell screen.
const FREEBIE_OPTIONS = ["Cap", "Key Chain"] as const;
const NO_FREEBIES: Record<string, number> = { Cap: 0, "Key Chain": 0 };

// "Sold by" is WHO CLOSED THE SALE — deliberately separate from the gate login
// (that's who unlocked the device; the two aren't always the same person).
// These are the standing names; /api/staff adds every name already billed, so
// anything entered via "Others…" joins the list for good.
const BASE_STAFF = ["Aditya", "Naushi", "Angel"];
const OTHER = "__other__";

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
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  // Offers (poster v2): Buy 2/3/4 = 20/30/40% off applies AUTOMATICALLY —
  // tierDismissed is the staff escape hatch. Mystery envelope is unchanged.
  const [tierDismissed, setTierDismissed] = useState(false);
  const [reward, setReward] = useState<number | null>(null); // Mystery amount won
  // free keychain rides along on every purchase — auto-added once per sale
  const keychainAuto = useRef(false);
  const capAuto = useRef(false); // did WE auto-add the ₹2,499+ cap?
  const [cart, setCart] = useState<Line[]>([]);
  // pieces set aside by the stale-cart guard, shown in the Undo banner
  const [staleCount, setStaleCount] = useState<number | null>(null);
  const cartRef = useRef<Line[]>([]);
  const discountRef = useRef("0");
  const [discount, setDiscount] = useState<string>("0");
  const [soldBy, setSoldBy] = useState<string>("");
  const [staffList, setStaffList] = useState<string[]>(BASE_STAFF);
  const [isOther, setIsOther] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  // ONE payment method per bill (owner call) — picking one drops the others.
  // UPI is the booth default.
  const [payments, setPayments] = useState<string[]>(["upi"]);
  const PM_LABEL: Record<string, string> = { cash: "Cash", card: "Card", upi: "UPI", other: "Other" };
  const togglePayment = (p: string) => setPayments([p]);
  const paymentStr = payments.map((p) => PM_LABEL[p]).join(" + ");
  const [channel, setChannel] = useState("Exhibition");
  const [channelOther, setChannelOther] = useState("");
  const [freebieCounts, setFreebieCounts] = useState<Record<string, number>>({ ...NO_FREEBIES });
  const [preview, setPreview] = useState(false);
  const saleChannel = channel === "Other" ? channelOther.trim() || "Other" : channel;
  // stored as "Cap x2 + Kitchen x1" (only counts > 0); null when none given
  const freebieStr =
    FREEBIE_OPTIONS.filter((f) => (freebieCounts[f] || 0) > 0)
      .map((f) => `${f} x${freebieCounts[f]}`)
      .join(" + ") || null;
  const bumpFreebie = (f: string, d: number) =>
    setFreebieCounts((c) => ({ ...c, [f]: Math.max(0, (c[f] || 0) + d) }));
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
  // Cold-reopen path of the stale guard: if the saved cart has been idle past
  // STALE_MS, it belonged to a customer who left — stash it and start clean.
  useEffect(() => {
    try {
      const c = localStorage.getItem(CART_KEY);
      const saved: Line[] = c ? JSON.parse(c) : [];
      const touched = Number(localStorage.getItem(TOUCHED_KEY) || 0);
      const isStale = saved.length > 0 && touched > 0 && Date.now() - touched > STALE_MS;

      if (isStale) {
        localStorage.setItem(STASH_KEY, JSON.stringify({
          cart: saved,
          discount: localStorage.getItem(DISCOUNT_KEY) || "0",
        }));
        localStorage.removeItem(CART_KEY);
        localStorage.removeItem(DISCOUNT_KEY);
        localStorage.removeItem(REWARD_KEY); // the envelope was that bill's
      } else {
        if (saved.length) setCart(saved);
        const d = localStorage.getItem(DISCOUNT_KEY);
        if (d) setDiscount(d);
        const r = localStorage.getItem(REWARD_KEY); // back from /reward
        if (r) {
          const j = JSON.parse(r);
          if (j?.amount) setReward(Number(j.amount));
        }
      }

      // an unactioned stash (from this visit or an earlier one) shows the banner
      const st = localStorage.getItem(STASH_KEY);
      if (st) {
        const j = JSON.parse(st);
        setStaleCount((j.cart || []).reduce((n: number, l: Line) => n + (l.qty || 0), 0));
      }

      const s = localStorage.getItem(SOLDBY_KEY);
      if (s) setSoldBy(s);
    } catch {
      /* ignore corrupt storage */
    }
    setHydrated(true);
  }, []);

  // Live-tab path: the booth was minimized/backgrounded and comes back after
  // the cart went idle — same rule, same stash, same Undo.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const touched = Number(localStorage.getItem(TOUCHED_KEY) || 0);
      if (cartRef.current.length === 0 || !touched || Date.now() - touched <= STALE_MS) return;
      const stash = { cart: cartRef.current, discount: discountRef.current };
      try { localStorage.setItem(STASH_KEY, JSON.stringify(stash)); } catch { /* noop */ }
      setCart([]);
      setDiscount("0");
      setFreebieCounts({ ...NO_FREEBIES });
      setTierDismissed(false);
      keychainAuto.current = false;
      capAuto.current = false;
      clearReward();
      setStaleCount(stash.cart.reduce((n, l) => n + l.qty, 0));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- persist (and stamp cart activity for the stale guard) ----
  useEffect(() => {
    cartRef.current = cart;
    if (!hydrated) return;
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    if (cart.length) localStorage.setItem(TOUCHED_KEY, String(Date.now()));
    else localStorage.removeItem(TOUCHED_KEY);
  }, [cart, hydrated]);
  useEffect(() => {
    discountRef.current = discount;
    if (hydrated) localStorage.setItem(DISCOUNT_KEY, discount);
  }, [discount, hydrated]);
  useEffect(() => {
    if (hydrated) localStorage.setItem(SOLDBY_KEY, soldBy);
  }, [soldBy, hydrated]);

  // Names already billed join the dropdown. Falls back to BASE_STAFF on a dead
  // hotspot, so the picker always works.
  useEffect(() => {
    let live = true;
    fetch("/api/staff")
      .then((r) => (r.ok ? r.json() : { names: [] }))
      .then((d) => {
        if (live) setStaffList([...new Set([...BASE_STAFF, ...(d.names || [])])].sort());
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);

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

  // ---- stale-cart stash: restore (merged into whatever's scanned) / dismiss ----
  const restoreStash = () => {
    try {
      const st = localStorage.getItem(STASH_KEY);
      if (st) {
        const j = JSON.parse(st) as { cart: Line[]; discount?: string };
        setCart((prev) => {
          const bySku = new Map(prev.map((l) => [l.sku, { ...l }]));
          for (const l of j.cart || []) {
            const e = bySku.get(l.sku);
            if (e) e.qty += l.qty;
            else bySku.set(l.sku, l);
          }
          return Array.from(bySku.values());
        });
        if (j.discount && j.discount !== "0") setDiscount(j.discount);
        localStorage.removeItem(STASH_KEY);
        showToast("Previous cart restored");
      }
    } catch { /* corrupt stash — nothing to restore */ }
    setStaleCount(null);
  };
  const dismissStash = () => {
    try { localStorage.removeItem(STASH_KEY); } catch { /* noop */ }
    setStaleCount(null);
  };

  // ---- totals ----
  const subtotal = useMemo(
    () => cart.reduce((s, l) => s + (Number(l.price) || 0) * l.qty, 0),
    [cart]
  );
  const pieces = useMemo(() => cart.reduce((n, l) => n + l.qty, 0), [cart]);

  // Buy 2 = 20% · Buy 3 = 30% · Buy 4+ = 40% — off the whole bill, automatic.
  const tierPct = pieces >= 4 ? 40 : pieces === 3 ? 30 : pieces === 2 ? 20 : 0;
  const tierAmt = Math.round((subtotal * tierPct) / 100);
  const offTier = !tierDismissed && tierPct > 0 ? tierAmt : 0;
  const offerDiscount = offTier + (reward || 0);

  // Final bill AFTER offers + manual discount. The free cap keys off this, not
  // the pre-discount subtotal, so a bill that drops under ₹2,499 once the Buy-2
  // discount lands doesn't get the cap.
  const discountNum = Math.min(Math.max(0, Number(discount) || 0), Math.max(0, subtotal - offerDiscount));
  const total = Math.max(0, subtotal - discountNum - offerDiscount);

  const clearReward = useCallback(() => {
    setReward(null);
    try { localStorage.removeItem(REWARD_KEY); } catch { /* noop */ }
  }, []);

  // free keychain on every purchase — auto-add ONCE per sale, but never fight
  // staff who deliberately set it back to 0
  useEffect(() => {
    if (pieces > 0 && !keychainAuto.current) {
      keychainAuto.current = true;
      setFreebieCounts((c) => ({ ...c, "Key Chain": Math.max(1, c["Key Chain"] || 0) }));
    }
    if (pieces === 0) keychainAuto.current = false;
  }, [pieces]);

  // free cap on bills of ₹2,499+ — auto-add ONE cap, and take back only the one
  // WE added if the bill drops under the line. A cap staff placed by hand is
  // never touched, and staff removing the auto one isn't fought either.
  useEffect(() => {
    if (total >= CAP_MIN && !capAuto.current) {
      setFreebieCounts((c) => {
        if (c.Cap) return c; // one's already on the bill — nothing to add
        capAuto.current = true;
        return { ...c, Cap: 1 };
      });
    } else if (total < CAP_MIN && capAuto.current) {
      capAuto.current = false;
      setFreebieCounts((c) => ({ ...c, Cap: Math.max(0, (c.Cap || 0) - 1) }));
    }
  }, [total]);
  useEffect(() => {
    if (reward && cart.length > 0 && subtotal < OFFER4_MIN) {
      clearReward();
      showToast("Bill dropped under ₹4,999 — mystery reward removed", "warn");
    }
  }, [reward, subtotal, cart.length, clearReward, showToast]);

  const blockingLines = cart.filter((l) => lineBlock(l) !== null);
  // Name + a REAL mobile are mandatory — 10 digits starting 6-9 (+91/0 ok),
  // so a 9-digit or 1-digit typo can't get billed.
  const phoneOk = normalizePhone(phone) !== null;
  const nameOk = name.trim().length >= 2;
  const customerOk = nameOk && phoneOk;
  const canCheckout =
    cart.length > 0 && blockingLines.length === 0 && customerOk && status === "idle";

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
    const offerParts: string[] = [];
    if (offTier > 0)
      offerParts.push(`Offer 1 (Buy ${Math.min(pieces, 4)}${pieces > 4 ? "+" : ""}: ${tierPct}% off: -₹${offTier})`);
    if (reward) offerParts.push(`Offer 2 (Mystery: -₹${reward})`);
    const body = {
      items: cart.map((l) => ({ sku: l.sku, qty: l.qty, price: Number(l.price) })),
      discount: discountNum + offerDiscount, // one figure on the bill; the split is in `offer`
      offer: offerParts.join(" + ") || null,
      soldBy: soldBy.trim() || null,
      paymentMethod: payments.join(" + "),
      channel: saleChannel,
      freebie: freebieStr,
      customer: { name: name.trim() || null, phone: normalizePhone(phone), email: email.trim() || null, address: address.trim() || null },
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
        discount: discountNum + offerDiscount,
        total,
      });
      feedback(true);
      setTierDismissed(false);
      clearReward(); // the envelope was for THIS bill
      // a name entered via "Others…" is now a real billed name — list it here
      // too, so it shows without waiting for a reload/refetch
      const sb = soldBy.trim();
      if (sb && !staffList.includes(sb)) setStaffList((prev) => [...new Set([...prev, sb])].sort());
      setIsOther(false);
      clearCart();
      setName("");
      setPhone("");
      setEmail("");
      setAddress("");
      setPayments(["upi"]);
      setChannel("Exhibition");
      setChannelOther("");
      setFreebieCounts({ ...NO_FREEBIES });
      setStatus("idle");
    } catch {
      // network failure — DO NOT lose the cart; let them retry
      setError("Couldn't reach the server. Cart kept — check signal and retry.");
      feedback(false);
      setStatus("idle");
    }
  };

  return (
    // pb-64 clears the ~190px sticky checkout bar so the last field is never buried
    <main className="flex min-h-screen flex-col gap-4 p-4 pb-64">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-sm font-medium text-brand">
          ← Home
        </Link>
        <h1 className="text-lg font-bold text-brand">Scan &amp; Sell</h1>
        <Link href="/stock" className="text-sm text-slate-500">
          Stock
        </Link>
      </header>

      {/* ---- stale-cart banner: the old bill was set aside, not deleted ---- */}
      {staleCount !== null && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          🧹 Started a fresh bill — the previous customer&apos;s cart ({staleCount} pc
          {staleCount === 1 ? "" : "s"}) was set aside.
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button onClick={restoreStash} className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold">
              ↩ Restore it
            </button>
            <button onClick={dismissStash} className="rounded-lg px-3 py-1.5 text-xs text-amber-700 underline">
              ✕ Dismiss
            </button>
          </div>
        </div>
      )}

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

          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Sold by</p>
          <select
            value={isOther ? OTHER : staffList.includes(soldBy) ? soldBy : soldBy ? OTHER : ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === OTHER) { setIsOther(true); setSoldBy(""); }
              else { setIsOther(false); setSoldBy(v); }
            }}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-base outline-none focus:border-brand"
          >
            <option value="">Select staff…</option>
            {staffList.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
            <option value={OTHER}>Others…</option>
          </select>
          {(isOther || (soldBy && !staffList.includes(soldBy))) && (
            <input
              value={soldBy}
              onChange={(e) => setSoldBy(e.target.value)}
              placeholder="Type the name"
              autoCapitalize="words"
              className="rounded-xl border border-amber-400 bg-amber-50 px-4 py-2.5 text-base outline-none focus:border-brand"
            />
          )}

          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Freebie given</p>
          <div className="grid grid-cols-2 gap-2">
            {FREEBIE_OPTIONS.map((f) => {
              const n = freebieCounts[f] || 0;
              return (
                <div
                  key={f}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2 ${n > 0 ? "border-brand bg-brand/5" : "border-slate-200 bg-white"}`}
                >
                  <span className="text-sm font-medium">{f}</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => bumpFreebie(f, -1)}
                      disabled={n === 0}
                      aria-label={`One less ${f}`}
                      className="h-8 w-8 rounded-lg border border-slate-300 text-lg font-bold leading-none active:bg-slate-100 disabled:opacity-30"
                    >
                      −
                    </button>
                    <span className="w-5 text-center text-base font-semibold tabular-nums">{n}</span>
                    <button
                      onClick={() => bumpFreebie(f, 1)}
                      aria-label={`One more ${f}`}
                      className="h-8 w-8 rounded-lg border border-slate-300 text-lg font-bold leading-none active:bg-slate-100"
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {total >= CAP_MIN && (freebieCounts.Cap || 0) > 0 ? (
            <p className="text-xs font-medium text-emerald-700">🧢 Free cap added — bill is ₹2,499+</p>
          ) : total > 0 && total < CAP_MIN ? (
            <p className="text-xs text-slate-400">
              Free cap at ₹2,499+ (₹{(CAP_MIN - total).toLocaleString("en-IN")} to go)
            </p>
          ) : null}

          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Offers</p>
          {offTier > 0 ? (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold text-emerald-800">
                  🎉 BUY {Math.min(pieces, 4)}{pieces > 4 ? "+" : ""} = {tierPct}% OFF
                </p>
                <span className="text-base font-bold tabular-nums text-emerald-700">− {money(offTier)}</span>
              </div>
              <p className="mt-0.5 text-xs text-emerald-700">
                Applied automatically · free keychain added
                {pieces === 2 && " · 1 more piece = 30% off"}
                {pieces === 3 && " · 1 more piece = 40% off"}
              </p>
              <button onClick={() => setTierDismissed(true)} className="mt-1 text-xs text-emerald-600 underline">
                Remove this offer
              </button>
            </div>
          ) : tierPct > 0 ? (
            <button
              onClick={() => setTierDismissed(false)}
              className="rounded-xl border border-dashed border-emerald-300 bg-white px-3 py-2 text-left text-sm text-slate-600"
            >
              Offer removed — tap to re-apply Buy {Math.min(pieces, 4)} = {tierPct}% off (−{money(tierAmt)})
            </button>
          ) : (
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
              🏷 Buy 2 = <b>20%</b> · Buy 3 = <b>30%</b> · Buy 4 = <b>40%</b> off — applies automatically
            </p>
          )}
          <button
            onClick={() => router.push("/reward")}
            disabled={subtotal < OFFER4_MIN && !reward}
            className={`rounded-xl border px-3 py-2.5 text-sm font-medium disabled:opacity-40 ${reward ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}
          >
            {reward ? `🎁 Mystery envelope · ₹${reward} won ✓` : "🎁 Mystery envelope"}
          </button>
          {subtotal < OFFER4_MIN && !reward && (
            <p className="text-xs text-slate-400">
              Mystery envelope unlocks at ₹4,999+ (now ₹{subtotal.toLocaleString("en-IN")})
            </p>
          )}

          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Customer &amp; payment</p>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (required)" className={`rounded-xl border px-4 py-2.5 text-base outline-none focus:border-brand ${nameOk ? "border-slate-300" : "border-amber-400 bg-amber-50"}`} />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Mobile no. (10 digits, required)" className={`rounded-xl border px-4 py-2.5 text-base outline-none focus:border-brand ${phoneOk ? "border-slate-300" : "border-amber-400 bg-amber-50"}`} />
          {phone.trim() !== "" && !phoneOk && (
            <p className="text-xs font-medium text-amber-700">
              That&apos;s not a valid mobile — 10 digits, starting 6–9.
            </p>
          )}
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Address (optional)" className="rounded-xl border border-slate-300 px-4 py-2.5 text-base outline-none focus:border-brand" />
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" autoCapitalize="off" placeholder="Email (optional — to email the bill)" className="rounded-xl border border-slate-300 px-4 py-2.5 text-base outline-none focus:border-brand" />
          <div className="grid grid-cols-4 gap-2 pt-1">
            {(["cash", "card", "upi", "other"] as const).map((p) => (
              <button
                key={p}
                onClick={() => togglePayment(p)}
                className={`rounded-xl border px-2 py-2 text-sm font-medium ${payments.includes(p) ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}
              >
                {payments.includes(p) ? "✓ " : ""}{PM_LABEL[p]}
              </button>
            ))}
          </div>
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
          {offTier > 0 && (
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-slate-500">🎉 Buy {Math.min(pieces, 4)}{pieces > 4 ? "+" : ""} · {tierPct}% off
                <button onClick={() => setTierDismissed(true)} className="ml-1.5 text-xs text-slate-400 underline">✕</button>
              </span>
              <span className="font-medium text-emerald-700">− {money(offTier)}</span>
            </div>
          )}
          {!!reward && (
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-slate-500">🎁 Mystery envelope
                <button onClick={clearReward} className="ml-1.5 text-xs text-slate-400 underline">✕</button>
              </span>
              <span className="font-medium text-emerald-700">− {money(reward)}</span>
            </div>
          )}
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
              : !nameOk
              ? "Enter name & mobile no."
              : !phoneOk
              ? "Enter a valid 10-digit mobile"
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
              {offTier > 0 && <Row label={`Buy ${Math.min(pieces, 4)}${pieces > 4 ? "+" : ""} · ${tierPct}% off`} value={`− ${money(offTier)}`} />}
              {!!reward && <Row label="Mystery envelope" value={`− ${money(reward)}`} />}
              <div className="flex justify-between pt-1 text-lg font-bold">
                <span>Total</span>
                <span>{money(total)}</span>
              </div>
            </div>
            <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
              <p><b>Point of sale:</b> {saleChannel}</p>
              <p><b>Payment:</b> {paymentStr}</p>
              <p><b>Freebie:</b> {freebieStr || "None"}</p>
              {name && <p><b>Name:</b> {name}</p>}
              {phone && <p><b>Mobile:</b> {phone}</p>}
              {email && <p><b>Email:</b> {email}</p>}
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
