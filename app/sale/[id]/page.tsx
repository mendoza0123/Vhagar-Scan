import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";
import { money, billNo as deriveBillNo, billDateTime } from "@/lib/format";
import BillActions from "./BillActions";

export const dynamic = "force-dynamic";

type SaleItem = {
  variant_sku: string;
  name: string;
  size: string;
  unit_price: number;
  qty: number;
  line_total: number;
};

async function getSale(id: number) {
  noStore();
  const rows = await sql`
    SELECT id, bill_no, subtotal::float8 AS subtotal, discount::float8 AS discount,
           total::float8 AS total, payment_method, customer_name, customer_phone,
           delivery_method, note, sold_by, status, created_at
    FROM sales WHERE id = ${id}`;
  if (rows.length === 0) return null;
  const sale = rows[0] as any;
  const items = (await sql`
    SELECT variant_sku, name, size, unit_price::float8 AS unit_price,
           qty, line_total::float8 AS line_total
    FROM sale_items WHERE sale_id = ${id} ORDER BY id`) as SaleItem[];
  return { ...sale, items };
}

// Map the stored payment_method onto the four printed boxes.
function payKey(pm: string | null): "cash" | "card" | "upi" | "other" {
  const s = (pm || "cash").toLowerCase();
  if (s.includes("cash")) return "cash";
  if (s.includes("card") || s.includes("credit")) return "card";
  if (s.includes("upi")) return "upi";
  return "other";
}

const MIN_ROWS = 8;

export default async function BillPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) notFound();

  const sale = await getSale(id);
  if (!sale) notFound();

  const billNo = sale.bill_no ?? deriveBillNo(sale.id);
  const pk = payKey(sale.payment_method);
  const address = sale.delivery_method || ""; // ADDRESS reuses delivery_method until a field is added
  const padRows = Math.max(0, MIN_ROWS - sale.items.length);

  const shareText = [
    "VHAGAR",
    `Bill ${billNo}`,
    billDateTime(sale.created_at),
    "",
    ...sale.items.map((l: SaleItem) => `${l.qty}× ${l.name} ${l.size} — ${money(l.line_total)}`),
    "",
    `Total: ${money(sale.total)}`,
  ].join("\n");

  return (
    <main className="flex min-h-screen flex-col gap-4 bg-slate-100 p-4 print:bg-white print:p-0">
      <style dangerouslySetInnerHTML={{ __html: "@media print{@page{size:A4;margin:10mm}body{background:#fff}}" }} />
      <header className="mx-auto flex w-full max-w-[820px] items-center justify-between print:hidden">
        <Link href="/sales" className="text-sm font-medium text-brand">← Sales</Link>
        <Link href="/" className="text-sm text-slate-500">Home</Link>
      </header>

      {/* ---------- THE BILL ---------- */}
      <article className="mx-auto w-full max-w-[820px] bg-white text-black shadow-sm print:max-w-none print:shadow-none">
        <div className="border-[3px] border-black p-2.5">
          <div className="border border-black">
            {/* header / logo */}
            <div className="flex items-center justify-center border-b border-black py-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/lockup-black.png" alt="VHAGAR" className="h-24 w-auto" />
            </div>

            {/* order / customer fields */}
            <div className="text-[15px]">
              <Row2
                left={<Field label="Order No." value={billNo} />}
                right={<Field label="Date" value={billDateTime(sale.created_at)} />}
              />
              <FieldRow label="Name" value={sale.customer_name || ""} />
              <FieldRow label="Mobile No." value={sale.customer_phone || ""} />
              <FieldRow label="Address" value={address} />
              <div className="flex border-b border-black">
                <LabelCell>Payment</LabelCell>
                <div className="flex flex-1 flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3">
                  <PayBox label="Cash" on={pk === "cash"} />
                  <PayBox label="Credit Card" on={pk === "card"} />
                  <PayBox label="UPI" on={pk === "upi"} />
                  <PayBox label="Other" on={pk === "other"} />
                </div>
              </div>
              <div className="flex">
                <LabelCell>Notes</LabelCell>
                <div className="flex-1 px-4 py-3 text-sm">{sale.note || " "}</div>
              </div>
            </div>
          </div>

          {/* items table */}
          <table className="mt-2.5 w-full border-collapse text-[15px]">
            <thead>
              <tr className="bg-black text-left text-sm uppercase tracking-wide text-white">
                <th className="w-16 border border-black px-3 py-2.5 font-semibold">Qty</th>
                <th className="border border-black px-3 py-2.5 font-semibold">Description</th>
                <th className="w-28 border border-black px-3 py-2.5 text-right font-semibold">Price</th>
                <th className="w-32 border border-black px-3 py-2.5 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {sale.items.map((l: SaleItem, i: number) => (
                <tr key={l.variant_sku + i}>
                  <td className="border border-black px-3 py-2.5 text-center tabular-nums">{l.qty}</td>
                  <td className="border border-black px-3 py-2.5">
                    <span className="font-medium">{l.name}</span>
                    <span className="text-slate-500"> · {l.size} · {l.variant_sku}</span>
                  </td>
                  <td className="border border-black px-3 py-2.5 text-right tabular-nums">{money(l.unit_price)}</td>
                  <td className="border border-black px-3 py-2.5 text-right font-medium tabular-nums">{money(l.line_total)}</td>
                </tr>
              ))}
              {Array.from({ length: padRows }).map((_, i) => (
                <tr key={`pad-${i}`}>
                  <td className="border border-black px-3 py-2.5">&nbsp;</td>
                  <td className="border border-black px-3 py-2.5" />
                  <td className="border border-black px-3 py-2.5" />
                  <td className="border border-black px-3 py-2.5" />
                </tr>
              ))}
              {sale.discount > 0 && (
                <tr>
                  <td className="border border-black px-3 py-2 text-right" colSpan={3}>Discount</td>
                  <td className="border border-black px-3 py-2 text-right tabular-nums">− {money(sale.discount)}</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="text-[15px] font-semibold">
                <td className="border border-black px-3 py-3" colSpan={2}>
                  <span className="text-xs uppercase tracking-wide text-slate-500">Sold by</span>{" "}
                  {sale.sold_by || ""}
                </td>
                <td className="border border-black px-3 py-3 text-right uppercase">Total</td>
                <td className="border border-black px-3 py-3 text-right text-lg tabular-nums">{money(sale.total)}</td>
              </tr>
            </tfoot>
          </table>

          {sale.status !== "completed" && (
            <p className="mt-2 text-center text-sm font-semibold uppercase tracking-wide text-rose-600">
              {sale.status}
            </p>
          )}

          {/* footer / contact */}
          <div className="mt-3 border border-black px-4 py-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex items-start gap-3 text-[13px] leading-snug">
                <PinIcon />
                <p>
                  Essgee Option One,<br />
                  3rd Floor, Shop No. 333-336,<br />
                  Near Tilak Bhavan, Opp. Indiabulls,<br />
                  Senapati Bapat Marg, Prabhadevi,<br />
                  Mumbai - 400013
                </p>
              </div>
              <div className="flex flex-col justify-center gap-3 text-[14px] sm:pl-6">
                <span className="flex items-center gap-3"><PhoneIcon /> +91-88303 97228</span>
                <span className="flex items-center gap-3"><MailIcon /> official@vhagar.co</span>
                <span className="flex items-center gap-3"><WebIcon /> vhagar.co</span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-center gap-3 py-3">
            <span className="h-px w-10 bg-black" />
            <span className="text-sm font-semibold uppercase tracking-[0.35em]">Own Your Flame</span>
            <span className="h-px w-10 bg-black" />
          </div>
        </div>
      </article>

      <div className="mx-auto w-full max-w-[820px]">
        <BillActions
          id={sale.id}
          billNo={billNo}
          status={sale.status}
          shareText={shareText}
          customerName={sale.customer_name}
          customerPhone={sale.customer_phone}
          address={sale.delivery_method}
          paymentMethod={sale.payment_method}
          note={sale.note}
        />
      </div>
    </main>
  );
}

/* ---------- field helpers ---------- */
function LabelCell({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-36 shrink-0 border-r border-black px-4 py-3 text-xs font-semibold uppercase tracking-wide">
      {children}
    </div>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex">
      <LabelCell>{label}</LabelCell>
      <div className="flex-1 px-4 py-3">{value}</div>
    </div>
  );
}
function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex border-b border-black">
      <LabelCell>{label}</LabelCell>
      <div className="flex-1 px-4 py-3">{value || " "}</div>
    </div>
  );
}
function Row2({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="flex border-b border-black">
      <div className="flex-1 border-r border-black">{left}</div>
      <div className="flex-1">{right}</div>
    </div>
  );
}
function PayBox({ label, on }: { label: string; on: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-[15px]">
      <span className="flex h-4 w-4 items-center justify-center border border-black text-[11px] leading-none">
        {on ? "✓" : ""}
      </span>
      <span className="uppercase tracking-wide">{label}</span>
    </span>
  );
}

/* ---------- tiny inline icons (print-safe, currentColor) ---------- */
function IconBox({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-black">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  );
}
const PinIcon = () => (<IconBox><path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11Z" /><circle cx="12" cy="10" r="2.5" /></IconBox>);
const PhoneIcon = () => (<IconBox><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.6a16 16 0 0 0 6 6l1.1-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" /></IconBox>);
const MailIcon = () => (<IconBox><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="m3 7 9 6 9-6" /></IconBox>);
const WebIcon = () => (<IconBox><path d="m6 15 4-9 4 9" /><path d="M9 3v18" /></IconBox>);
