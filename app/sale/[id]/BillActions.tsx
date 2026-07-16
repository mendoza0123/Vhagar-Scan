"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Props = {
  id: number;
  billNo: string;
  product: string;
  status: string;
  shareText: string;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  address: string | null;
  paymentMethod: string;
  note: string | null;
};

const PM_LABEL: Record<string, string> = { cash: "Cash", card: "Card", upi: "UPI", other: "Other" };

export default function BillActions(p: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState(() => ({
    name: p.customerName || "",
    phone: p.customerPhone || "",
    email: p.customerEmail || "",
    address: p.address || "",
    // payment can be split ("cash + upi") — keep it as a token array
    payments: (p.paymentMethod || "cash").toLowerCase().split(/[^a-z]+/)
      .filter((t, i, a) => ["cash", "card", "upi", "other"].includes(t) && a.indexOf(t) === i),
    note: p.note || "",
  }));
  const togglePayment = (pm: string) =>
    setF((cur) => {
      const next = cur.payments.includes(pm) ? cur.payments.filter((x) => x !== pm) : [...cur.payments, pm];
      return { ...cur, payments: next.length ? next : cur.payments };
    });

  // Filename: brand-product-bill.pdf, e.g. Vhagar-TEST-FABRIC-VH-2026-0010.pdf
  const filename = `Vhagar-${(p.product || "bill").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${p.billNo}.pdf`;

  // Snapshot the on-page bill (#bill-doc) to an A4 PDF blob. Forced to 820px wide
  // so the phone's narrow viewport doesn't cramp the document.
  async function makeBlob(): Promise<Blob> {
    const el = document.getElementById("bill-doc");
    if (!el) throw new Error("bill-doc not found");
    const html2pdf = (await import("html2pdf.js")).default;
    return await html2pdf()
      .set({
        margin: 6,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, width: 820, windowWidth: 820 },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      })
      .from(el)
      .outputPdf("blob");
  }
  function download(blob: Blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const sharePdf = async () => {
    setBusy("pdf");
    try {
      const blob = await makeBlob();
      const file = new File([blob], filename, { type: "application/pdf" });
      const nav = navigator as any;
      if (nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file], title: filename, text: `Vhagar bill ${p.billNo}` });
      } else {
        download(blob); // desktop / share-unsupported → save the file
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") alert("Could not create the PDF — use Print → Save as PDF.");
    } finally {
      setBusy(null);
    }
  };
  const downloadPdf = async () => {
    setBusy("pdf");
    try { download(await makeBlob()); }
    catch { alert("Could not create the PDF."); }
    finally { setBusy(null); }
  };

  // Open Gmail already signed in as pos@vhagar.co, pre-addressed to the
  // customer with the bill details in the body. NOTE: a Gmail compose link
  // can't pre-attach a file (Gmail blocks that) — the details go in the body;
  // for the PDF itself use Share/Download PDF and attach it.
  const emailBill = () => {
    const to = p.customerEmail || "";
    const su = `Your Vhagar bill ${p.billNo}`;
    const body = `${p.shareText}\n\nThank you for shopping with Vhagar.\nOwn Your Flame 🐉`;
    // authuser pins the sender to the booth account even if other Google
    // accounts are signed into this browser. ponytail: hardcoded booth sender.
    const url = `https://mail.google.com/mail/?view=cm&fs=1&authuser=pos@vhagar.co&to=${encodeURIComponent(to)}&su=${encodeURIComponent(su)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener");
  };

  // Normalise an Indian mobile to WhatsApp's international form (no +, no spaces).
  const waNumber = (phone: string | null) => {
    const d = (phone || "").replace(/\D/g, "");
    if (!d) return "";
    if (d.length === 10) return "91" + d;               // bare 10-digit mobile
    if (d.length === 11 && d.startsWith("0")) return "91" + d.slice(1);
    return d;                                            // already has a country code
  };
  // Open WhatsApp straight to the customer's number with the bill details.
  // NOTE: a WhatsApp link can't pre-attach the PDF (platform limit) — the
  // details go as text; use Share PDF to send the file itself.
  const whatsappBill = () => {
    const num = waNumber(p.customerPhone);
    if (!num) return;
    const text = `${p.shareText}\n\nThank you for shopping with Vhagar 🐉`;
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
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
      body: JSON.stringify({ customer_name: f.name, customer_phone: f.phone, customer_email: f.email, address: f.address, payment_method: f.payments.join(" + "), note: f.note }),
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
        <button onClick={sharePdf} disabled={busy === "pdf"} className="btn btn-primary">
          {busy === "pdf" ? "Preparing…" : "📤 Share PDF"}
        </button>
        <button onClick={downloadPdf} disabled={busy === "pdf"} className="btn btn-ghost">⬇ Download PDF</button>
        <button
          onClick={whatsappBill}
          disabled={!p.customerPhone}
          title={p.customerPhone ? `WhatsApp to ${p.customerPhone}` : "Add the customer's mobile (Edit) first"}
          className="btn btn-ghost col-span-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {p.customerPhone ? `📱 WhatsApp → ${p.customerPhone}` : "📱 WhatsApp — no mobile on bill"}
        </button>
        <button
          onClick={emailBill}
          disabled={!p.customerEmail}
          title={p.customerEmail ? `Email to ${p.customerEmail}` : "Add the customer's email (Edit) first"}
          className="btn btn-ghost col-span-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {p.customerEmail ? `✉️ Share Email → ${p.customerEmail}` : "✉️ Share Email — no email on bill"}
        </button>
        <button onClick={() => window.print()} className="btn btn-ghost col-span-2">🖨 Print</button>
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
              <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} type="email" inputMode="email" autoCapitalize="off" placeholder="Email" className="rounded-xl border border-slate-300 px-4 py-2.5 outline-none focus:border-brand" />
              <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="Address" className="rounded-xl border border-slate-300 px-4 py-2.5 outline-none focus:border-brand" />
              <div className="grid grid-cols-4 gap-2">
                {(["cash", "card", "upi", "other"] as const).map((pm) => (
                  <button key={pm} onClick={() => togglePayment(pm)} className={`rounded-xl border px-2 py-2 text-sm font-medium ${f.payments.includes(pm) ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600"}`}>
                    {f.payments.includes(pm) ? "✓ " : ""}{PM_LABEL[pm]}
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
