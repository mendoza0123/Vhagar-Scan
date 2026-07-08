import { NextRequest } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";
import { billNo } from "@/lib/format";

export const dynamic = "force-dynamic";

// CSV-escape: wrap in quotes and double any inner quotes.
function csv(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

// GET /api/sales/export?date=today  → CSV of every sale line item joined to its bill.
// One row per item; the backup habit for the booth.
export async function GET(req: NextRequest) {
  noStore();
  const todayOnly = req.nextUrl.searchParams.get("date") === "today";

  const rows = todayOnly
    ? await sql`
        SELECT s.id, s.bill_no, s.created_at, s.sold_by, s.payment_method, s.channel,
               s.subtotal::float8 AS subtotal, s.discount::float8 AS discount,
               s.total::float8 AS total, s.status,
               si.variant_sku, si.name, si.size,
               si.unit_price::float8 AS unit_price, si.qty,
               si.line_total::float8 AS line_total
        FROM sales s JOIN sale_items si ON si.sale_id = s.id
        WHERE (s.created_at AT TIME ZONE 'Asia/Kolkata')::date
              = (now() AT TIME ZONE 'Asia/Kolkata')::date
        ORDER BY s.id DESC, si.id`
    : await sql`
        SELECT s.id, s.bill_no, s.created_at, s.sold_by, s.payment_method, s.channel,
               s.subtotal::float8 AS subtotal, s.discount::float8 AS discount,
               s.total::float8 AS total, s.status,
               si.variant_sku, si.name, si.size,
               si.unit_price::float8 AS unit_price, si.qty,
               si.line_total::float8 AS line_total
        FROM sales s JOIN sale_items si ON si.sale_id = s.id
        ORDER BY s.id DESC, si.id`;

  const header = [
    "bill_no", "datetime", "channel", "sold_by", "payment", "sku", "item", "size",
    "qty", "unit_price", "line_total", "bill_subtotal", "bill_discount",
    "bill_total", "status",
  ];

  const lines = [header.map(csv).join(",")];
  for (const r of rows as any[]) {
    lines.push(
      [
        r.bill_no ?? billNo(r.id),
        new Date(r.created_at).toISOString(),
        r.channel,
        r.sold_by,
        r.payment_method,
        r.variant_sku,
        r.name,
        r.size,
        r.qty,
        r.unit_price,
        r.line_total,
        r.subtotal,
        r.discount,
        r.total,
        r.status,
      ]
        .map(csv)
        .join(",")
    );
  }

  const body = "﻿" + lines.join("\r\n"); // BOM so Excel reads UTF-8
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="vhagar-sales-${
        todayOnly ? "today-" : ""
      }${stamp}.csv"`,
    },
  });
}
