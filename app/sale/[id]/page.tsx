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

// The sell screen stores each applied offer as "Label …: ₹<amount>", joined with
// " + " (e.g. "Buy 2 shirts · 20% off: ₹499 + Buy 2 t-shirts · flat off: ₹499").
// Split it back so the customer bill shows the shirt and t-shirt offers on their
// own lines. Bills written before this format end in ")" with no trailing
// "₹<amount>", so they yield nothing here and fall back to one Discount line.
function parseOffers(offer: string | null): { label: string; amount: number }[] {
  return (offer || "")
    .split(" + ")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/₹\s*([\d,]+)\s*$/);
      if (!m) return null;
      const amount = Number(m[1].replace(/,/g, ""));
      const label = part.slice(0, m.index).replace(/[·:\s-]+$/, "").trim();
      return amount > 0 ? { label: label || "Offer", amount } : null;
    })
    .filter((o): o is { label: string; amount: number } => o !== null);
}

export const dynamic = "force-dynamic";

type SaleItem = {
  variant_sku: string;
  name: string;
  size: string;
  unit_price: number;
  qty: number;
  line_total: number;
  image_url: string | null;
};

async function getSale(id: number) {
  noStore();
  const rows = await sql`
    SELECT id, bill_no, subtotal::float8 AS subtotal, discount::float8 AS discount,
           total::float8 AS total, payment_method, customer_name, customer_phone,
           customer_email, delivery_method, freebie, offer, note, sold_by, status, created_at
    FROM sales WHERE id = ${id}`;
  if (rows.length === 0) return null;
  const sale = rows[0] as any;
  // The photo is joined live (not snapshotted) so a later/better product shot
  // shows on an old bill too. The bill TEXT stays the snapshot taken at sale time.
  const items = (await sql`
    SELECT si.variant_sku, si.name, si.size, si.unit_price::float8 AS unit_price,
           si.qty, si.line_total::float8 AS line_total, p.image_url
    FROM sale_items si
    LEFT JOIN variants v ON v.variant_sku = si.variant_sku
    LEFT JOIN products p ON p.style_code = v.style_code
    WHERE si.sale_id = ${id} ORDER BY si.id`) as SaleItem[];
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
  // Itemise the discount: each offer on its own line, and whatever's left of the
  // stored total discount after the offers is a plain manual discount.
  const offerLines = parseOffers(sale.offer);
  const offerSum = offerLines.reduce((s, o) => s + o.amount, 0);
  const manualDiscount = Math.max(0, (Number(sale.discount) || 0) - offerSum);
  const hasDiscount = offerLines.length > 0 || manualDiscount > 0.5;
  // +1 for the Subtotal row that now precedes the discount lines
  const discountRows = offerLines.length + (manualDiscount > 0.5 ? 1 : 0) + (hasDiscount ? 1 : 0);
  const padRows = Math.max(0, MIN_ROWS - sale.items.length - freebies.length - discountRows);

  // The manual discount is a RUPEE amount, not a rate — staff type "15% off" into
  // the discount box as 2534. Recover the rate when it lands cleanly on a whole
  // percent of the subtotal, because "− ₹2,534" alone doesn't tell the customer
  // what deal they actually got. Anything that isn't a clean percent stays a
  // plain "Discount" rather than being rounded into a claim that isn't true.
  // Computed on manualDiscount, NOT the stored total: named offers are already
  // itemised on their own lines above, so including them would overstate the rate.
  const discPct = sale.subtotal > 0 ? (manualDiscount / sale.subtotal) * 100 : 0;
  const wholePct = Math.round(discPct);
  const showPct = manualDiscount > 0.5 && wholePct >= 1 && Math.abs(discPct - wholePct) <= 0.2;

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
      {/* The bill is a customer document: readable spacing beats cramming it onto
          one sheet. An earlier version shrank everything to force a single page
          and the rows came out clipped — don't do that again.

          Two outputs, two mechanisms:
            1. Ctrl+P / Save-as-PDF -> the browser, via @media print
            2. the "Download PDF" button -> html2pdf.js (html2canvas + jsPDF),
               which RASTERISES THE LIVE DOM IN SCREEN MEDIA and therefore
               ignores @media print completely. BillActions tags the bill
               .pdf-export for the capture, so those rules sit OUTSIDE the query.
          Both only fix LAYOUT (full width, no page chrome, clean breaks). Neither
          changes type size or padding. */}
      <style
        dangerouslySetInnerHTML={{
          __html: (() => {
            // The app shell (app/layout.tsx) wraps the POS in max-w-md — right for
            // a phone at the booth, wrong for a sheet of A4.
            const layout = (scope: string, bill: string) => [
              `${scope} .max-w-md{max-width:none!important;width:100%!important}`,
              `${scope} main{min-height:0!important;padding:0!important;gap:0!important;background:#fff!important}`,
              `${bill}{max-width:none!important;width:100%!important;box-shadow:none!important}`,
              `${bill} .nowrap{white-space:nowrap}`,
              // the contact column was breaking "+91-88303 97228" over three lines
              `${bill} .keep span{white-space:nowrap}`,
              // Keep rows and footer blocks whole. For the browser this is the
              // normal print behaviour; for html2pdf its 'css' pagebreak mode
              // reads these same declarations off the live DOM, which is the only
              // way to stop it slicing a row in half as it cuts the canvas.
              `${bill} tr{page-break-inside:avoid;break-inside:avoid}`,
              `${bill} .keep{page-break-inside:avoid;break-inside:avoid}`,
            ].join("");

            return [
              "@media print{",
              "@page{size:A4;margin:12mm 10mm}",
              "html,body{background:#fff;margin:0;padding:0}",
              // clean page breaks — never slice a row or a footer block
              "#bill-doc table{page-break-inside:auto;break-inside:auto}",
              "#bill-doc tr{page-break-inside:avoid;break-inside:avoid}",
              "#bill-doc thead{display:table-header-group}",
              "#bill-doc tfoot{display:table-row-group}",
              "#bill-doc .keep{page-break-inside:avoid;break-inside:avoid}",
              layout("body", "#bill-doc"),
              "}",
              layout("body.pdf-exporting", "#bill-doc.pdf-export"),
            ].join("");
          })(),
        }}
      />
      <header className="mx-auto flex w-full max-w-[820px] items-center justify-between print:hidden">
        <Link href="/sales" className="text-sm font-medium text-brand">← Sales</Link>
        <Link href="/" className="text-sm text-slate-500">Home</Link>
      </header>

      {/* ---------- WHAT SOLD (screen only — never printed, never in the PDF) ----------
          End-of-day tallying reads a list of style codes and can't picture the
          garment. This is the visual check; the bill document below is unchanged. */}
      {sale.items.length > 0 && (
        <section className="mx-auto w-full max-w-[820px] rounded-2xl border border-slate-200 bg-white p-3 shadow-sm print:hidden">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            What sold · {sale.items.reduce((n: number, l: SaleItem) => n + l.qty, 0)} pc
            {sale.items.reduce((n: number, l: SaleItem) => n + l.qty, 0) === 1 ? "" : "s"}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {sale.items.map((l: SaleItem) => (
              <div key={l.variant_sku} className="flex items-center gap-2 rounded-xl border border-slate-200 p-2">
                <div className="relative h-16 w-14 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                  {l.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.image_url} alt={l.name} referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-xl font-bold text-slate-300">
                      {(l.name || "?").charAt(0)}
                    </span>
                  )}
                  {l.qty > 1 && (
                    <span className="absolute right-0.5 top-0.5 rounded bg-black/70 px-1 text-[10px] font-bold text-white">
                      ×{l.qty}
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold leading-tight text-slate-800">{l.name}</p>
                  <p className="text-[11px] text-slate-500">
                    Size <b className="text-slate-700">{l.size}</b>
                  </p>
                  <p className="truncate font-mono text-[10px] text-slate-400">{l.variant_sku}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---------- THE BILL ---------- */}
      <article id="bill-doc" className="mx-auto w-full max-w-[820px] bg-white text-[13px] text-black shadow-sm sm:text-[15px] print:max-w-none print:shadow-none">
        <div className="border-[3px] border-black p-2.5">
          <div className="border border-black">
            {/* header / logo */}
            <div className="bill-logo flex items-center justify-center border-b border-black py-4 sm:py-6">
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
                <div className="bill-cell flex-1 px-4 py-3 font-medium uppercase tracking-wide">{paymentLabel(sale.payment_method)}</div>
              </div>
              <div className="flex">
                <LabelCell>Notes</LabelCell>
                <div className="bill-cell flex-1 px-4 py-3 text-sm">{sale.note || " "}</div>
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
            </tbody>
          </table>
          </div>

          {/* ---- TOTALS: a SEPARATE table in a .keep block ----
               These used to be the last rows of the items table, and html2pdf
               sliced the Subtotal box clean in half at the page boundary — its
               `avoid` option cannot hold a <tr>. As its own block-level element
               the whole group is moved to the next page intact instead of being
               cut. The colgroup mirrors the items table's column widths
               (w-16 / auto / w-28 / w-32) so the borders still line up, and
               -mt-px collapses the doubled edge where the two tables meet. */}
          <div className="keep -mt-px">
            <table className="w-full border-collapse text-[13px] sm:text-[15px]">
              <colgroup>
                <col className="w-16" />
                <col />
                <col className="w-28" />
                <col className="w-32" />
              </colgroup>
              <tbody>
                {hasDiscount && (
                  <tr>
                    <td className="border border-black px-3 py-2 text-right" colSpan={3}>Subtotal</td>
                    <td className="border border-black px-3 py-2 text-right tabular-nums">{money(sale.subtotal)}</td>
                  </tr>
                )}
                {offerLines.map((o, i) => (
                  <tr key={`offer-${i}`}>
                    <td className="border border-black px-3 py-2 text-right" colSpan={3}>{o.label}</td>
                    <td className="border border-black px-3 py-2 text-right tabular-nums">− {money(o.amount)}</td>
                  </tr>
                ))}
                {manualDiscount > 0.5 && (
                  <tr>
                    <td className="border border-black px-3 py-2 text-right" colSpan={3}>
                      Discount{showPct ? ` — ${wholePct}% off` : ""}
                    </td>
                    <td className="border border-black px-3 py-2 text-right tabular-nums">− {money(manualDiscount)}</td>
                  </tr>
                )}
                <tr className="text-[15px] font-semibold">
                  <td className="border border-black px-3 py-3" colSpan={2}>
                    <span className="text-xs uppercase tracking-wide text-slate-500">Sold by</span>{" "}
                    {sale.sold_by || ""}
                  </td>
                  <td className="border border-black px-3 py-3 text-right uppercase">Total</td>
                  <td className="border border-black px-3 py-3 text-right text-lg tabular-nums">{money(sale.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {sale.status !== "completed" && (
            <p className="mt-2 text-center text-sm font-semibold uppercase tracking-wide text-rose-600">
              {sale.status}
            </p>
          )}

          {/* footer / contact */}
          <div className="keep mt-3 border border-black px-4 py-4">
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
          <div className="keep mt-3 border border-black px-4 py-3">
            <p className="text-sm font-bold uppercase tracking-wide">Terms &amp; Conditions</p>
            <ul className="mt-1 space-y-0.5 text-[13px]">
              <li>• Thank you for your purchase.</li>
              <li>• No Exchange, No Return, No Refund.</li>
            </ul>
          </div>

          <div className="keep flex items-center justify-center gap-3 py-3">
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
    <div className="bill-cell w-24 shrink-0 border-r border-black px-3 py-3 text-xs font-semibold uppercase tracking-wide sm:w-36 sm:px-4">
      {children}
    </div>
  );
}
// Used for the Order No. / Date pair, which share one row. Those two values must
// never wrap — a bill number broken over three lines is what made the header
// look unstructured. min-w-0 lets the flex child shrink instead of overflowing.
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex">
      <LabelCell>{label}</LabelCell>
      <div className="bill-cell nowrap min-w-0 flex-1 whitespace-nowrap px-4 py-3">{value}</div>
    </div>
  );
}
function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex border-b border-black">
      <LabelCell>{label}</LabelCell>
      <div className="bill-cell flex-1 px-4 py-3">{value || " "}</div>
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
