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

export default async function BillPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) notFound();

  const sale = await getSale(id);
  if (!sale) notFound();

  const billNo = sale.bill_no ?? deriveBillNo(sale.id);
  const shareText = [
    "Vhagar Clothing",
    `Bill ${billNo}`,
    billDateTime(sale.created_at),
    "",
    ...sale.items.map(
      (l: SaleItem) => `${l.qty}× ${l.name} ${l.size} — ${money(l.line_total)}`
    ),
    "",
    `Total: ${money(sale.total)} (Cash)`,
  ].join("\n");

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4">
      {/* Bill prints on A4 (the labels page injects its own @page only while mounted). */}
      <style dangerouslySetInnerHTML={{ __html: "@media print{@page{size:A4;margin:12mm}}" }} />
      <header className="flex items-center justify-between print:hidden">
        <Link href="/sales" className="text-sm font-medium text-brand">
          ← Sales
        </Link>
        <Link href="/" className="text-sm text-slate-500">
          Home
        </Link>
      </header>

      {/* ---------- the bill ---------- */}
      <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm print:border-0 print:shadow-none">
        <div className="border-b border-dashed border-slate-300 pb-3 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-brand">Vhagar Clothing</h1>
          <p className="text-xs text-slate-400">LD Group · Bharat Tex 2026</p>
        </div>

        <div className="flex justify-between py-3 text-sm">
          <div>
            <p className="font-semibold">{billNo}</p>
            <p className="text-xs text-slate-400">{billDateTime(sale.created_at)}</p>
          </div>
          <div className="text-right">
            {sale.status !== "completed" && (
              <span className="rounded bg-rose-100 px-2 py-0.5 text-xs font-medium uppercase text-rose-700">
                {sale.status}
              </span>
            )}
            {sale.sold_by && <p className="text-xs text-slate-400">by {sale.sold_by}</p>}
          </div>
        </div>

        {sale.customer_name && (
          <p className="pb-2 text-sm text-slate-600">
            Customer: {sale.customer_name}
            {sale.customer_phone ? ` · ${sale.customer_phone}` : ""}
          </p>
        )}

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
              <th className="py-2">Item</th>
              <th className="py-2 text-center">Qty</th>
              <th className="py-2 text-right">Price</th>
              <th className="py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((l: SaleItem) => (
              <tr key={l.variant_sku} className="border-b border-slate-100 align-top">
                <td className="py-2">
                  <span className="block font-medium">{l.name}</span>
                  <span className="text-xs text-slate-400">
                    {l.size} · {l.variant_sku}
                  </span>
                </td>
                <td className="py-2 text-center">{l.qty}</td>
                <td className="py-2 text-right">{money(l.unit_price)}</td>
                <td className="py-2 text-right font-medium">{money(l.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between text-slate-600">
            <span>Subtotal</span>
            <span>{money(sale.subtotal)}</span>
          </div>
          {sale.discount > 0 && (
            <div className="flex justify-between text-slate-600">
              <span>Discount</span>
              <span>− {money(sale.discount)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-slate-200 pt-2 text-lg font-bold">
            <span>Total</span>
            <span>{money(sale.total)}</span>
          </div>
          <p className="text-right text-xs uppercase tracking-wide text-slate-400">
            {sale.payment_method || "cash"}
          </p>
        </div>

        {sale.note && <p className="mt-3 text-xs text-slate-500">Note: {sale.note}</p>}

        <p className="mt-4 border-t border-dashed border-slate-300 pt-3 text-center text-xs text-slate-400">
          Thank you! · No GST · Cash sale
        </p>
      </article>

      <BillActions billNo={billNo} shareText={shareText} />
    </main>
  );
}
