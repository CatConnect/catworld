"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleX } from "lucide-react";

export function CancelQueueButton({ queued }: { queued: number }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const router = useRouter();

  if (queued === 0 || done) return null;

  const handleCancel = async () => {
    if (!confirm(`${queued} upload(s) na fila. Cancelar todos?`)) return;
    setLoading(true);
    await fetch("/api/v1/uploads/cancel-all", { method: "POST" });
    setLoading(false);
    setDone(true);
    router.refresh();
  };

  return (
    <button
      className="btn btn-error btn-outline btn-sm gap-1"
      onClick={handleCancel}
      disabled={loading}
    >
      <CircleX size={14} />
      {loading ? "Cancelando..." : `Cancelar fila (${queued})`}
    </button>
  );
}
