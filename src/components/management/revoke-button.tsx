"use client";
import { useState } from "react";
import { Ban } from "lucide-react";
import { useRouter } from "next/navigation";

export function RevokeButton({ url, label = "Revogar", confirmText, method = "DELETE" }: { url: string; label?: string; confirmText: string; method?: "DELETE" }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  async function revoke() {
    if (!confirm(confirmText)) return;
    setLoading(true);
    await fetch(url, { method });
    setLoading(false);
    router.refresh();
  }
  return <button onClick={revoke} disabled={loading} className="btn btn-ghost btn-xs text-error"><Ban size={13} />{loading ? "..." : label}</button>;
}
