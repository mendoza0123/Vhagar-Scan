import { sql } from "@/lib/db";

// QR re-stick — the queries behind the QR Labels screen. This file is the SAME
// in the POS (e:\vhagar-pos\lib\restick.ts) and the IMS (e:\vhagar-ims\lib\restick.ts):
// change one, copy it to the other. Every write is a SQL function — restick(),
// restick_edit(), restick_void(), restick_delete() in e:\vhagar-ims\db\
// ims-restick-v21.sql + v22.sql — so the two apps can't drift.
// A voided re-stick never counts as "re-stuck" anywhere below.

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL", "4XL", "5XL"];

export type RestickSize = {
  sku: string;
  size: string;
  qty: number;                               // IMS stock now
  codes: number;                             // in-stock unique codes now
  boxes: { box: string; qty: number }[];     // where the box index says the pieces are
  last_at: string | null;                    // last re-stick of this size (IST text)
};
export type RestickBatchRow = {
  id: string; style_code: string; name: string; rack: number | null; remark: string | null;
  source: "ims" | "pos"; created_by: string | null; at: string; printed_at: string | null;
  pcs: number; sizes: string; voided_at: string | null; voided_by: string | null;
};
export type RestickBatch = {
  id: string; style_code: string; name: string; rack: number | null; remark: string | null;
  source: string; created_by: string | null; created_at: string; printed_at: string | null;
  voided_at: string | null; voided_by: string | null;
  replayed?: boolean;
  added?: string[];     // restick_edit: new codes (print these)
  removed?: string[];   // restick_edit: codes retired (peel these)
  lines: { sku: string; size: string; ims_qty: number; counted: number; retired: number; boxed_cut: number }[];
  codes: { code: string; sku: string; status: string }[];
};

// "lio linen" → one row per design
export async function findDesigns(q: string) {
  const like = `%${q.trim()}%`;
  return (await sql`
    SELECT v.style_code, p.name, p.color, SUM(v.qty_on_hand)::int AS qty,
           (SELECT to_char(MAX(r.created_at) AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH24:MI')
              FROM ims_restick r WHERE r.style_code = v.style_code AND r.voided_at IS NULL) AS restuck_at
    FROM variants v
    JOIN products p ON p.style_code = v.style_code
    WHERE v.variant_sku ILIKE ${like} OR p.name ILIKE ${like} OR v.style_code ILIKE ${like}
    GROUP BY v.style_code, p.name, p.color
    ORDER BY p.name, v.style_code
    LIMIT 60`) as { style_code: string; name: string; color: string | null; qty: number; restuck_at: string | null }[];
}

// every size of one design, with its stock, codes and boxes
export async function styleSizes(style: string) {
  const s = style.trim().toUpperCase();
  const head = (await sql`SELECT style_code, name, color, category FROM products WHERE style_code = ${s}`)[0] as
    { style_code: string; name: string; color: string | null; category: string | null } | undefined;
  if (!head) return null;
  const sizes = (await sql`
    SELECT v.variant_sku AS sku, v.size, v.qty_on_hand AS qty,
           (SELECT count(*)::int FROM ims_units u WHERE u.variant_sku = v.variant_sku AND u.status = 'in_stock') AS codes,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'box', CASE c.status WHEN 'Display' THEN 'Display' WHEN 'Rack' THEN 'Booth rack' ELSE c.carton_no END,
                       'qty', ci.qty) ORDER BY c.status <> 'Display', c.status <> 'Rack', c.carton_no)
                       FROM ims_carton_items ci JOIN ims_cartons c ON c.id = ci.carton_id
                      WHERE ci.variant_sku = v.variant_sku AND c.status IN ('Display','Rack','Packed')), '[]'::jsonb) AS boxes,
           (SELECT to_char(MAX(r.created_at) AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH24:MI')
              FROM ims_restick_lines l JOIN ims_restick r ON r.id = l.restick_id
             WHERE l.variant_sku = v.variant_sku AND r.voided_at IS NULL) AS last_at
    FROM variants v
    WHERE v.style_code = ${s}
    ORDER BY COALESCE(array_position(${SIZE_ORDER}::text[], upper(v.size)), 99), v.size`) as RestickSize[];
  return { ...head, sizes };
}

// recent batches from both apps (all products, or one)
export async function recentBatches(style?: string) {
  const s = style ? style.trim().toUpperCase() : null;
  return (await sql`
    SELECT r.id, r.style_code, p.name, r.rack, r.remark, r.source, r.created_by,
           to_char(r.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH24:MI') AS at,
           to_char(r.printed_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH24:MI') AS printed_at,
           to_char(r.voided_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH24:MI') AS voided_at, r.voided_by,
           COALESCE(SUM(l.counted), 0)::int AS pcs,
           COALESCE(string_agg(v.size || ' ' || l.counted, ' · '
             ORDER BY COALESCE(array_position(${SIZE_ORDER}::text[], upper(v.size)), 99)), '') AS sizes
    FROM ims_restick r
    JOIN products p ON p.style_code = r.style_code
    LEFT JOIN ims_restick_lines l ON l.restick_id = r.id
    LEFT JOIN variants v ON v.variant_sku = l.variant_sku
    WHERE ${s}::text IS NULL OR r.style_code = ${s}
    GROUP BY r.id, p.name
    ORDER BY r.created_at DESC
    LIMIT 40`) as RestickBatchRow[];
}

// The home grid: every design worth re-sticking (has stock, or already re-stuck),
// the same set the progress count uses. The screen groups them into families.
export type GridStyle = { style_code: string; name: string; image: string | null; qty: number; restuck: boolean };
export async function styleGrid() {
  return (await sql`
    SELECT v.style_code, p.name, p.image_url AS image, SUM(v.qty_on_hand)::int AS qty,
           EXISTS (SELECT 1 FROM ims_restick r WHERE r.style_code = v.style_code AND r.voided_at IS NULL) AS restuck
    FROM variants v JOIN products p ON p.style_code = v.style_code
    GROUP BY v.style_code, p.name, p.image_url
    HAVING SUM(v.qty_on_hand) > 0 OR EXISTS (SELECT 1 FROM ims_restick r WHERE r.style_code = v.style_code AND r.voided_at IS NULL)
    ORDER BY p.name`) as GridStyle[];
}

// "84 of 323 products re-stuck" — designs with stock, or already re-stuck
export async function progress() {
  const [row] = await sql`
    SELECT (SELECT count(DISTINCT style_code) FROM ims_restick WHERE voided_at IS NULL)::int AS done,
           (SELECT count(*) FROM (
              SELECT style_code FROM variants GROUP BY style_code HAVING SUM(qty_on_hand) > 0
              UNION SELECT style_code FROM ims_restick WHERE voided_at IS NULL) t)::int AS total`;
  return row as { done: number; total: number };
}

export async function getBatch(id: string) {
  const [row] = await sql`SELECT restick_batch(${id}::uuid) AS b`;
  return (row?.b ?? null) as RestickBatch | null;
}

export async function markPrinted(id: string) {
  await sql`UPDATE ims_restick SET printed_at = now() WHERE id = ${id}::uuid`;
}

export type SaveInput = {
  id: string; style: string; rack: number | null; remark: string | null;
  lines: { sku: string; counted: number; seen: number }[];
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cleans what the screen sent; returns an error message or the clean input.
export function parseSave(b: any): SaveInput | string {
  const id = String(b?.id ?? "");
  if (!UUID.test(id)) return "Missing batch id — reload the screen.";
  const style = String(b?.style ?? "").trim().toUpperCase();
  if (!style) return "Pick a product first.";
  const rack = b?.rack == null || b?.rack === "" ? null : Math.trunc(Number(b.rack));
  if (rack != null && !(rack >= 1 && rack <= 5)) return "Rack must be 1 to 5.";
  const lines = (Array.isArray(b?.lines) ? b.lines : []).map((l: any) => ({
    sku: String(l?.sku ?? "").trim().toUpperCase(),
    counted: Math.trunc(Number(l?.counted)),
    seen: Math.trunc(Number(l?.seen)),
  }));
  if (lines.length === 0) return "Tick at least one size.";
  if (lines.length > 30) return "Too many sizes in one save.";
  if (new Set(lines.map((l: any) => l.sku)).size !== lines.length) return "A size is listed twice.";
  if (lines.some((l: any) => !l.sku || !Number.isFinite(l.counted) || l.counted < 0 || l.counted > 999 || !Number.isFinite(l.seen)))
    return "Every ticked size needs a count from 0 to 999.";
  const remark = String(b?.remark ?? "").trim().slice(0, 200) || null;
  return { id, style, rack, remark, lines };
}

export async function saveRestick(input: SaveInput, by: string | null, source: "ims" | "pos") {
  const [row] = await sql`
    SELECT restick(${input.id}::uuid, ${input.style}, ${JSON.stringify(input.lines)}::jsonb,
                   ${input.rack}, ${input.remark}, ${by}, ${source}) AS b`;
  return row.b as RestickBatch;
}

export type EditInput = { rack: number | null; remark: string | null; lines: { sku: string; counted: number }[] };

// PATCH body → clean input or an error message. lines may be empty (rack/remark only).
export function parseEdit(b: any): EditInput | string {
  const rack = b?.rack == null || b?.rack === "" ? null : Math.trunc(Number(b.rack));
  if (rack != null && !(rack >= 1 && rack <= 5)) return "Rack must be 1 to 5.";
  const lines = (Array.isArray(b?.lines) ? b.lines : []).map((l: any) => ({
    sku: String(l?.sku ?? "").trim().toUpperCase(),
    counted: Math.trunc(Number(l?.counted)),
  }));
  if (lines.length > 30) return "Too many sizes in one edit.";
  if (new Set(lines.map((l: any) => l.sku)).size !== lines.length) return "A size is listed twice.";
  if (lines.some((l: any) => !l.sku || !Number.isFinite(l.counted) || l.counted < 0 || l.counted > 999))
    return "Every count must be 0 to 999.";
  const remark = String(b?.remark ?? "").trim().slice(0, 200) || null;
  return { rack, remark, lines };
}

export async function editBatch(id: string, input: EditInput, by: string | null) {
  const [row] = await sql`
    SELECT restick_edit(${id}::uuid, ${JSON.stringify(input.lines)}::jsonb, ${input.rack}, ${input.remark}, ${by}) AS b`;
  return row.b as RestickBatch;
}
export async function voidBatch(id: string, by: string | null) {
  const [row] = await sql`SELECT restick_void(${id}::uuid, ${by}) AS b`;
  return row.b as RestickBatch;
}
export async function deleteBatch(id: string, by: string | null) {
  await sql`SELECT restick_delete(${id}::uuid, ${by})`;
}

export const isUuid = (s: string) => UUID.test(s);

// Postgres error → { status, message } for the screen
export function restickError(err: any): { status: number; error: string; message: string } {
  const msg = String(err?.message || "");
  if (err?.code === "42883" || err?.code === "42P01" || /restick.*does not exist|ims_restick.*does not exist/i.test(msg))
    return { status: 503, error: "not_switched_on", message: "QR re-stick isn't switched on yet (the database update hasn't been run)." };
  if (/stock_moved/.test(msg))
    return { status: 409, error: "stock_moved", message: msg.replace(/^.*?stock_moved:\s*/, "Stock changed: ") };
  if (/restick_locked/.test(msg))
    return { status: 409, error: "locked", message: msg.replace(/^.*?restick_locked:\s*/, "") };
  const clean = msg.replace(/^.*?ERROR:\s*/, "").replace(/^restick:\s*/, "").trim();
  return { status: 400, error: "restick_failed", message: clean || "Could not save the re-stick." };
}
