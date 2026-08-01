// Shirt vs T-shirt is DERIVED from the free-text category: "any category
// containing T-SHIRT" (PRINTED / PLAIN / POLO T-SHIRT, "T SHIRT", "tshirt", …)
// is a t-shirt; everything else is a shirt. Punctuation/spacing-insensitive.
// (Kept in sync with the IMS copy — same rule both sides of the shared DB.)
export type ProductType = "shirt" | "tshirt";

export const isTshirt = (category?: string | null): boolean =>
  /tshirt/.test((category ?? "").toLowerCase().replace(/[^a-z]/g, ""));

export const productType = (category?: string | null): ProductType =>
  isTshirt(category) ? "tshirt" : "shirt";

export const matchesType = (filter: "all" | ProductType, category?: string | null): boolean =>
  filter === "all" || productType(category) === filter;
