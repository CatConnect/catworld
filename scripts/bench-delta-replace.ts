/**
 * Benchmark: mede o tempo do deltaReplace (TRUNCATE+INSERT vs NOT EXISTS+DELETE).
 * Cria uma tabela de teste com N linhas, popula via BULK INSERT, depois faz um segundo
 * import (re-upload) e mede o tempo do delta merge.
 *
 * Uso: npx tsx scripts/bench-delta-replace.ts [nLinhas]
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import sql from "mssql";
import {
  BlobServiceClient,
  BlobSASPermissions,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { PassThrough } from "node:stream";

const envPath = resolve(".", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const sep = t.indexOf("=");
    if (sep < 0) continue;
    const key = t.slice(0, sep).trim();
    let val = t.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

function parseSqlUrl(url: string): sql.config {
  const without = url.replace(/^sqlserver:\/\//i, "");
  const [hp, ...rest] = without.split(";").filter(Boolean);
  const [server, port] = hp!.split(":");
  const params = Object.fromEntries(rest.map((p) => { const i = p.indexOf("="); return [p.slice(0, i).toLowerCase(), p.slice(i + 1)]; }));
  return { server: server!, port: port ? Number(port) : 1433, database: params["database"], user: params["user"], password: params["password"], options: { encrypt: true, trustServerCertificate: false }, requestTimeout: 1_800_000, connectionTimeout: 30_000, pool: { max: 3, min: 1, idleTimeoutMillis: 30_000 } };
}

function blobEnv() {
  const connStr = process.env["CATWORLD_AZURE_BLOB_CONNECTION_STRING"]!;
  const account = connStr.match(/AccountName=([^;]+)/i)![1]!;
  const key = connStr.match(/AccountKey=([^;]+)/i)![1]!;
  const container = process.env["CATWORLD_AZURE_BLOB_CONTAINER"]!;
  return { connStr, account, key, container };
}

function generateRows(n: number, offset = 0) {
  const rows: string[] = [];
  for (let i = offset; i < offset + n; i++) {
    const hash = createHash("md5").update(`row_${i}`).digest("hex");
    rows.push(`${i}|"Cliente ${i}"|"${(i * 1.5).toFixed(2)}"|"São Paulo ${i % 100}"|"Descrição ${i}"|"2024-01-01"|"COD${String(i).padStart(6, "0")}"|${hash}`);
  }
  return rows.join("\n");
}

async function bulkInsert(
  pool: sql.ConnectionPool,
  csvContent: string,
  targetTable: string,
  label: string,
): Promise<number> {
  const { connStr, account, key, container } = blobEnv();
  const runId = createHash("md5").update(label + Date.now()).digest("hex").slice(0, 8);
  const blobName = `tmp/bench-delta-${runId}.csv`;

  const service = BlobServiceClient.fromConnectionString(connStr);
  const blockClient = service.getContainerClient(container).getBlockBlobClient(blobName);

  const passThrough = new PassThrough();
  const uploadPromise = blockClient.uploadStream(passThrough, 8 * 1024 * 1024, 4);
  passThrough.end(csvContent);
  await uploadPromise;

  const credential = new StorageSharedKeyCredential(account, key);
  const sas = generateBlobSASQueryParameters(
    { containerName: container, blobName, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + 60 * 60_000) },
    credential,
  ).toString();

  const tempCred = `BenchDeltaCred_${runId}`;
  const tempDs = `BenchDeltaDS_${runId}`;

  try {
    await pool.request().query(
      `IF NOT EXISTS (SELECT 1 FROM sys.database_scoped_credentials WHERE name='${tempCred}')
         CREATE DATABASE SCOPED CREDENTIAL [${tempCred}] WITH IDENTITY='SHARED ACCESS SIGNATURE',SECRET='${sas}';
       ELSE
         ALTER DATABASE SCOPED CREDENTIAL [${tempCred}] WITH IDENTITY='SHARED ACCESS SIGNATURE',SECRET='${sas}';
       IF NOT EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name='${tempDs}')
         CREATE EXTERNAL DATA SOURCE [${tempDs}]
           WITH (TYPE=BLOB_STORAGE,LOCATION='https://${account}.blob.core.windows.net',CREDENTIAL=[${tempCred}]);`,
    );

    for (let attempt = 1; ; attempt++) {
      try {
        const req = pool.request();
        (req as unknown as { timeout: number }).timeout = 30 * 60_000;
        await req.query(
          `BULK INSERT dbo.[${targetTable}]
           FROM '${container}/${blobName}'
           WITH (DATA_SOURCE='${tempDs}',FORMAT='CSV',FIELDTERMINATOR='|',ROWTERMINATOR='\n',
                 FIELDQUOTE='"',FIRSTROW=1,TABLOCK,CODEPAGE='65001',ROWS_PER_BATCH=50000)`,
        );
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt >= 5 || !msg.includes('OLE DB provider "BULK"')) throw e;
        console.log(`    retry ${attempt}/5...`);
        await new Promise((r) => setTimeout(r, 5_000 * attempt));
      }
    }

    const count = await pool.request().query(`SELECT COUNT_BIG(*) n FROM dbo.[${targetTable}]`);
    return Number(count.recordset[0].n);
  } finally {
    await pool.request().query(`DROP EXTERNAL DATA SOURCE IF EXISTS [${tempDs}]`).catch(() => {});
    await pool.request().query(`DROP DATABASE SCOPED CREDENTIAL IF EXISTS [${tempCred}]`).catch(() => {});
    await blockClient.delete().catch(() => {});
  }
}

async function main() {
  const N = parseInt(process.argv[2] ?? "200000", 10);
  // 10% of rows change between import 1 and import 2
  const N_CHANGED = Math.round(N * 0.1);

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  Benchmark: deltaReplace (TRUNCATE+INSERT vs NOT EXISTS)`);
  console.log(`  Linhas: ${N.toLocaleString("pt-BR")} · Linhas alteradas: ${N_CHANGED.toLocaleString("pt-BR")}`);
  console.log(`═══════════════════════════════════════════════════════\n`);

  const pool = await new sql.ConnectionPool(parseSqlUrl(process.env["CATWORLD_DATABASE_URL"]!)).connect();
  const runId = createHash("md5").update(String(Date.now())).digest("hex").slice(0, 8);

  // Table uses NVARCHAR(4000) (current code) with _cw_rh column
  const colDefs = `[id] NVARCHAR(4000) NULL,[nome] NVARCHAR(4000) NULL,[valor] NVARCHAR(4000) NULL,[cidade] NVARCHAR(4000) NULL,[descricao] NVARCHAR(4000) NULL,[data] NVARCHAR(4000) NULL,[codigo] NVARCHAR(4000) NULL,[_cw_rh] CHAR(32) NULL`;
  const target = `bm_target_${runId}`;
  const staging1 = `bm_stage1_${runId}`;
  const staging2a = `bm_stage2a_${runId}`; // NOT EXISTS method staging
  const staging2b = `bm_stage2b_${runId}`; // TRUNCATE method staging

  await pool.request().query(`
    IF OBJECT_ID(N'dbo.${target}',N'U') IS NOT NULL DROP TABLE dbo.[${target}];
    IF OBJECT_ID(N'dbo.${staging1}',N'U') IS NOT NULL DROP TABLE dbo.[${staging1}];
    IF OBJECT_ID(N'dbo.${staging2a}',N'U') IS NOT NULL DROP TABLE dbo.[${staging2a}];
    IF OBJECT_ID(N'dbo.${staging2b}',N'U') IS NOT NULL DROP TABLE dbo.[${staging2b}];
    CREATE TABLE dbo.[${target}] (${colDefs});
    CREATE TABLE dbo.[${staging1}] (${colDefs});
    CREATE TABLE dbo.[${staging2a}] (${colDefs});
    CREATE TABLE dbo.[${staging2b}] (${colDefs});
  `);

  try {
    // ── Initial load: populate target via staging1 ────────────────────────────
    console.log(`Gerando e carregando ${N.toLocaleString()} linhas iniciais...`);
    const csv1 = generateRows(N, 0);
    const csvBytes = Buffer.byteLength(csv1, "utf8");
    console.log(`✓ CSV: ${(csvBytes / 1024 / 1024).toFixed(1)} MB\n`);

    await bulkInsert(pool, csv1, staging1, "init");

    // Create index on staging1 before copying to target
    await pool.request().query(`CREATE NONCLUSTERED INDEX [IX_s1_rh] ON dbo.[${staging1}] ([_cw_rh])`);

    // Populate target from staging1 (simulates first import)
    await pool.request().query(`
      INSERT INTO dbo.[${target}] SELECT * FROM dbo.[${staging1}];
      CREATE NONCLUSTERED INDEX [IX__cw_rh] ON dbo.[${target}] ([_cw_rh]);
    `);
    const targetCount = (await pool.request().query(`SELECT COUNT_BIG(*) n FROM dbo.[${target}]`)).recordset[0].n;
    console.log(`✓ Target populado: ${Number(targetCount).toLocaleString()} linhas\n`);

    // ── Re-import data: N rows with N_CHANGED rows different ─────────────────
    // rows 0..(N-N_CHANGED-1) unchanged; rows (N-N_CHANGED)..N-1 changed (new hashes)
    // Plus N_CHANGED new rows: N..N+N_CHANGED-1 (to replace the changed ones)
    // Actually simpler: same N rows but the last N_CHANGED have different hashes
    const unchangedRows = generateRows(N - N_CHANGED, 0);
    const changedRows = generateRows(N_CHANGED, N); // offset N → different hashes
    const csv2 = unchangedRows + "\n" + changedRows;

    console.log(`Carregando re-import (${N_CHANGED.toLocaleString()} linhas alteradas) em staging2a e staging2b...`);
    await Promise.all([
      bulkInsert(pool, csv2, staging2a, "reimport-a"),
      bulkInsert(pool, csv2, staging2b, "reimport-b"),
    ]);
    await pool.request().query(`
      CREATE NONCLUSTERED INDEX [IX_s2a_rh] ON dbo.[${staging2a}] ([_cw_rh]);
      CREATE NONCLUSTERED INDEX [IX_s2b_rh] ON dbo.[${staging2b}] ([_cw_rh]);
    `);
    console.log(`✓ Staging carregado\n`);

    // ── Method A: NOT EXISTS + DELETE (método antigo) ─────────────────────────
    console.log(`[A] NOT EXISTS + DELETE (método antigo)...`);
    const tA = Date.now();
    const txA = new sql.Transaction(pool);
    await txA.begin();
    try {
      const reqA = new sql.Request(txA);
      (reqA as unknown as { timeout: number }).timeout = 30 * 60_000;
      await reqA.query(`
        INSERT INTO dbo.[${target}] SELECT * FROM dbo.[${staging2a}] s
          WHERE NOT EXISTS(SELECT 1 FROM dbo.[${target}] t WHERE t.[_cw_rh]=s.[_cw_rh]);
        DELETE t FROM dbo.[${target}] t
          WHERE NOT EXISTS(SELECT 1 FROM dbo.[${staging2a}] s WHERE s.[_cw_rh]=t.[_cw_rh]);
      `);
      await txA.commit();
    } catch (e) {
      await txA.rollback().catch(() => {});
      throw e;
    }
    const msA = Date.now() - tA;
    console.log(`  ✓ ${msA}ms  (${(msA / 1000).toFixed(1)}s)\n`);

    // Restore target to original state before method B
    await pool.request().query(`
      TRUNCATE TABLE dbo.[${target}];
      INSERT INTO dbo.[${target}] SELECT * FROM dbo.[${staging1}];
    `);

    // ── Method B: TRUNCATE + INSERT SELECT (método novo) ─────────────────────
    console.log(`[B] TRUNCATE + INSERT SELECT (método novo)...`);
    const tB = Date.now();
    const txB = new sql.Transaction(pool);
    await txB.begin();
    try {
      const reqB = new sql.Request(txB);
      (reqB as unknown as { timeout: number }).timeout = 30 * 60_000;
      await reqB.query(`
        TRUNCATE TABLE dbo.[${target}];
        INSERT INTO dbo.[${target}] SELECT * FROM dbo.[${staging2b}] s;
      `);
      await txB.commit();
    } catch (e) {
      await txB.rollback().catch(() => {});
      throw e;
    }
    const msB = Date.now() - tB;
    console.log(`  ✓ ${msB}ms  (${(msB / 1000).toFixed(1)}s)\n`);

    const speedup = (msA / msB).toFixed(2);
    const savedPct = Math.round((1 - msB / msA) * 100);

    console.log(`╔════════════════════════════════════════════════════════╗`);
    console.log(`║  RESULTADO (delta merge apenas, sem BULK INSERT)       ║`);
    console.log(`╠════════════════════════════════════════════════════════╣`);
    console.log(`║  [A] NOT EXISTS+DELETE : ${String(msA + "ms").padEnd(33)}║`);
    console.log(`║  [B] TRUNCATE+INSERT   : ${String(msB + "ms").padEnd(33)}║`);
    console.log(`╠════════════════════════════════════════════════════════╣`);
    if (msA > msB) {
      console.log(`║  Speedup: ${speedup}×    Economizado: ${savedPct}%${" ".repeat(Math.max(0, 26 - String(savedPct).length))}║`);
    } else {
      console.log(`║  Sem melhora (TRUNCATE foi mais lento)                 ║`);
    }
    console.log(`╚════════════════════════════════════════════════════════╝\n`);
  } finally {
    await pool.request().query(`
      IF OBJECT_ID(N'dbo.${target}',N'U') IS NOT NULL DROP TABLE dbo.[${target}];
      IF OBJECT_ID(N'dbo.${staging1}',N'U') IS NOT NULL DROP TABLE dbo.[${staging1}];
      IF OBJECT_ID(N'dbo.${staging2a}',N'U') IS NOT NULL DROP TABLE dbo.[${staging2a}];
      IF OBJECT_ID(N'dbo.${staging2b}',N'U') IS NOT NULL DROP TABLE dbo.[${staging2b}];
    `).catch(() => {});
    await pool.close();
  }
}

void main().catch((e) => { console.error("❌", e.message ?? e); process.exit(1); });
