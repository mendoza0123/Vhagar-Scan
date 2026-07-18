import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";
import { money, billNo as deriveBillNo, billDateTime } from "@/lib/format";
import BillActions from "./BillActions";
import FreebieThumb from "./FreebieThumb";

// Freebies given at the booth, shown on the bill as complimentary line items.
// mrp is only the struck-through "value" shown next to FREE — adjust freely.
// Photos live in public/freebies/.
const KEY_CHAIN = { label: "Exclusive Vhagar Key Chain", img: "/freebies/keychain.png", mrp: 299 };
const FREEBIE_META: Record<string, { label: string; img: string; mrp: number }> = {
  cap: { label: "Exclusive Vhagar Cap", img: "/freebies/cap.png", mrp: 499 },
  "key chain": KEY_CHAIN,
  keychain: KEY_CHAIN,
  kitchen: KEY_CHAIN, // bills written before the rename stored this as "Kitchen"
};
function parseFreebies(freebie: string | null) {
  return (freebie || "")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      // token looks like "Cap" or "Cap x2"
      const m = raw.match(/^(.*?)\s*x\s*(\d+)$/i);
      const name = (m ? m[1] : raw).trim();
      const qty = m ? Math.max(1, parseInt(m[2], 10)) : 1;
      const meta = FREEBIE_META[name.toLowerCase()] ?? { label: `Exclusive Vhagar ${name}`, img: "", mrp: 0 };
      return { ...meta, qty };
    });
}

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
           customer_email, delivery_method, freebie, note, sold_by, status, created_at
    FROM sales WHERE id = ${id}`;
  if (rows.length === 0) return null;
  const sale = rows[0] as any;
  const items = (await sql`
    SELECT variant_sku, name, size, unit_price::float8 AS unit_price,
           qty, line_total::float8 AS line_total
    FROM sale_items WHERE sale_id = ${id} ORDER BY id`) as SaleItem[];
  return { ...sale, items };
}

// Show only the payment method(s) actually used. Split → "UPI + Cash".
function paymentLabel(pm: string | null): string {
  const map: Record<string, string> = { cash: "Cash", card: "Credit Card", credit: "Credit Card", upi: "UPI", other: "Other" };
  const labels: string[] = [];
  for (const t of (pm || "cash").toLowerCase().split(/[^a-z]+/)) {
    const l = map[t];
    if (l && !labels.includes(l)) labels.push(l);
  }
  return labels.length ? labels.join(" + ") : "Cash";
}

const MIN_ROWS = 5; // total item+freebie+blank rows — fits ONE page (Address row removed bought the headroom)

export default async function BillPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) notFound();

  const sale = await getSale(id);
  if (!sale) notFound();

  const billNo = sale.bill_no ?? deriveBillNo(sale.id);
  const freebies = parseFreebies(sale.freebie);
  const padRows = Math.max(0, MIN_ROWS - sale.items.length - freebies.length);

  // Short, professional note pre-filled into WhatsApp / Gmail. Staff attach the
  // downloaded PDF by hand — no link (wa.me or Gmail) can carry a file.
  // NO EMOJI HERE: this string is serialised server->client, and astral-plane
  // chars (e.g. 🐉, a surrogate pair) come out the other side as a literal
  // "🐉" — the customer would receive the raw escape. BMP chars like ₹
  // are fine. Matches the bill's own plain "OWN YOUR FLAME" sign-off anyway.
  const firstName = (sale.customer_name || "").trim().split(/\s+/)[0];
  const shareText = [
    `Hi ${firstName || "there"},`,
    "",
    `Thank you for shopping with Vhagar. Your bill ${billNo} for ${money(sale.total)} is attached.`,
    "",
    "Own Your Flame",
  ].join("\n");

  return (
    <main className="flex min-h-screen flex-col gap-4 bg-slate-100 p-4 print:bg-white print:p-0">
      <style dangerouslySetInnerHTML={{ __html: "@media print{@page{size:A4;margin:10mm}body{background:#fff}}" }} />
      <header className="mx-auto flex w-full max-w-[820px] items-center justify-between print:hidden">
        <Link href="/sales" className="text-sm font-medium text-brand">← Sales</Link>
        <Link href="/" className="text-sm text-slate-500">Home</Link>
      </header>

      {/* ---------- THE BILL ---------- */}
      <article id="bill-doc" className="mx-auto w-full max-w-[820px] bg-white text-[13px] text-black shadow-sm sm:text-[15px] print:max-w-none print:shadow-none">
        <div className="border-[3px] border-black p-2.5">
          <div className="border border-black">
            {/* header / logo */}
            <div className="flex items-center justify-center border-b border-black py-4 sm:py-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/lockup-black.png" alt="VHAGAR" className="h-16 w-auto sm:h-24" />
            </div>

            {/* order / customer fields */}
            <div className="text-[13px] sm:text-[15px]">
              <Row2
                left={<Field label="Order No." value={billNo} />}
                right={<Field label="Date" value={billDateTime(sale.created_at)} />}
              />
              <FieldRow label="Name" value={sale.customer_name || ""} />
              <FieldRow label="Mobile No." value={sale.customer_phone || ""} />
              <FieldRow label="Email" value={sale.customer_email || ""} />
              <div className="flex border-b border-black">
                <LabelCell>Payment</LabelCell>
                <div className="flex-1 px-4 py-3 font-medium uppercase tracking-wide">{paymentLabel(sale.payment_method)}</div>
              </div>
              <div className="flex">
                <LabelCell>Notes</LabelCell>
                <div className="flex-1 px-4 py-3 text-sm">{sale.note || " "}</div>
              </div>
            </div>
          </div>

          {/* items table */}
          <div className="mt-2.5 overflow-x-auto">
          <table className="w-full border-collapse text-[13px] sm:text-[15px]">
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
              {freebies.map((f, i) => (
                <tr key={`free-${i}`}>
                  <td className="border border-black px-3 py-2 text-center tabular-nums">{f.qty}</td>
                  <td className="border border-black px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <FreebieThumb src={f.img} alt={f.label} />
                      <span>
                        <span className="font-medium">{f.label}</span>
                        <span className="ml-2 align-middle whitespace-nowrap rounded border border-black px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                          Free gift
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className="border border-black px-3 py-2 text-right tabular-nums text-slate-400 line-through">
                    {f.mrp ? money(f.mrp) : ""}
                  </td>
                  <td className="border border-black px-3 py-2 text-right font-bold tabular-nums">FREE</td>
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
          </div>

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

          {/* terms & conditions */}
          <div className="mt-3 border border-black px-4 py-3">
            <p className="text-sm font-bold uppercase tracking-wide">Terms &amp; Conditions</p>
            <ul className="mt-1 space-y-0.5 text-[13px]">
              <li>• Thank you for your purchase.</li>
              <li>• No Exchange, No Return, No Refund.</li>
            </ul>
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
          customerEmail={sale.customer_email}
          address={sale.delivery_method}
          paymentMethod={sale.payment_method}
          note={sale.note}
          freebie={sale.freebie}
          soldBy={sale.sold_by}
        />
      </div>
    </main>
  );
}

/* ---------- field helpers ---------- */
function LabelCell({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-24 shrink-0 border-r border-black px-3 py-3 text-xs font-semibold uppercase tracking-wide sm:w-36 sm:px-4">
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
const WebIcon = () => (<IconBox><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><ellipse cx="12" cy="12" rx="4" ry="9" /></IconBox>);
