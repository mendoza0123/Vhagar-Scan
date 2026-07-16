import Link from "next/link";

const TILES = [
  { href: "/sell", label: "Scan & Sell", emoji: "📷", primary: true, sub: "Scan a tag, build the bill" },
  { href: "/find", label: "Find", emoji: "🔎", sub: "Scan a piece — rack or carton?" },
  { href: "/rack", label: "Move to Rack", emoji: "➡️", sub: "Unpack a box onto the rack" },
  { href: "/stock", label: "Live Stock", emoji: "📦", sub: "Inventory by style & size" },
  { href: "/sales", label: "Sales Log", emoji: "🧾", sub: "Today's bills & total" },
  { href: "/admin", label: "Admin & Labels", emoji: "⚙️", sub: "Prices + print QR labels" },
];

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col gap-4 p-5">
      <header className="pb-2 pt-6">
        <h1 className="text-3xl font-bold tracking-tight text-brand">Vhagar POS</h1>
        <p className="text-sm text-slate-500">Bharat Tex 2026 · scan-to-bill</p>
      </header>

      <nav className="grid grid-cols-1 gap-3">
        {TILES.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`flex items-center gap-4 rounded-2xl border p-5 shadow-sm transition active:scale-[0.99] ${
              t.primary ? "border-brand bg-brand text-white" : "border-slate-200 bg-white"
            }`}
          >
            <span className="text-3xl">{t.emoji}</span>
            <span>
              <span className="block text-lg font-semibold">{t.label}</span>
              <span className={`block text-sm ${t.primary ? "text-blue-100" : "text-slate-500"}`}>{t.sub}</span>
            </span>
          </Link>
        ))}
      </nav>

      <footer className="mt-auto pt-6 text-center text-xs text-slate-400">
        Vhagar Clothing · LD Group
      </footer>
    </main>
  );
}
