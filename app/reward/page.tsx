"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { money } from "@/lib/format";

// Offer 4 — the Mystery Envelope. On bills of ₹4,999+ the customer picks one of
// five floating envelopes; each hides ₹100–₹500 off, shuffled every time. One
// pick per bill: the result is stored and consumed by the sell screen.
const AMOUNTS = [100, 200, 300, 400, 500];
const REWARD_KEY = "vhagar.reward.v1"; // same literal in sell/page.tsx (a page can't export consts)
const CART_KEY = "vhagar.cart.v2";
const MIN_SUBTOTAL = 4999;

const CSS = `
@keyframes vh-float {
  0%, 100% { transform: translateY(0) rotate(var(--tilt)); }
  50%      { transform: translateY(-14px) rotate(calc(var(--tilt) * -1)); }
}
@keyframes vh-shake {
  0%, 100% { transform: rotate(0); }
  20% { transform: rotate(-6deg); } 40% { transform: rotate(6deg); }
  60% { transform: rotate(-4deg); } 80% { transform: rotate(4deg); }
}
@keyframes vh-pop {
  0%   { transform: scale(0.3) translateY(20px); opacity: 0; }
  70%  { transform: scale(1.12) translateY(-4px); opacity: 1; }
  100% { transform: scale(1) translateY(0); opacity: 1; }
}
@keyframes vh-spark {
  0%   { transform: translate(0, 0) scale(1); opacity: 1; }
  100% { transform: translate(var(--dx), var(--dy)) scale(0); opacity: 0; }
}
.vh-env { animation: vh-float 3.2s ease-in-out infinite; animation-delay: var(--delay); }
.vh-env-shake { animation: vh-shake 0.5s ease-in-out 2; }
.vh-flap { transform-origin: top; transition: transform 0.55s ease-in-out; }
.vh-open .vh-flap { transform: rotateX(-180deg); }
.vh-card { transition: transform 0.6s ease-out 0.35s; }
.vh-open .vh-card { transform: translateY(-58%); }
.vh-amount { animation: vh-pop 0.6s ease-out both; }
.vh-sparkle { position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; border-radius: 9999px;
  background: #f5f0e6; animation: vh-spark 0.9s ease-out both; }
`;

function shuffle<T>(a: T[]): T[] {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

export default function RewardPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "locked" | "ready" | "opening" | "revealed" | "already">("loading");
  const [subtotal, setSubtotal] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [won, setWon] = useState<number | null>(null);
  // one shuffle per visit — which envelope hides what is decided before any tap
  const amounts = useMemo(() => shuffle(AMOUNTS), []);

  useEffect(() => {
    try {
      const r = localStorage.getItem(REWARD_KEY);
      if (r) {
        const j = JSON.parse(r);
        if (j?.amount) { setWon(Number(j.amount)); setPhase("already"); return; }
      }
      const cart = JSON.parse(localStorage.getItem(CART_KEY) || "[]") as { price: string; qty: number }[];
      const sub = cart.reduce((s, l) => s + (Number(l.price) || 0) * (l.qty || 0), 0);
      setSubtotal(sub);
      setPhase(sub >= MIN_SUBTOTAL ? "ready" : "locked");
    } catch {
      setPhase("locked");
    }
  }, []);

  const pick = (i: number) => {
    if (phase !== "ready") return;
    setPicked(i);
    setPhase("opening");
    const amount = amounts[i];
    setTimeout(() => {
      setWon(amount);
      // the pick is final the moment it opens — surviving a refresh included
      localStorage.setItem(REWARD_KEY, JSON.stringify({ amount, at: new Date().toISOString() }));
      setPhase("revealed");
    }, 1000);
  };

  return (
    <main className="flex min-h-screen flex-col items-center bg-brand p-6 text-white">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/lockup-black.png" alt="VHAGAR" className="mt-4 h-16 w-auto invert" />
      <p className="mt-1 text-[11px] uppercase tracking-[0.35em] text-white/60">Own Your Flame</p>

      {phase === "locked" && (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <p className="text-5xl">✉️</p>
          <h1 className="mt-4 text-2xl font-bold">Mystery Envelope</h1>
          <p className="mt-2 max-w-xs text-sm text-white/70">
            Unlocks on bills of <b className="text-white">{money(MIN_SUBTOTAL)}+</b>.
            This bill is at {money(subtotal)} — add {money(Math.max(0, MIN_SUBTOTAL - subtotal))} more.
          </p>
          <button onClick={() => router.push("/sell")} className="btn btn-ghost mt-6 bg-white text-brand">
            ← Back to the sale
          </button>
        </div>
      )}

      {(phase === "ready" || phase === "opening" || phase === "revealed") && (
        <>
          <h1 className="mt-6 text-center text-3xl font-bold tracking-tight">
            {phase === "revealed" ? "Congratulations!" : "Pick your reward"}
          </h1>
          <p className="mt-1 text-center text-sm text-white/70">
            {phase === "revealed"
              ? "The dragon has chosen well."
              : "One envelope. One prize. ₹100 to ₹500 off — choose."}
          </p>

          <div className="mt-8 flex w-full max-w-md flex-wrap items-center justify-center gap-5">
            {amounts.map((amt, i) => {
              const isPicked = picked === i;
              const gone = picked !== null && !isPicked;
              return (
                <button
                  key={i}
                  onClick={() => pick(i)}
                  disabled={phase !== "ready"}
                  className={`vh-env relative transition-all duration-500 ${isPicked && phase === "opening" ? "vh-env-shake" : ""} ${
                    isPicked ? "z-10 scale-125" : gone ? "scale-75 opacity-10 blur-[1px]" : "hover:scale-110"
                  }`}
                  style={{ "--delay": `${i * 0.35}s`, "--tilt": `${(i % 2 === 0 ? 1 : -1) * 2}deg` } as React.CSSProperties}
                  aria-label={`Envelope ${i + 1}`}
                >
                  <span className={`relative block h-24 w-32 ${isPicked && phase !== "opening" ? "vh-open" : ""}`}>
                    {/* the prize card inside */}
                    <span className="vh-card absolute inset-x-2 top-2 bottom-2 z-0 flex items-center justify-center rounded-md bg-white">
                      {isPicked && won !== null && (
                        <span className="vh-amount text-xl font-black text-brand">₹{won}</span>
                      )}
                    </span>
                    {/* envelope body */}
                    <span className="absolute inset-0 z-10 rounded-lg bg-[#f5f0e6] shadow-xl" />
                    {/* flap */}
                    <span className="vh-flap absolute inset-x-0 top-0 z-30 h-0 w-0 border-l-[64px] border-r-[64px] border-t-[52px] border-l-transparent border-r-transparent border-t-[#e6dfd0]" />
                    {/* seal */}
                    <span className="absolute left-1/2 top-1/2 z-40 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-brand shadow">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src="/brand/lockup-black.png" alt="" className="h-6 w-6 object-contain invert" />
                    </span>
                    {/* pocket front */}
                    <span className="absolute inset-x-0 bottom-0 z-20 h-14 rounded-b-lg bg-[#efe8d8]" />
                  </span>
                </button>
              );
            })}
          </div>

          {phase === "revealed" && won !== null && (
            <div className="relative mt-10 flex flex-col items-center">
              {Array.from({ length: 10 }).map((_, i) => (
                <span
                  key={i}
                  className="vh-sparkle"
                  style={{
                    "--dx": `${Math.cos((i / 10) * Math.PI * 2) * 90}px`,
                    "--dy": `${Math.sin((i / 10) * Math.PI * 2) * 90}px`,
                    animationDelay: `${i * 0.03}s`,
                  } as React.CSSProperties}
                />
              ))}
              <p className="vh-amount text-center text-5xl font-black">₹{won} OFF</p>
              <button
                onClick={() => router.push("/sell")}
                className="btn mt-6 w-64 bg-white py-4 text-lg font-bold text-brand"
              >
                Apply ₹{won} to this bill →
              </button>
            </div>
          )}

          {phase === "ready" && (
            <p className="mt-10 text-center text-[11px] uppercase tracking-wider text-white/40">
              Offer 4 · on bills of {money(MIN_SUBTOTAL)}+ · one pick per bill
            </p>
          )}
        </>
      )}

      {phase === "already" && won !== null && (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <p className="text-5xl">🎉</p>
          <h1 className="mt-4 text-2xl font-bold">₹{won} already won</h1>
          <p className="mt-2 max-w-xs text-sm text-white/70">
            This bill&apos;s envelope has been opened — one pick per bill.
          </p>
          <button onClick={() => router.push("/sell")} className="btn mt-6 w-64 bg-white py-3 font-bold text-brand">
            Apply ₹{won} to the bill →
          </button>
        </div>
      )}
    </main>
  );
}
