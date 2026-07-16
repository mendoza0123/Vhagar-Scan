"use client";

import { useState } from "react";

// Freebie photo on the bill. Falls back to a 🎁 tile if the image is missing
// (e.g. the PNG hasn't been dropped into /public/freebies yet) so the bill
// never shows a broken-image icon.
export default function FreebieThumb({ src, alt }: { src: string; alt: string }) {
  const [ok, setOk] = useState(Boolean(src));
  if (!ok) {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-black text-base">
        🎁
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      onError={() => setOk(false)}
      className="h-8 w-8 shrink-0 rounded-md border border-black object-cover"
    />
  );
}
