// Read an .xlsx into rows of strings. No dependency: an xlsx IS a zip of XML,
// and node's zlib already inflates it.
//
//   import { readXlsx, sheetNames } from "./xlsx.mjs";
//   const rows = readXlsx("book.xlsx", /stock.?register/i);
//
// Enough of the format to read a plain data sheet — shared strings, inline
// strings, numbers, and gaps. Not formulas-as-formulas (the cached value is
// used, which is what a data export holds anyway) and not dates-as-dates.
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

function unzip(buf) {
  // walk back from the end for the End Of Central Directory record
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    // the local header repeats name/extra at its own lengths, so re-read them
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// Excel writes these parts with a namespace prefix as often as not (<x:sheet>,
// <x:row>), so every tag below has to tolerate one.
const NS = "(?:\\w+:)?";
const tag = (name, flags = "g") => new RegExp(`<${NS}${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${NS}${name}>`, flags);

const unescapeXml = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, "&");

// "BC" -> 54 (zero-based column index)
const colOf = (ref) => {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

function sharedStrings(files) {
  const xml = files.get("xl/sharedStrings.xml");
  if (!xml) return [];
  const out = [];
  // one <si> per string; rich text splits it into several <t> runs to rejoin
  for (const m of xml.toString("utf8").matchAll(tag("si"))) {
    let s = "";
    for (const t of m[1].matchAll(tag("t"))) s += unescapeXml(t[1]);
    out.push(s);
  }
  return out;
}

function sheetTargets(files) {
  // name -> part path, via workbook.xml + its rels
  const wb = files.get("xl/workbook.xml")?.toString("utf8") || "";
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") || "";
  const byId = new Map();
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) byId.set(id, target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, ""));
  }
  const out = [];
  for (const m of wb.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = unescapeXml(/name="([^"]*)"/.exec(m[0])?.[1] || "");
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const path = byId.get(rid);
    if (name && path) out.push({ name, path });
  }
  return out;
}

export function sheetNames(file) {
  return sheetTargets(unzip(readFileSync(file))).map((s) => s.name);
}

export function readXlsx(file, want) {
  const files = unzip(readFileSync(file));
  const sheets = sheetTargets(files);
  if (!sheets.length) throw new Error("no sheets in " + file);
  const pick = want
    ? sheets.find((s) => (want instanceof RegExp ? want.test(s.name) : s.name === want))
    : sheets[0];
  if (!pick) throw new Error(`no sheet matching ${want} — have: ${sheets.map((s) => s.name).join(", ")}`);
  const xml = files.get(pick.path);
  if (!xml) throw new Error("missing sheet part " + pick.path);
  const strings = sharedStrings(files);

  const rows = [];
  const rowRe = new RegExp(`<${NS}row\\b([^>]*)>([\\s\\S]*?)<\\/${NS}row>`, "g");
  const cellRe = new RegExp(`<${NS}c\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${NS}c>)`, "g");
  const valRe = new RegExp(`<${NS}v(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${NS}v>`);
  for (const rm of xml.toString("utf8").matchAll(rowRe)) {
    const rIdx = parseInt(/r="(\d+)"/.exec(rm[1])?.[1] || "0", 10) - 1;
    const cells = [];
    for (const cm of rm[2].matchAll(cellRe)) {
      const attrs = cm[1] ?? "", body = cm[2] ?? "";
      const i = colOf(/r="([A-Z]+)/.exec(attrs)?.[1] || "");
      if (i < 0) continue;
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      let v = "";
      if (t === "inlineStr") {
        for (const x of body.matchAll(tag("t"))) v += unescapeXml(x[1]);
      } else {
        const raw = valRe.exec(body)?.[1];
        if (raw != null) v = t === "s" ? (strings[+raw] ?? "") : unescapeXml(raw);
      }
      cells[i] = v;
    }
    rows[rIdx >= 0 ? rIdx : rows.length] = cells;
  }
  // fill gaps so row/column indexes stay honest
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]) rows[i] = [];
    for (let j = 0; j < rows[i].length; j++) if (rows[i][j] == null) rows[i][j] = "";
  }
  return { rows, sheet: pick.name, sheets: sheets.map((s) => s.name) };
}
