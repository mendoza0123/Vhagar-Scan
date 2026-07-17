// One rule for what counts as a customer mobile, shared by the sell screen,
// the bill editor and the API — so a 9-digit typo can't slip in anywhere.
//
// Accepts the ways people actually type an Indian mobile — bare 10 digits,
// +91/91-prefixed, 0-prefixed, with spaces/dashes — and returns the clean
// 10-digit number, or null when it isn't a real mobile (must start 6–9).
export function normalizePhone(raw: string | null | undefined): string | null {
  let d = (raw || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
