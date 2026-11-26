"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import RestickScreen from "@/components/RestickScreen";
import { useStaffList } from "@/lib/use-staff-list";

// Admin → QR Re-stick. The save sets stock, so it carries the booth PIN that
// Admin stored for this tab; the server checks it again.
const PIN_KEY = "vhagar.admin.pin";

export default function RestickPage() {
  const staff = useStaffList();
  const [pin, setPin] = useState<string | null | undefined>(undefined);
  useEffect(() => { try { setPin(sessionStorage.getItem(PIN_KEY)); } catch { setPin(null); } }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link href="/admin" className="text-sm font-medium text-brand">← Admin</Link>
        <h1 className="text-lg font-bold text-brand">QR Re-stick</h1>
        <span className="w-12" />
      </header>
      {pin === null ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Enter the booth PIN in <Link href="/admin" className="font-semibold underline">Admin</Link> first, then come back.
        </p>
      ) : pin ? (
        <RestickScreen source="pos" pin={pin} staff={staff} printBase="/admin/labels?batch=" />
      ) : null}
    </main>
  );
}
