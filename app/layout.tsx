import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteGate } from "@/components/site-gate";

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
        <SiteGate>
          <div className="mx-auto min-h-full max-w-md">{children}</div>
        </SiteGate>
      </body>
    </html>
  );
}
