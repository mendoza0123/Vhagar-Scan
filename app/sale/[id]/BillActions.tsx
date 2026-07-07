"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Props = {
  id: number;
  billNo: string;
  status: string;
  shareText: string;
  customerName: string | null;
  customerPhone: string | null;
  address: string | null;
  paymentMethod: string;
  note: string | null;
};

const PM_LABEL: Record<string, string> = { cash: "Cash", card: "Card", upi: "UPI", other: "Other" };

export default function BillActions(p: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({
    name: p.customerName || "",
    phone: p.customerPhone || "",
    address: p.address || "",
    payment: (p.paymentMethod || "cash").toLowerCase(),
    note: p.note || "",
  });

  const url = typeof window !== "undefined" ? window.location.href : "";
  const fullText = `${p.shareText}\n${url}`;
  const waDigits = (p.customerPhone || "").replace(/\D/g, "");
  const wa = `https://wa.me/${waDigits.length === 10 ? "91" + waDigits : waDigits}?text=${encodeURIComponent(fullText)}`;
  const mail = `mailto:?subject=${encodeURIComponent("Vhagar bill " + p.billNo)}&body=${encodeURIComponent(fullText)}`;

  const nativeShare = async () => {
    try {
      if (navigator.share) await navigator.share({ title: p.billNo, text: fullText });
      else { await navigator.clipboard.writeText(fullText); alert("Bill copied to clipboard"); }
    } catch { /* cancelled */ }
  };

  const voidSale = async () => {
    if (!confirm("Void this bill and restock all its items?")) return;
    setBusy("void");
    const res = await fetch(`/api/sales/${p.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "void" }),
    });
    setBusy(null);
    if (res.ok) router.refresh();
    else alert("Could not void this bill.");
  };

  const saveEdit = async () => {
    setBusy("edit");
    const res = await fetch(`/api/sales/${p.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_name: f.name, customer_phone: f.phone, address: f.address, payment_method: f.payment, note: f.note }),
    });
    setBusy(null);
    if (res.ok) { setEditing(false); router.refresh(); }
    else alert("Could not save changes.");
  };

  return (
    <div className="print:hidden">
      {p.status === "void" && (
        <p className="mb-2 rounded-lg bg-rose-100 px-3 py-2 text-center text-sm font-semibold text-rose-700">
          This bill was voided — stock restored.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => window.print()} className="btn btn-primary">🖨 Print</button>
        <button onClick={nativeShare} className="btn btn-ghost">Share</button>
        <a href={wa} target="_blank" rel="noreferrer" className="btn btn-ghost">WhatsApp</a>
        <a href={mail} className="btn btn-ghost">Email</a>
        {p.status === "completed" && (
          <>
            <button onClick={() => setEditing(true)} className="btn btn-ghost">✎ Edit</button>
            <button onClick={voidSale} disabled={busy === "void"} className="btn btn-ghost !text-rose-600">
              {busy === "void" ? "Voiding…" : "↩ Void & restock"}
            </button>
          </>
        )}
        <Link href="/sell" className="btn btn-ghost col-span-2 text-center">＋ New sale</Link>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => setEditing(false)}>
          <div className="w-full max-w-md rounded-t-3xl bg-white p-5 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-brand">Edit bill</h3>
            <p className="text-xs text-slate-400">Items &amp; quantities can’t change here — void &amp; re-sell for that.</p>
            <div className="mt-3 flex flex-col gap-2">
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name" className="rounded-xl border border-slate-300 px-4 py-2.5 outline-none focus:border-brand" />
              <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" placeholder="Mobile no." className="rounded-xl border border-slate-300 px-4 py-2.5 outline-none focus:border-brand" />
              <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="Address" className="rounded-xl border border-slate-300 px-4 py-2.5 outline-none focus:border-brand" />
              <div className="grid grid-cols-4 gap-2">
                {(["cash", "card", "upi", "other"] as const).map((pm) => (
                  <button key={pm} onClick={() => setF({ ...f, payment: pm })} className={`rounded-xl border px-2 py-2 text-sm font-medium ${f.payment === pm ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}>
                    {PM_LABEL[pm]}
                  </button>
                ))}
              </div>
              <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Notes" className="rounded-xl border border-slate-300 px-4 py-2.5 outline-none focus:border-brand" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button onClick={() => setEditing(false)} className="btn btn-ghost">Cancel</button>
              <button onClick={saveEdit} disabled={busy === "edit"} className="btn btn-primary">{busy === "edit" ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
