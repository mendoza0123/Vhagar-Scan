"use client";

import { useEffect, useRef, useState } from "react";

// Live QR scanner. html5-qrcode touches the DOM/camera, so we import it lazily
// inside the effect (never on the server) and clean it up on unmount.
export default function Scanner({ onScan }: { onScan: (text: string) => void }) {
  const elementId = "qr-reader";
  const [error, setError] = useState<string | null>(null);

  // Keep the latest callback without restarting the camera on every render.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let html5: any = null;
    let cancelled = false;

    (async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (cancelled) return;
        html5 = new Html5Qrcode(elementId, { verbose: false });
        await html5.start(
          { facingMode: "environment" }, // rear camera
          {
            fps: 10,
            qrbox: (w: number, h: number) => {
              const s = Math.floor(Math.min(w, h) * 0.72);
              return { width: s, height: s };
            },
            aspectRatio: 1.0,
          },
          (decoded: string) => onScanRef.current(decoded),
          () => {} // per-frame "not found" — ignore, fires constantly
        );
        // Effect was torn down while the camera was starting up.
        if (cancelled) {
          try {
            await html5.stop();
          } catch {
            /* noop */
          }
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(
            e?.message?.includes("Permission")
              ? "Camera permission denied."
              : "Could not start the camera."
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      if (html5) {
        html5
          .stop()
          .then(() => html5.clear())
          .catch(() => {});
      }
    };
  }, []);

  return (
    <div>
      <div id={elementId} className="aspect-square w-full overflow-hidden rounded-2xl bg-black" />
      {error ? (
        <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          📷 {error} Use search below instead.
        </p>
      ) : (
        <p className="mt-2 text-center text-xs text-slate-400">
          Point at a garment tag — hold steady
        </p>
      )}
    </div>
  );
}
