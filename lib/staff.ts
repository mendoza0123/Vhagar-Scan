// Who is on this device right now.
//
// The booth PIN is shared, so it says nothing about WHO acted. The gate also
// asks for a name, and that name is stamped on every sale (sold_by) and every
// rack move — so each action has a person against it. Session-scoped on
// purpose: closing the tab re-asks, and handing the tablet to the other counter
// person means pressing Switch, which re-locks and asks again.

export const PIN_KEY = "vhagar.admin.pin"; // shared with the Admin gate — one PIN unlocks both
export const STAFF_KEY = "vhagar.staff.name";

export function staffName(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem(STAFF_KEY) || "";
}

// Drop the identity AND the PIN, so the gate asks the next person for both.
export function switchStaff() {
  sessionStorage.removeItem(STAFF_KEY);
  sessionStorage.removeItem(PIN_KEY);
  location.reload();
}

// The "Sold by" names are managed in IMS -> Admin -> POS staff (table pos_staff)
// and served by /api/staff. BASE_STAFF only covers a phone that has never
// reached the server; after that it keeps the last list it saw.
export const BASE_STAFF = ["Aditya", "Naushi", "Krupa", "Pankaj", "Deepika", "Hiren", "Rohan"];
// people who have left: a phone that still remembers one as "Sold by" starts blank
const LEFT = ["angel", "bindu", "sania", "saniya"];
export const hasLeft = (name: string) => LEFT.includes(name.trim().toLowerCase());
