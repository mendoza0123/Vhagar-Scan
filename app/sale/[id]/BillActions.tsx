"use client";

import Link from "next/link";

type Props = {
  billNo: string;
  shareText: string;
};

export default function BillActions({ billNo, shareText }: Props) {
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: billNo, text: shareText });
      else {
        await navigator.clipboard.writeText(shareText);
        alert("Bill copied to clipboard");
      }
    } catch {
      /* user cancelled */
    }
  };

  return (
    <div className="grid grid-cols-2 gap-2 print:hidden">
      <button onClick={() => window.print()} className="btn btn-primary">
        🖨 Print
      </button>
      <button onClick={share} className="btn btn-ghost">
        Share
      </button>
      <Link href="/sell" className="btn btn-ghost col-span-2 text-center">
        ＋ New sale
      </Link>
    </div>
  );
}
