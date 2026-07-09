"use client";
import { useEffect, useRef, useState } from "react";
import { Cable, CheckCircle2, DatabaseZap, Play, Plus, RefreshCw, Table2 } from "lucide-react";

type Connection = { id: string; name: string; server: string; databaseName: string };
type SchemaRow = { schema: string };
type TableRow = { schema: string; table: string };
type Column = { originalName: string; sqlName: string; sqlType: string };
type Step = "origin" | "mode" | "preview";

function Field({ label, hint, children, wide = false }: { label: string; hint?: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`form-control w-full ${wide ? "lg:col-span-2" : ""}`}><span className="label-text font-medium">{label}</span><div className="mt-1">{children}</div>{hint && <span className="label-text-alt mt-1 text-base-content/55">{hint}</span>}</label>;
}

function StepItem({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return <span className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs ${active ? "bg-primary text-primary-content" : done ? "bg-success/10 text-success" : "bg-base-200 text-base-content/60"}`}>{done ? <CheckCircle2 size={13} /> : null}{label}</span>;
}

export function SourceDialog({ datasetId, onComplete }: { datasetId: string; onComplete: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<Step>("origin");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [schemas, setSchemas] = useState<SchemaRow[]>([]);
  const [schema, setSchema] = useState("");
  const [tables, setTables] = useState<TableRow[]>([]);
  const [table, setTable] = useState("");
  const [columns, setColumns] = useState<Column[]>([]);
  const [sourceKind, setSourceKind] = useState<"table" | "query">("table");
  const [mode, setMode] = useState<"extract" | "live">("extract");
  const [refreshPolicy, setRefreshPolicy] = useState("manual");
  const [name, setName] = useState("");
  const [sourceSql, setSourceSql] = useState("SELECT *\nFROM ");
  const [loading, setLoading] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [error, setError] = useState("");

  async function open() {
    setStep("origin"); setError(""); setColumns([]);
    ref.current?.showModal();
    setLoadingMeta(true);
    const response = await fetch("/api/v1/connections");
    const body = await response.json();
    const rows = (body.data ?? []).filter((c: Connection) => c.id);
    setConnections(rows);
    if (rows[0] && !connectionId) setConnectionId(rows[0].id);
    setLoadingMeta(false);
  }

  useEffect(() => {
    if (!connectionId) return;
    Promise.resolve().then(() => setLoadingMeta(true));
    fetch(`/api/v1/connections/${connectionId}/schemas`).then((r) => r.json()).then((body) => {
      const rows = body.data ?? [];
      setSchemas(rows);
      setSchema(rows[0]?.schema ?? "");
    }).finally(() => setLoadingMeta(false));
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId || !schema || sourceKind !== "table") return;
    Promise.resolve().then(() => setLoadingMeta(true));
    fetch(`/api/v1/connections/${connectionId}/tables?schema=${encodeURIComponent(schema)}`).then((r) => r.json()).then((body) => {
      const rows = body.data ?? [];
      setTables(rows);
      setTable(rows[0]?.table ?? "");
    }).finally(() => setLoadingMeta(false));
  }, [connectionId, schema, sourceKind]);

  async function preview() {
    if (!connectionId) return;
    setLoading(true); setError("");
    const url = sourceKind === "table"
      ? `/api/v1/connections/${connectionId}/columns?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`
      : `/api/v1/connections/${connectionId}/columns?sql=${encodeURIComponent(sourceSql)}`;
    const response = await fetch(url);
    const body = await response.json();
    setLoading(false);
    if (!response.ok) { setError(body.error?.message ?? "Falha ao ler colunas"); return; }
    setColumns(body.data ?? []);
    setStep("preview");
  }

  async function create() {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/v1/datasets/${datasetId}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId,
          name: name || (sourceKind === "table" ? table : "consulta_postgres"),
          mode,
          sourceKind,
          sourceSchema: sourceKind === "table" ? schema : null,
          sourceTable: sourceKind === "table" ? table : null,
          sourceSql: sourceKind === "query" ? sourceSql : null,
          refreshPolicy: mode === "live" ? "manual" : refreshPolicy,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Falha ao criar fonte");
      ref.current?.close();
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao criar fonte");
    } finally {
      setLoading(false);
    }
  }

  const canChooseOrigin = connectionId && (sourceKind === "query" || (schema && table));
  const modeLabel = mode === "extract" ? "Copiar para o Catworld" : "Consultar direto no Postgres";

  return (
    <>
      <button onClick={open} className="btn btn-outline btn-sm"><Plus size={14} />Adicionar fonte</button>
      <dialog ref={ref} className="modal">
        <div className="modal-box max-w-4xl">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div><h3 className="text-lg font-bold">Adicionar fonte de dados</h3><p className="mt-1 text-sm text-base-content/60">Escolha a origem, defina se os dados serão copiados ou consultados ao vivo e revise as colunas.</p></div>
            <div className="flex flex-wrap gap-2"><StepItem label="Origem" active={step === "origin"} done={step !== "origin"} /><StepItem label="Uso" active={step === "mode"} done={step === "preview"} /><StepItem label="Revisão" active={step === "preview"} done={false} /></div>
          </div>

          {loadingMeta && <div className="alert alert-info alert-soft mt-4"><span className="loading loading-spinner loading-sm" />Carregando metadados da conexão...</div>}
          {connections.length === 0 && !loadingMeta && <div className="alert alert-warning alert-soft mt-4">Crie uma conexão Postgres antes de adicionar fontes ao dataset.</div>}
          {error && <div className="alert alert-error alert-soft mt-4">{error}</div>}

          {step === "origin" && (
            <div className="mt-5 space-y-5">
              <div className="join">
                <button type="button" className={`btn join-item btn-sm ${sourceKind === "table" ? "btn-primary" : "btn-outline"}`} onClick={() => setSourceKind("table")}><Table2 size={14} />Usar tabela</button>
                <button type="button" className={`btn join-item btn-sm ${sourceKind === "query" ? "btn-primary" : "btn-outline"}`} onClick={() => setSourceKind("query")}><Play size={14} />Usar consulta</button>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Field label="Conexão Postgres"><select className="select w-full" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>{connections.map((c) => <option key={c.id} value={c.id}>{c.name} - {c.databaseName}</option>)}</select></Field>
                <Field label="Nome no dataset" hint="Nome da tabela exibida no Catworld."><input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} /></Field>
                {sourceKind === "table" ? (
                  <>
                    <Field label="Schema"><select className="select w-full" value={schema} onChange={(e) => setSchema(e.target.value)}>{schemas.map((s) => <option key={s.schema}>{s.schema}</option>)}</select></Field>
                    <Field label="Tabela"><select className="select w-full" value={table} onChange={(e) => setTable(e.target.value)}>{tables.map((t) => <option key={`${t.schema}.${t.table}`}>{t.table}</option>)}</select></Field>
                  </>
                ) : (
                  <Field label="Consulta SQL" hint="Somente SELECT ou WITH. A consulta roda no Postgres da conexão escolhida." wide><textarea className="textarea h-44 w-full font-mono text-sm" value={sourceSql} onChange={(e) => setSourceSql(e.target.value)} /></Field>
                )}
              </div>
            </div>
          )}

          {step === "mode" && (
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <button type="button" onClick={() => setMode("extract")} className={`rounded-box border p-4 text-left ${mode === "extract" ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}><DatabaseZap className="text-primary" size={22} /><h4 className="mt-3 font-semibold">Copiar para o Catworld</h4><p className="mt-1 text-sm text-base-content/60">Cria uma tabela física no dataset. Ideal para análises rápidas, permissões internas e histórico controlado.</p></button>
              <button type="button" onClick={() => setMode("live")} className={`rounded-box border p-4 text-left ${mode === "live" ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}><Cable className="text-primary" size={22} /><h4 className="mt-3 font-semibold">Consultar direto no Postgres</h4><p className="mt-1 text-sm text-base-content/60">Não copia dados. Cada visualização consulta a origem, respeitando disponibilidade e performance do Postgres.</p></button>
              <Field label="Atualização" hint={mode === "live" ? "Fontes ao vivo sempre consultam a origem na hora." : "Define quando o Catworld deve copiar os dados novamente."} wide><select disabled={mode === "live"} className="select w-full" value={refreshPolicy} onChange={(e) => setRefreshPolicy(e.target.value)}><option value="manual">Manual</option><option value="hourly">A cada hora</option><option value="daily">Diária</option><option value="weekly">Semanal</option></select></Field>
            </div>
          )}

          {step === "preview" && (
            <div className="mt-5 space-y-4">
              <div className="rounded-box border border-base-300 bg-base-200/40 p-4 text-sm"><strong>{modeLabel}</strong><span className="ml-2 text-base-content/60">{sourceKind === "table" ? `${schema}.${table}` : "consulta personalizada"}</span></div>
              {columns.length > 0 ? <div className="max-h-72 overflow-auto rounded-box border border-base-300"><table className="table table-sm"><thead><tr><th>Coluna na origem</th><th>Nome no Catworld</th><th>Tipo</th></tr></thead><tbody>{columns.map((c) => <tr key={c.sqlName}><td>{c.originalName}</td><td className="font-mono text-xs">{c.sqlName}</td><td>{c.sqlType}</td></tr>)}</tbody></table></div> : <div className="alert alert-warning alert-soft">Nenhuma coluna carregada. Volte e gere a prévia novamente.</div>}
            </div>
          )}

          <div className="modal-action justify-between">
            <div>{step !== "origin" && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(step === "preview" ? "mode" : "origin")}>Voltar</button>}</div>
            <div className="flex gap-2"><button type="button" onClick={() => ref.current?.close()} className="btn btn-ghost btn-sm">Fechar</button>{step === "origin" && <button type="button" disabled={!canChooseOrigin} className="btn btn-primary btn-sm" onClick={() => setStep("mode")}>Continuar</button>}{step === "mode" && <button type="button" disabled={loading} className="btn btn-primary btn-sm" onClick={preview}><RefreshCw size={14} />{loading ? "Carregando..." : "Gerar prévia"}</button>}{step === "preview" && <button type="button" onClick={create} disabled={loading || columns.length === 0} className="btn btn-primary btn-sm">{loading ? "Criando..." : "Criar fonte"}</button>}</div>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop"><button>fechar</button></form>
      </dialog>
    </>
  );
}
