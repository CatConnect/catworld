/**
 * BULK INSERT from Azure Blob — substitui o TDS bulk copy para imports CSV.
 *
 * Requer ONE-TIME setup no banco:
 *   CREATE MASTER KEY ENCRYPTION BY PASSWORD = 'CatWorld_Mk2024!';
 *
 * Depois disso, ative em env.ts: CATWORLD_BULK_INSERT_FROM_BLOB=true
 *
 * Ganho esperado: 3-10x vs TDS em Azure SQL S0 (SQL Server lê o blob
 * diretamente na rede interna Azure, sem passar pelo Node.js).
 */
import { createHash } from "node:crypto";
import { Writable, Readable, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import sql from "mssql";
import { BlobServiceClient, BlobSASPermissions, StorageSharedKeyCredential, generateBlobSASQueryParameters } from "@azure/storage-blob";
import { sqlPool } from "@/server/azure/sql";
import { quoteIdentifier } from "@/server/security/naming";
import { rowsFromFile, type ParsedColumn } from "./parser";
import { env } from "@/server/env";

const CRED_NAME = "CatworldBlobImportCred";
const DS_NAME = "CatworldBlobImportDS";

function blobEnv() {
  const e = env();
  const connStr = e.CATWORLD_AZURE_BLOB_CONNECTION_STRING!;
  const accountMatch = connStr.match(/AccountName=([^;]+)/i)!;
  const keyMatch = connStr.match(/AccountKey=([^;]+)/i)!;
  return { connStr, account: accountMatch[1]!, key: keyMatch[1]!, container: e.CATWORLD_AZURE_BLOB_CONTAINER };
}

export async function ensureBlobDataSource(pool: sql.ConnectionPool) {
  const { connStr, account, key, container } = blobEnv();
  const credential = new StorageSharedKeyCredential(account, key);
  const expiresOn = new Date(Date.now() + 365 * 24 * 60 * 60_000); // 1 ano
  const sas = generateBlobSASQueryParameters(
    { containerName: container, permissions: BlobSASPermissions.parse("rl"), expiresOn },
    credential
  ).toString();

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.database_scoped_credentials WHERE name = '${CRED_NAME}')
      CREATE DATABASE SCOPED CREDENTIAL [${CRED_NAME}]
      WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sas}'
  `);
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.external_data_sources WHERE name = '${DS_NAME}')
      CREATE EXTERNAL DATA SOURCE [${DS_NAME}]
      WITH (TYPE = BLOB_STORAGE, LOCATION = 'https://${account}.blob.core.windows.net', CREDENTIAL = [${CRED_NAME}])
  `);
}

function makeCleanConverter(type: string): (v: unknown) => string {
  if (type === "BIGINT") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  if (type.startsWith("DECIMAL")) return v => {
    if (v == null || String(v).trim() === "") return "";
    const s = String(v).trim();
    return String(Number(s.includes(",") ? s.replaceAll(".", "").replace(",", ".") : s));
  };
  if (type === "DATE") return v => {
    if (v == null || String(v).trim() === "") return "";
    const s = String(v).trim(), br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    return br ? `${br[3]}-${br[2]}-${br[1]}` : s.slice(0, 10);
  };
  if (type === "DATETIME2") return v => {
    if (v == null || String(v).trim() === "") return "";
    const s = String(v).trim(), br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)/);
    const iso = br ? `${br[3]}-${br[2]}-${br[1]}${br[4]}` : s;
    return new Date(iso).toISOString().replace("T", " ").replace("Z", "");
  };
  if (type === "TIME") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  return v => (v == null || String(v).trim() === "") ? "" : String(v).trim().replace(/\t/g, " ").replace(/\n/g, " ").replace(/\r/g, "");
}

export async function bulkInsertFromBlob(
  uploadId: string,
  filePath: string,
  mapping: ParsedColumn[],
  schema: string,
  stagingTable: string,
  onProgress?: (rows: number) => void
): Promise<number> {
  const { account, container } = blobEnv();
  const cleanBlobName = `tmp/bulk-${uploadId}.tsv`;

  const service = BlobServiceClient.fromConnectionString(env().CATWORLD_AZURE_BLOB_CONNECTION_STRING!);
  const cc = service.getContainerClient(container);
  const blockClient = cc.getBlockBlobClient(cleanBlobName);
  const converters = mapping.map(c => makeCleanConverter(c.sqlType));

  // Stream: CSV → converter → TSV → blob
  let total = 0;
  const passThrough = new PassThrough();

  const uploadPromise = blockClient.uploadStream(passThrough, 8 * 1024 * 1024, 4, {
    blobHTTPHeaders: { blobContentType: "text/tab-separated-values; charset=utf-8" },
  });

  for await (const row of rowsFromFile(filePath, mapping)) {
    const line = converters.map((fn, i) => fn(row[mapping[i]!.sqlName])).join("\t") + "\n";
    passThrough.write(line);
    total++;
    if (total % 50_000 === 0) onProgress?.(total);
  }
  passThrough.end();
  await uploadPromise;

  // SAS de curta duração (30 min) para o blob temporário
  const credential = new StorageSharedKeyCredential(
    account,
    env().CATWORLD_AZURE_BLOB_CONNECTION_STRING!.match(/AccountKey=([^;]+)/i)![1]!
  );
  const expiresOn = new Date(Date.now() + 30 * 60_000);
  const sas = generateBlobSASQueryParameters(
    { containerName: container, blobName: cleanBlobName, permissions: BlobSASPermissions.parse("r"), expiresOn },
    credential
  ).toString();

  const pool = await sqlPool();

  // Recria credential com token de curta duração para este blob específico
  const tempCred = `CatworldBulkTemp_${createHash("md5").update(uploadId).digest("hex").slice(0, 8)}`;
  const tempDs = `CatworldBulkTempDS_${createHash("md5").update(uploadId).digest("hex").slice(0, 8)}`;

  try {
    await pool.request().query(`
      CREATE DATABASE SCOPED CREDENTIAL [${tempCred}]
      WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sas}'
    `);
    await pool.request().query(`
      CREATE EXTERNAL DATA SOURCE [${tempDs}]
      WITH (TYPE = BLOB_STORAGE, LOCATION = 'https://${account}.blob.core.windows.net', CREDENTIAL = [${tempCred}])
    `);

    const colList = mapping.map(c => quoteIdentifier(c.sqlName)).join(", ");
    await pool.request().query(`
      BULK INSERT ${quoteIdentifier(schema)}.${quoteIdentifier(stagingTable)}
      FROM '${container}/${cleanBlobName}'
      WITH (
        DATA_SOURCE = '${tempDs}',
        FORMAT = 'CSV',
        FIELDTERMINATOR = '\t',
        ROWTERMINATOR = '0x0a',
        FIRSTROW = 1,
        TABLOCK,
        CODEPAGE = '65001'
      )
    `);
  } finally {
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.external_data_sources WHERE name='${tempDs}') DROP EXTERNAL DATA SOURCE [${tempDs}]`).catch(() => {});
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.database_scoped_credentials WHERE name='${tempCred}') DROP DATABASE SCOPED CREDENTIAL [${tempCred}]`).catch(() => {});
    await blockClient.delete().catch(() => {});
  }

  return total;
}
