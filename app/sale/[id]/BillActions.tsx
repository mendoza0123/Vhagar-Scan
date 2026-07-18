"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { normalizePhone } from "@/lib/phone";
import { staffName } from "@/lib/staff";

const FREEBIE_NAMES = ["Cap", "Key Chain"] as const;
// same standing staff list + self-growing /api/staff union as the sell screen
const BASE_STAFF = ["Aditya", "Naushi", "Angel"];
const OTHER = "__other__";

// "Cap x2 + Key Chain x1" (or legacy "Cap" / "Kitchen") → counts per freebie.
function parseFreebieCounts(s: string | null): Record<string, number> {
  const counts: Record<string, number> = { Cap: 0, "Key Chain": 0 };
  for (const tok of (s || "").split("+")) {
    const m = tok.trim().match(/^(.*?)(?:\s*x\s*(\d+))?$/i);
    if (!m || !m[1]) continue;
    const raw = m[1].trim().toLowerCase();
    const name = raw === "cap" ? "Cap" : raw === "key chain" || raw === "keychain" || raw === "kitchen" ? "Key Chain" : null;
    if (name) counts[name] += Math.max(1, parseInt(m[2] || "1", 10));
  }
  return counts;
}
const freebieString = (c: Record<string, number>) =>
  FREEBIE_NAMES.filter((n) => (c[n] || 0) > 0).map((n) => `${n} x${c[n]}`).join(" + ") || null;

type Props = {
  id: number;
  billNo: string;
  status: string;
  shareText: string;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  address: string | null;
  paymentMethod: string;
  note: string | null;
  freebie: string | null;
  soldBy: string | null;
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
    // customer came back for a cap/keychain after billing? edit it in, so
    // there's a record and it prints on the bill
    freebies: parseFreebieCounts(p.freebie),
    soldBy: p.soldBy || "",
  }));
  const editPhoneOk = normalizePhone(f.phone) !== null;
  const bumpFreebie = (n: string, d: number) =>
    setF((cur) => ({ ...cur, freebies: { ...cur.freebies, [n]: Math.max(0, (cur.freebies[n] || 0) + d) } }));
  const [staffList, setStaffList] = useState<string[]>(BASE_STAFF);
  const [soldByOther, setSoldByOther] = useState(false);
  useEffect(() => {
    if (!editing) return;
    let live = true;
    fetch("/api/staff")
      .then((r) => (r.ok ? r.json() : { names: [] }))
      .then((d) => { if (live) setStaffList([...new Set([...BASE_STAFF, ...(d.names || [])])].sort()); })
      .catch(() => {});
    return () => { live = false; };
  }, [editing]);
  // one payment method per bill — picking one replaces the rest
  const togglePayment = (pm: string) => setF((cur) => ({ ...cur, payments: [pm] }));

  // Filename is brand + bill no only, e.g. Vhagar-VH-2026-0023.pdf
  const filename = `Vhagar-${p.billNo}.pdf`;

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
    const body = `${p.shareText}\n\nVhagar Clothing · vhagar.co · +91-88303 97228`;
    // authuser pins the sender to the booth account even if other Google
    // accounts are signed into this browser. ponytail: hardcoded booth sender.
    const url = `https://mail.google.com/mail/?view=cm&fs=1&authuser=pos@vhagar.co&to=${encodeURIComponent(to)}&su=${encodeURIComponent(su)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener");
  };

  // Normalise an Indian mobile to WhatsApp's international form (no +, no spaces).
  // wa.me rejects anything that isn't a full country-code number, so a bare 10
  // digits must get 91, and 0-prefixed / mistyped extra digits fall back to the
  // last 10 rather than shipping an invalid number WhatsApp refuses to open.
  const waNumber = (phone: string | null) => {
    const d = (phone || "").replace(/\D/g, "");
    if (!d) return "";
    if (d.length === 10) return "91" + d;
    if (d.startsWith("91") && d.length === 12) return d;
    if (d.length > 10) return "91" + d.slice(-10);
    return d;
  };
  // Opens the customer's chat (works for numbers that aren't saved contacts) with
  // the note pre-typed; staff attach the already-downloaded PDF via 📎. A wa.me
  // link cannot carry a file, and auto-downloading here would duplicate the file
  // staff just saved. window.open MUST stay synchronous — after an await it falls
  // outside the user gesture and the popup blocker silently kills the redirect.
  const whatsappBill = () => {
    const num = waNumber(p.customerPhone);
    if (!num) return;
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(p.shareText)}`, "_blank", "noopener");
  };

  const voidSale = async () => {
    if (!confirm("Void this bill and restock all its items?")) return;
    setBusy("void");
    const res = await fetch(`/api/sales/${p.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "void", by: staffName() }), // voids are attributed, like sales
    });
    setBusy(null);
    if (res.ok) router.refresh();
    else alert("Could not void this bill.");
  };

  const saveEdit = async () => {
    if (!editPhoneOk) return; // Save is disabled too — belt and braces
    setBusy("edit");
    const res = await fetch(`/api/sales/${p.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_name: f.name, customer_phone: normalizePhone(f.phone), customer_email: f.email,
        address: f.address, payment_method: f.payments.join(" + "), note: f.note,
        freebie: freebieString(f.freebies),
        sold_by: f.soldBy.trim() || null,
      }),
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
        <button onClick={downloadPdf} disabled={busy === "pdf"} className="btn btn-primary col-span-2">
          {busy === "pdf" ? "Preparing…" : "⬇ 1 · Download PDF"}
        </button>
        <p className="col-span-2 -mb-1 text-center text-xs text-slate-400">
          then send it below and attach the downloaded PDF
        </p>
        <button
          onClick={whatsappBill}
          disabled={!p.customerPhone}
          title={p.customerPhone ? `Open WhatsApp chat with ${p.customerPhone}` : "Add the customer's mobile (Edit) first"}
          className="btn btn-ghost col-span-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {p.customerPhone ? `📱 2 · WhatsApp → ${p.customerPhone}` : "📱 WhatsApp — no mobile on bill"}
        </button>
        <button
          onClick={emailBill}
          disabled={!p.customerEmail}
          title={p.customerEmail ? `Email to ${p.customerEmail}` : "Add the customer's email (Edit) first"}
          className="btn btn-ghost col-span-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {p.customerEmail ? `✉️ 2 · Email → ${p.customerEmail}` : "✉️ Email — no email on bill"}
        </button>
        <button onClick={sharePdf} disabled={busy === "pdf"} className="btn btn-ghost">
          {busy === "pdf" ? "Preparing…" : "📤 Share PDF"}
        </button>
        <button onClick={() => window.print()} className="btn btn-ghost">🖨 Print</button>
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
              <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" placeholder="Mobile no. (10 digits)" className={`rounded-xl border px-4 py-2.5 outline-none focus:border-brand ${editPhoneOk ? "border-slate-300" : "border-amber-400 bg-amber-50"}`} />
              {!editPhoneOk && (
                <p className="text-xs font-medium text-amber-700">Valid 10-digit mobile needed (starts 6–9).</p>
              )}
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

              <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Sold by</p>
              <select
                value={soldByOther ? OTHER : staffList.includes(f.soldBy) ? f.soldBy : f.soldBy ? OTHER : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === OTHER) { setSoldByOther(true); setF({ ...f, soldBy: "" }); }
                  else { setSoldByOther(false); setF({ ...f, soldBy: v }); }
                }}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 outline-none focus:border-brand"
              >
                <option value="">Select staff…</option>
                {staffList.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
                <option value={OTHER}>Others…</option>
              </select>
              {(soldByOther || (f.soldBy !== "" && !staffList.includes(f.soldBy))) && (
                <input
                  value={f.soldBy}
                  onChange={(e) => setF({ ...f, soldBy: e.target.value })}
                  placeholder="Type the name"
                  autoCapitalize="words"
                  className="rounded-xl border border-amber-400 bg-amber-50 px-4 py-2.5 outline-none focus:border-brand"
                />
              )}

              <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Freebies given</p>
              <div className="grid grid-cols-2 gap-2">
                {FREEBIE_NAMES.map((n) => {
                  const c = f.freebies[n] || 0;
                  return (
                    <div key={n} className={`flex items-center justify-between rounded-xl border px-3 py-2 ${c > 0 ? "border-brand bg-brand/5" : "border-slate-200 bg-white"}`}>
                      <span className="text-sm font-medium">{n}</span>
                      <div className="flex items-center gap-2">
                        <button onClick={() => bumpFreebie(n, -1)} disabled={c === 0} className="h-8 w-8 rounded-lg border border-slate-300 text-lg font-bold leading-none active:bg-slate-100 disabled:opacity-30">−</button>
                        <span className="w-5 text-center text-base font-semibold tabular-nums">{c}</span>
                        <button onClick={() => bumpFreebie(n, 1)} className="h-8 w-8 rounded-lg border border-slate-300 text-lg font-bold leading-none active:bg-slate-100">+</button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-slate-400">Freebies print on the bill as FREE lines.</p>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button onClick={() => setEditing(false)} className="btn btn-ghost">Cancel</button>
              <button onClick={saveEdit} disabled={busy === "edit" || !editPhoneOk} className="btn btn-primary disabled:opacity-50">{busy === "edit" ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
