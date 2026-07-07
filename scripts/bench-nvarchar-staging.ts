/**
 * Benchmark: NVARCHAR(MAX) vs NVARCHAR(4000) em staging table com BULK INSERT do Azure Blob.
 * Testa exatamente a mudança feita no importer.ts.
 *
 * Uso: npx tsx scripts/bench-nvarchar-staging.ts [nLinhas]
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import sql from "mssql";
import {
  BlobServiceClient,
  BlobSASPermissions,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { PassThrough } from "node:stream";

// ─── Load .env ──────────────────────────────────────────────────────────────
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
  const params = Object.fromEntries(
    rest.map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).toLowerCase(), p.slice(i + 1)];
    }),
  );
  return {
    server: server!,
    port: port ? Number(port) : 1433,
    database: params["database"],
    user: params["user"],
    password: params["password"],
    options: { encrypt: true, trustServerCertificate: false },
    requestTimeout: 1_800_000,
    connectionTimeout: 30_000,
    pool: { max: 3, min: 1, idleTimeoutMillis: 30_000 },
  };
}

function blobEnv() {
  const connStr = process.env["CATWORLD_AZURE_BLOB_CONNECTION_STRING"]!;
  const account = connStr.match(/AccountName=([^;]+)/i)![1]!;
  const key = connStr.match(/AccountKey=([^;]+)/i)![1]!;
  const container = process.env["CATWORLD_AZURE_BLOB_CONTAINER"]!;
  return { connStr, account, key, container };
}

// ─── Generate test CSV ───────────────────────────────────────────────────────
function generateCsv(rows: number): string {
  const lines = ["id|nome|valor|cidade|descricao|data|codigo"];
  for (let i = 0; i < rows; i++) {
    lines.push(
      `${i}|"Cliente ${i}"|"${(i * 1.5).toFixed(2)}"|"São Paulo"|"Descrição do item ${i}"|"2024-0${(i % 9) + 1}-01"|"COD${String(i).padStart(6, "0")}"`,
    );
  }
  return lines.join("\n");
}

// ─── Upload CSV to Azure Blob and return blob name ───────────────────────────
async function uploadToBlobAndBulkInsert(
  pool: sql.ConnectionPool,
  csvContent: string,
  colType: "NVARCHAR(MAX)" | "NVARCHAR(4000)",
  label: string,
): Promise<{ totalMs: number; bulkMs: number; rows: number }> {
  const { connStr, account, key, container } = blobEnv();
  const runId = createHash("md5").update(label + Date.now()).digest("hex").slice(0, 8);
  const blobName = `tmp/bench-nv-${runId}.csv`;
  const table = `bm_nv_${runId}`;
  const colDefs = `[id] ${colType} NULL,[nome] ${colType} NULL,[valor] ${colType} NULL,[cidade] ${colType} NULL,[descricao] ${colType} NULL,[data] ${colType} NULL,[codigo] ${colType} NULL`;

  const service = BlobServiceClient.fromConnectionString(connStr);
  const blockClient = service.getContainerClient(container).getBlockBlobClient(blobName);

  const t0 = Date.now();

  // Upload CSV to blob
  const passThrough = new PassThrough();
  const uploadPromise = blockClient.uploadStream(passThrough, 8 * 1024 * 1024, 4);
  passThrough.end(csvContent);
  await uploadPromise;

  // Create staging
  await pool.request().query(
    `IF OBJECT_ID(N'dbo.${table}',N'U') IS NOT NULL DROP TABLE dbo.[${table}];
     CREATE TABLE dbo.[${table}] (${colDefs})`,
  );

  const credential = new StorageSharedKeyCredential(account, key);
  const sas = generateBlobSASQueryParameters(
    {
      containerName: container,
      blobName,
      permissions: BlobSASPermissions.parse("r"),
      expiresOn: new Date(Date.now() + 60 * 60_000),
    },
    credential,
  ).toString();

  const tempCred = `BenchNVCred_${runId}`;
  const tempDs = `BenchNVDS_${runId}`;

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

    const bulkSql = `
      BULK INSERT dbo.[${table}]
      FROM '${container}/${blobName}'
      WITH (
        DATA_SOURCE = '${tempDs}',
        FORMAT = 'CSV',
        FIELDTERMINATOR = '|',
        ROWTERMINATOR = '\n',
        FIELDQUOTE = '"',
        FIRSTROW = 2,
        TABLOCK,
        CODEPAGE = '65001',
        ROWS_PER_BATCH = 50000
      )
    `;
    const t1 = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        if (attempt > 1) {
          // Refresh SAS + credential on retry
          const sas2 = generateBlobSASQueryParameters(
            { containerName: container, blobName, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + 60 * 60_000) },
            credential,
          ).toString();
          await pool.request().query(`ALTER DATABASE SCOPED CREDENTIAL [${tempCred}] WITH IDENTITY='SHARED ACCESS SIGNATURE',SECRET='${sas2}'`).catch(() => {});
          await pool.request().query(`TRUNCATE TABLE dbo.[${table}]`).catch(() => {});
        }
        const bulkReq = pool.request();
        (bulkReq as unknown as { timeout: number }).timeout = 30 * 60_000;
        await bulkReq.query(bulkSql);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt >= 5 || !msg.includes('OLE DB provider "BULK"')) throw e;
        const wait = 5_000 * attempt;
        console.log(`    retry ${attempt}/5 em ${wait / 1000}s (transient OLE DB)...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    const bulkMs = Date.now() - t1;

    const countRes = await pool.request().query(`SELECT COUNT_BIG(*) n FROM dbo.[${table}]`);
    const rows = Number(countRes.recordset[0].n);
    const totalMs = Date.now() - t0;

    return { totalMs, bulkMs, rows };
  } finally {
    await pool.request().query(`DROP EXTERNAL DATA SOURCE IF EXISTS [${tempDs}]`).catch(() => {});
    await pool.request().query(`DROP DATABASE SCOPED CREDENTIAL IF EXISTS [${tempCred}]`).catch(() => {});
    await pool.request().query(`IF OBJECT_ID(N'dbo.${table}',N'U') IS NOT NULL DROP TABLE dbo.[${table}]`).catch(() => {});
    await blockClient.delete().catch(() => {});
  }
}

async function main() {
  const N_ROWS = parseInt(process.argv[2] ?? "100000", 10);

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  Benchmark: NVARCHAR(MAX) vs NVARCHAR(4000) em staging`);
  console.log(`  Linhas: ${N_ROWS.toLocaleString("pt-BR")}`);
  console.log(`═══════════════════════════════════════════════════════\n`);

  console.log("Gerando CSV de teste...");
  const csv = generateCsv(N_ROWS);
  const csvBytes = Buffer.byteLength(csv, "utf8");
  console.log(`✓ CSV gerado: ${(csvBytes / 1024 / 1024).toFixed(1)} MB\n`);

  const pool = await new sql.ConnectionPool(
    parseSqlUrl(process.env["CATWORLD_DATABASE_URL"]!),
  ).connect();

  console.log(`[1/2] NVARCHAR(MAX) — método antigo...`);
  const resMax = await uploadToBlobAndBulkInsert(pool, csv, "NVARCHAR(MAX)", "max");
  console.log(
    `  ✓ ${resMax.rows.toLocaleString()} linhas · bulk: ${resMax.bulkMs}ms · total: ${resMax.totalMs}ms · ${Math.round(resMax.rows / (resMax.bulkMs / 1000)).toLocaleString()} rows/s (bulk)\n`,
  );

  console.log(`[2/2] NVARCHAR(4000) — método novo...`);
  const res4k = await uploadToBlobAndBulkInsert(pool, csv, "NVARCHAR(4000)", "4k");
  console.log(
    `  ✓ ${res4k.rows.toLocaleString()} linhas · bulk: ${res4k.bulkMs}ms · total: ${res4k.totalMs}ms · ${Math.round(res4k.rows / (res4k.bulkMs / 1000)).toLocaleString()} rows/s (bulk)\n`,
  );

  await pool.close();

  const speedup = (resMax.bulkMs / res4k.bulkMs).toFixed(2);
  const saved = Math.round((1 - res4k.bulkMs / resMax.bulkMs) * 100);

  console.log(`╔═══════════════════════════════════════════════════════╗`);
  console.log(`║  RESULTADO                                            ║`);
  console.log(`╠═══════════════════════════════════════════════════════╣`);
  console.log(`║  NVARCHAR(MAX)  bulk: ${String(resMax.bulkMs + "ms").padEnd(33)}║`);
  console.log(`║  NVARCHAR(4000) bulk: ${String(res4k.bulkMs + "ms").padEnd(33)}║`);
  console.log(`╠═══════════════════════════════════════════════════════╣`);
  if (Number(speedup) > 1) {
    console.log(`║  Speedup: ${speedup}×    Economizado: ${saved}%${" ".repeat(Math.max(0, 20 - String(saved).length))}║`);
  } else {
    console.log(`║  Sem melhora significativa com ${N_ROWS.toLocaleString()} linhas${" ".repeat(Math.max(0,14-String(N_ROWS.toLocaleString()).length))}║`);
  }
  console.log(`╚═══════════════════════════════════════════════════════╝\n`);
}

void main().catch((e) => {
  console.error("❌", e.message ?? e);
  process.exit(1);
});
