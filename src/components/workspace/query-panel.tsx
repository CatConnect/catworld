"use client";
import { useRef, useState } from "react";
import { Braces, ChevronRight, Database, Download, Play } from "lucide-react";

type Table = { id: string; name: string; sqlName: string; columns: { sqlName: string }[] };
type Dataset = { id: string; name: string; schemaName: string; tables: Table[] };
type Result = { columns: string[]; rows: Record<string, unknown>[]; executionTimeMs: number; truncated: boolean };

export function QueryPanel({ datasets }: { datasets: Dataset[] }) {
  const [sql, setSql] = useState("SELECT TOP 100 *\nFROM ");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(datasets[0]?.id ?? null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function insertAtCursor(text: string) {
    const el = textareaRef.current;
    if (!el) { setSql((s) => s + text); return; }
    const start = el.selectionStart ?? sql.length, end = el.selectionEnd ?? sql.length;
    const next = sql.slice(0, start) + text + sql.slice(end);
    setSql(next);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + text.length; });
  }

  async function download(format: "csv" | "xlsx") {
    const response = await fetch("/api/v1/queries/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql, format }) });
    if (!response.ok) return;
    const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `query.${format}`; a.click(); URL.revokeObjectURL(url);
  }
  async function execute() {
    setRunning(true); setError("");
    try {
      const response = await fetch("/api/v1/queries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql, limit: 10000, timeout: 30 }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Falha na consulta");
      setResult(body.data);
    } catch (e) { setError(e instanceof Error ? e.message : "Falha na consulta"); }
    finally { setRunning(false); }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[240px_1fr]">
      <div className="rounded-box border border-base-300 bg-base-100">
        <div className="border-b border-base-300 px-4 py-3 text-sm font-medium">Schema do projeto</div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {datasets.map((d) => (
            <div key={d.id}>
              <button onClick={() => setExpanded(expanded === d.id ? null : d.id)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-base-200">
                <ChevronRight size={13} className={`transition-transform ${expanded === d.id ? "rotate-90" : ""}`} /><Database size={13} className="text-primary" />{d.name}
              </button>
              {expanded === d.id && (
                <div className="ml-5 space-y-0.5 border-l border-base-300 pl-2">
                  {d.tables.map((t) => (
                    <button key={t.id} onClick={() => insertAtCursor(`[${d.schemaName}].[${t.sqlName}]`)} className="block w-full truncate rounded px-2 py-1 text-left text-xs text-base-content/70 hover:bg-base-200" title={`Inserir [${d.schemaName}].[${t.sqlName}]`}>
                      {t.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-5">
        <div className="rounded-box border border-base-300 bg-base-100">
          <div className="flex items-center justify-between border-b border-base-300 px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-medium"><Braces size={15} />Consulta</span>
            <button onClick={execute} disabled={running} className="btn btn-primary btn-sm"><Play size={14} />{running ? "Executando..." : "Executar"}</button>
          </div>
          <textarea ref={textareaRef} aria-label="Editor SQL" value={sql} onChange={(e) => setSql(e.target.value)} className="textarea h-56 w-full resize-none rounded-none border-0 bg-neutral p-5 font-mono text-sm leading-6 text-neutral-content" spellCheck={false} />
          {error && <div className="alert alert-error alert-soft m-4">{error}</div>}
        </div>
        <div className="rounded-box border border-base-300 bg-base-100">
          <div className="flex items-center justify-between border-b border-base-300 px-4 py-3">
            <span className="text-sm font-medium">Resultado</span>
            {result && <div className="flex items-center gap-2"><span className="text-xs text-base-content/50">{result.executionTimeMs} ms · {result.rows.length} linhas</span><button onClick={() => download("csv")} className="btn btn-outline btn-xs"><Download size={13} />CSV</button><button onClick={() => download("xlsx")} className="btn btn-outline btn-xs">XLSX</button></div>}
          </div>
          {!result ? <div className="grid min-h-40 place-items-center text-sm text-base-content/45">Execute a consulta para ver o resultado.</div> : (
            <div className="overflow-x-auto">
              <table className="table table-zebra data-grid"><thead><tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>{result.rows.map((r, i) => <tr key={i}>{result.columns.map((c) => <td key={c}>{String(r[c] ?? "NULL")}</td>)}</tr>)}</tbody></table>
              {result.truncated && <div className="alert alert-warning m-4">Resultado truncado no limite configurado.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
