import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vhagar POS",
  description: "Scan-to-bill POS for Vhagar Clothing @ Bharat Tex 2026",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Vhagar" },
};

export const viewport: Viewport = {
  themeColor: "#0e4d92",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1, // stop iOS zoom-on-focus at the booth
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="mx-auto min-h-full max-w-md">{children}</div>
      </body>
    </html>
  );
}
