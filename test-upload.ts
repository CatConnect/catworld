/**
 * Replica exatamente o upload-flow.tsx:
 *  1. Login via NextAuth credentials → session cookie
 *  2. POST /api/v1/uploads  → cria registro + pega sas.url
 *  3. PUT sas.url           → envia o arquivo (mesmo fetch que o browser faz)
 *  4. POST ?action=uploaded → fila PREVIEW_UPLOAD
 *  5. Poll até AWAITING_CONFIRMATION
 *  6. POST ?action=confirm  → fila IMPORT_UPLOAD (mode=replace)
 *  7. Poll até COMPLETED ou FAILED
 */
import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import { Readable } from "node:stream";

const BASE = "http://localhost:3000";
const FILE = process.argv[2];
const DATASET_ID = process.argv[3];
const TABLE_ID = process.argv[4] ?? null;
const TOKEN = process.env.CATWORLD_TOKEN ?? "";

if (!FILE || !DATASET_ID) {
  console.error("uso: npx tsx test-upload.ts <arquivo> <datasetId> [tableId]");
  process.exit(1);
}
if (!TOKEN) throw new Error("CATWORLD_TOKEN não definido no .env");

// ---------- poll ----------
async function poll(uploadId: string, until: string[], label: string, cookie: string): Promise<any> {
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await fetch(`${BASE}/api/v1/uploads/${uploadId}`, { headers: { cookie } });
    const d = await r.json();
    const u = d.data;
    process.stdout.write(`\r[${label}] status=${u.status} progress=${u.progress}%   `);
    if (until.includes(u.status)) { console.log(); return u; }
    if (u.status === "FAILED") { console.log(); throw new Error(`FAILED: ${u.errorMessage}`); }
  }
}

// ---------- main ----------
async function main() {
  const filename = FILE.split(/[\\/]/).pop()!;
  const sizeBytes = statSync(FILE).size;
  console.log(`\nArquivo : ${filename}`);
  console.log(`Tamanho : ${(sizeBytes / 1e6).toFixed(1)} MB`);
  console.log(`Dataset : ${DATASET_ID}`);
  if (TABLE_ID) console.log(`Tabela  : ${TABLE_ID}`);

  console.log("\n0) Login...");
  const cookie = await login();
  console.log("   autenticado ok");

  // 1) Criar upload
  console.log("\n1) POST /api/v1/uploads...");
  const r1 = await fetch(`${BASE}/api/v1/uploads`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ filename, sizeBytes }),
  });
  const b1 = await r1.json();
  if (!r1.ok) throw new Error(JSON.stringify(b1.error));
  const uploadId: string = b1.data.upload.id;
  const sasUrl: string = b1.data.sas.url;
  console.log(`   uploadId = ${uploadId}`);
  console.log(`   sas.url  = ${sasUrl}`);

  // 2) Enviar arquivo (mesmo que o browser faz com fetch + ReadableStream)
  console.log("\n2) PUT arquivo...");
  const ext = extname(filename).toLowerCase();
  const contentType = ext === ".csv" ? "text/csv" : ext === ".xlsx"
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "application/octet-stream";

  const fullUrl = sasUrl.startsWith("http") ? sasUrl : `${BASE}${sasUrl}`;
  const fileStream = createReadStream(FILE);
  const webStream = Readable.toWeb(fileStream) as ReadableStream;

  const r2 = await fetch(fullUrl, {
    method: "PUT",
    headers: { cookie, "content-type": contentType },
    // @ts-ignore — Node 18+ suporta body como ReadableStream com duplex
    body: webStream,
    duplex: "half",
  });
  const r2text = await r2.text();
  if (!r2.ok) throw new Error(`PUT falhou ${r2.status}: ${r2text}`);
  console.log(`   resposta: ${r2text.slice(0, 120)}`);

  // 3) Notificar uploaded
  console.log("\n3) POST ?action=uploaded...");
  const r3 = await fetch(`${BASE}/api/v1/uploads/${uploadId}?action=uploaded`, {
    method: "POST",
    headers: { cookie },
  });
  const b3 = await r3.json();
  console.log(`   status ${r3.status}: jobId=${b3.data?.id}`);

  // 4) Poll preview
  console.log("\n4) Aguardando AWAITING_CONFIRMATION...");
  const previewed = await poll(uploadId, ["AWAITING_CONFIRMATION"], "preview", cookie);
  const preview = JSON.parse(previewed.previewJson);
  console.log(`   rowCount (preview) = ${preview.rowCount}`);
  console.log(`   colunas            = ${preview.columns.length}`);
  console.log(`   primeiras 4        : ${preview.columns.slice(0, 4).map((c: any) => c.sqlName).join(", ")}...`);
  console.log(`   encoding           = ${preview.encoding}   sep="${preview.separator}"`);

  // 5) Confirmar
  console.log("\n5) POST ?action=confirm...");
  const r5 = await fetch(`${BASE}/api/v1/uploads/${uploadId}?action=confirm`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      datasetId: DATASET_ID,
      tableId: TABLE_ID,
      mode: "replace",
      keyColumn: null,
      mapping: preview.columns,
    }),
  });
  const b5 = await r5.json();
  if (!r5.ok) throw new Error(`confirm falhou: ${JSON.stringify(b5.error)}`);
  console.log(`   jobId=${b5.data?.id}`);

  // 6) Poll completar
  console.log("\n6) Aguardando COMPLETED...");
  const done = await poll(uploadId, ["COMPLETED"], "import", cookie);

  console.log(`\n✅  COMPLETED`);
  console.log(`   insertedCount = ${done.insertedCount}`);
  console.log(`   rowCount      = ${done.rowCount}`);
  console.log(`   progress      = ${done.progress}%`);
}

main().catch((e) => { console.error("\n❌", e.message); process.exitCode = 1; });
