"use client";
import { useState } from "react";
import { Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";

export function RotateButton({ id }: { id: string }) {
  const router = useRouter();
  const [secret, setSecret] = useState(""), [show, setShow] = useState(false), [loading, setLoading] = useState(false);
  async function rotate() {
    if (!confirm("Rotacionar a senha deste usuário SQL? A senha atual deixará de funcionar imediatamente.")) return;
    setLoading(true);
    const response = await fetch(`/api/v1/database-users/${id}/rotate`, { method: "POST" });
    const body = await response.json();
    setLoading(false);
    if (response.ok) setSecret(body.data.secret);
    router.refresh();
  }
  if (secret) return (
    <div className="join">
      <input readOnly value={show ? secret : "•".repeat(20)} className="input input-xs join-item w-32 font-mono" />
      <button onClick={() => setShow(!show)} className="btn btn-xs join-item">{show ? <EyeOff size={12} /> : <Eye size={12} />}</button>
      <button onClick={() => navigator.clipboard.writeText(secret)} className="btn btn-xs join-item"><Copy size={12} /></button>
    </div>
  );
  return <button onClick={rotate} disabled={loading} className="btn btn-ghost btn-xs"><RefreshCw size={13} />{loading ? "..." : "Rotacionar"}</button>;
}
