// Small formatting helpers shared by client + server.
// Currency symbol comes from env (NEXT_PUBLIC_* is exposed to the client).
export const CURRENCY = process.env.NEXT_PUBLIC_CURRENCY || "₹";

/** Format a money amount the Indian way, prefixed with the currency symbol. */
export function money(n: number | string | null | undefined): string {
  const v = typeof n === "string" ? parseFloat(n) : n ?? 0;
  const safe = Number.isFinite(v) ? (v as number) : 0;
  return `${CURRENCY}${safe.toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

/** Human-friendly bill number derived from the sale id (e.g. VH-2026-0001). */
export function billNo(id: number | string): string {
  return `VH-2026-${String(id).padStart(4, "0")}`;
}

/** Short date+time for bills/logs, in the booth's timezone (India). */
export function billDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
