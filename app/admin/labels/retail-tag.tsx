"use client";

// The RETAIL hang-tag — the statutory label that goes on a garment going to a
// shop, as opposed to the plain booth sticker (brand + name + size + QR).
//
// India's Legal Metrology (Packaged Commodities) Rules want six things on a
// pre-packed garment: the generic name, net quantity, month & year of
// manufacture, the MRP marked "incl. of all taxes", the manufacturer's name and
// address, and a consumer-care contact. Every one of those is a field below —
// none of them is decoration, so none of them should be dropped to win space.

import { isTshirt } from "@/lib/product-type";

export type TagRow = {
  variant_sku: string;
  style_code: string;
  name: string;
  color: string | null;
  size: string;
  price: number;
  category: string | null;
  ean13: string | null;
  mfg: string | null; // "MM/YYYY", already converted to IST by the route
};

// Fixed on the tag — the declared manufacturer and the consumer-care contact.
// These are legal text: change them here and they change on every tag at once.
export const MAKER = {
  name: "LD Cotton Mills",
  lines: ["AC Building, Raj Laxmi Complex", "2nd Floor"],
  email: "buisness@vhagar.co",
};

// What the barcode carries. A real EAN-13 when the variant has one; until GS1
// numbers exist, a Code128 of the SKU — which our own scanners read fine, it
// just isn't a retail GTIN.
export function barcodeFor(row: TagRow): { value: string; format: "EAN13" | "CODE128"; retail: boolean } {
  return row.ean13
    ? { value: row.ean13, format: "EAN13", retail: true }
    : { value: row.variant_sku, format: "CODE128", retail: false };
}

// EAN-13 is printed in its conventional 1-6-6 grouping, which is how the eye
// checks a number against a carton; Code128 just gets the SKU under it.
function humanCode(value: string, retail: boolean) {
  if (!retail || value.length !== 13) return value;
  return `${value.slice(0, 1)} ${value.slice(1, 7)} ${value.slice(7)}`;
}

const money = (n: number) =>
  new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-[0.8mm] leading-[1.25]">
      <span className="w-[13mm] shrink-0 text-black/70">{k}</span>
      {/* one line, clipped: several products carry a whole sentence in `color`,
          and a wrapping value would push the maker block off the bottom edge */}
      <span className="line-clamp-1 min-w-0 flex-1 break-all font-semibold text-black">: {v}</span>
    </div>
  );
}

export function RetailTag({
  row,
  qrUrl,
  barUrl,
}: {
  row: TagRow;
  qrUrl?: string;
  barUrl?: string;
}) {
  const bar = barcodeFor(row);
  // PRODUCT is the generic name the rules ask for, derived from the category the
  // whole system already splits on — never hand-typed per style.
  const product = isTshirt(row.category) ? "T-shirt" : "Shirt";

  return (
    <div className="flex h-full w-full flex-col text-black">
      {/* brand + style code */}
      <div className="text-center">
        <p className="text-[9pt] font-extrabold uppercase leading-none tracking-[0.3em]">Vhagar</p>
        <p className="mt-[0.6mm] font-mono text-[6.5pt] font-bold leading-none tracking-wide">
          {row.style_code}
        </p>
      </div>

      <div className="my-[1mm] border-t border-black" />

      {/* the declared particulars */}
      <div className="space-y-[0.4mm] text-[5.6pt]">
        <Field k="PRODUCT" v={product} />
        <Field k="Size" v={row.size} />
        {row.color && <Field k="Colour" v={row.color} />}
        <Field k="Mfg. Mo/Yr" v={row.mfg ?? "—"} />
        <Field k="Net Qty" v="1 N" />
      </div>

      {/* MRP — the one number a customer looks for, so it gets the big type */}
      <div className="mt-[1mm] border-y border-black py-[0.8mm] text-center">
        <p className="text-[8.5pt] font-extrabold leading-none">MRP ₹ {money(row.price)}</p>
        <p className="mt-[0.4mm] text-[4.6pt] leading-none text-black/70">(Incl. of all taxes)</p>
      </div>

      {/* barcode */}
      <div className="mt-[1.2mm] flex flex-col items-center">
        {barUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={barUrl} alt={bar.value} className="tag-img h-[13mm] w-[38mm] object-fill" />
        ) : (
          <div className="h-[13mm] w-[38mm] bg-slate-100" aria-hidden />
        )}
        <p className="mt-[0.5mm] font-mono text-[5.4pt] font-semibold leading-none tracking-[0.08em]">
          {humanCode(bar.value, bar.retail)}
        </p>
      </div>

      {/* QR — the code our own POS and IMS scan; unchanged from the booth sticker */}
      <div className="mt-[1.5mm] flex justify-center">
        {qrUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qrUrl} alt={row.variant_sku} className="tag-img h-[21mm] w-[21mm]" />
        ) : (
          <div className="h-[21mm] w-[21mm] bg-slate-100" aria-hidden />
        )}
      </div>

      {/* manufacturer + consumer care — pushed to the foot of the tag */}
      <div className="mt-auto pt-[1mm] text-[4.8pt] leading-[1.3]">
        <div className="border-t border-black pt-[0.8mm]">
          <p className="font-bold uppercase">Mfd. &amp; Mktd. by {MAKER.name}</p>
          {MAKER.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
          <p className="mt-[0.5mm]">
            <span className="font-semibold">Customer care: </span>
            {MAKER.email}
          </p>
        </div>
      </div>
    </div>
  );
}
