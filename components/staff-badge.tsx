"use client";

import { useEffect, useState } from "react";
import { staffName, switchStaff } from "@/lib/staff";

// Who is logged in on this device (from the booth gate). This is the operator
// ID — NOT "Sold by", which is picked per sale on the sell screen.
export default function StaffBadge() {
  const [name, setName] = useState("");
  useEffect(() => setName(staffName()), []); // sessionStorage is client-only
  if (!name) return null;
  return (
    <span className="flex items-center gap-2 text-sm text-slate-500">
      Signed in as <b className="text-brand">{name}</b>
      <button onClick={switchStaff} className="text-xs underline">Switch</button>
    </span>
  );
}
