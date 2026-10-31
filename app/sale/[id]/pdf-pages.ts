// Lays the photographed bill out on A4 pages before html2pdf writes the PDF.
//
// html2pdf on its own cuts the bill image every page-height, wherever that
// falls, and its "don't split this box" option works by inserting blank space
// INSIDE the bill's border. So a bill just 2% too tall came out with its border
// running to the foot of page 1, open-ended, and carrying on round a page 2
// that held nothing but "OWN YOUR FLAME". Instead:
//   - a bill too tall for one page is shrunk onto it (no lower limit: MIN_FIT)
//   - a longer bill is cut only between item rows or between the boxes under
//     them, the item header repeats on the next page, and the border is closed
//     round every page.

export type Cut = {
  y: number; // css px from the top of the captured box
  overlap: number; // css px both pages repeat, so a shared rule shows on each
  inItems: boolean; // cut falls inside the items table → repeat its header
};

export type BillLayout = {
  width: number; // css px width of the captured box
  frameLeft: number;
  frameRight: number;
  border: number; // the thick outer border
  pad: number; // white space between that border and the content
  headTop: number;
  headBottom: number;
  cuts: Cut[];
};

// Smallest a bill is shrunk to keep it on one page. 0 = no floor: EVERY bill is
// shrunk onto ONE page however long (10 items ≈ 70%, 19 items ≈ 55%) — booth
// call, 31 Oct 2026. Set back to 0.8 and long bills get a clean second page
// again (the paging below is untouched, just not reached at 0).
export const MIN_FIT = 0;

// Called from html2canvas's onclone, on the exact copy it photographs, so the
// cut positions match the image (the copy lays out at windowWidth 820, which
// on a phone is not the layout on screen).
export function measureBill(doc: Document): BillLayout | null {
  const root = doc.querySelector<HTMLElement>(".html2pdf__container");
  const frame = root?.querySelector<HTMLElement>("#bill-doc > div");
  const head = frame?.querySelector("thead");
  const body = (head?.parentElement as HTMLTableElement | null)?.tBodies[0];
  if (!root || !frame || !head || !body) return null;

  const r0 = root.getBoundingClientRect();
  const top = (el: Element) => el.getBoundingClientRect().top - r0.top;
  const bottom = (el: Element) => el.getBoundingClientRect().bottom - r0.top;
  const fr = frame.getBoundingClientRect();
  const cs = (doc.defaultView ?? window).getComputedStyle(frame);

  const cuts: Cut[] = [];
  // Between item rows, but never above the first: that would leave the header
  // alone at the foot of a page.
  Array.from(body.rows)
    .slice(1)
    .forEach((r) => cuts.push({ y: top(r), overlap: 1, inItems: true }));
  // Between the boxes after the items (totals, address, terms, sign-off): in
  // the white gap when there is one, else on the rule they share (the totals
  // sit flush under the items).
  const blocks = Array.from(frame.children);
  const first = Math.max(1, blocks.findIndex((b) => b.contains(head)) + 1);
  for (let i = first; i < blocks.length; i++) {
    const gapTop = bottom(blocks[i - 1]);
    const gapBottom = top(blocks[i]);
    cuts.push(
      gapBottom - gapTop >= 4
        ? { y: (gapTop + gapBottom) / 2, overlap: 0, inItems: false }
        : { y: gapBottom, overlap: 1, inItems: false },
    );
  }

  return {
    width: r0.width,
    frameLeft: fr.left - r0.left,
    frameRight: fr.right - r0.left,
    border: parseFloat(cs.borderTopWidth) || 0,
    pad: parseFloat(cs.paddingTop) || 0,
    headTop: top(head),
    headBottom: bottom(head),
    cuts: cuts.sort((a, b) => a.y - b.y),
  };
}

// Returns a canvas html2pdf can slice every `pageRatio * width` pixels and get
// exactly these pages. `pageRatio` must be html2pdf's own inner-page ratio.
export function layoutPages(src: HTMLCanvasElement, L: BillLayout | null, pageRatio: number): HTMLCanvasElement {
  const W = src.width;
  const H = src.height;
  const pageH = Math.floor(W * pageRatio); // the same sum html2pdf slices by
  if (H <= pageH) return src;

  const out = document.createElement("canvas");
  const ctx = out.getContext("2d");
  if (!ctx) return src;
  out.width = W;
  const fillWhite = () => {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
  };

  // A little too tall: shrink the whole bill onto one page, centred.
  if (H * MIN_FIT <= pageH) {
    const f = pageH / H;
    out.height = pageH;
    fillWhite();
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, Math.round((W - W * f) / 2), 0, Math.round(W * f), pageH);
    return out;
  }
  if (!L) return src; // couldn't measure: plain slicing, as before

  const s = W / L.width; // canvas px per css px
  const px = (v: number) => Math.round(v * s);
  const bw = Math.max(1, px(L.border));
  const band = px(L.border + L.pad); // border + padding, as at the top of page 1
  const headTop = px(L.headTop);
  const headH = px(L.headBottom) - headTop;
  const left = px(L.frameLeft);
  const right = px(L.frameRight);
  const cuts = L.cuts.map((c) => ({ y: px(c.y), o: px(c.overlap), inItems: c.inItems }));

  const pages: { from: number; to: number; head: boolean }[] = [];
  for (let from = 0, head = false; pages.length < 40; ) {
    const top = pages.length ? band + (head ? headH : 0) : 0;
    if (H - from <= pageH - top) {
      pages.push({ from, to: H, head });
      break;
    }
    const room = Math.max(1, pageH - top - band);
    const fits = cuts.filter((c) => c.y - c.o > from && c.y + c.o - from <= room);
    const cut = fits[fits.length - 1] ?? { y: from + room, o: 0, inItems: false };
    pages.push({ from, to: cut.y + cut.o, head });
    from = cut.y - cut.o;
    head = cut.inItems;
  }

  out.height = pageH * pages.length;
  fillWhite();
  pages.forEach((p, i) => {
    const P = i * pageH;
    let y = P;
    if (i > 0) {
      y += band;
      if (p.head) {
        ctx.drawImage(src, 0, headTop, W, headH, 0, y, W, headH);
        y += headH;
      }
    }
    const h = p.to - p.from;
    ctx.drawImage(src, 0, p.from, W, h, 0, y, W, h);
    y += h;
    if (i < pages.length - 1) y += band;
    // Close the border round this page. Page 1's top edge and the last page's
    // bottom edge are already in the image; drawing them again is harmless.
    ctx.fillStyle = "#000";
    ctx.fillRect(left, P, right - left, bw);
    ctx.fillRect(left, y - bw, right - left, bw);
    ctx.fillRect(left, P, bw, y - P);
    ctx.fillRect(right - bw, P, bw, y - P);
  });
  return out;
}
