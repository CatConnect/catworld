import { extname } from "node:path";
import sql from "mssql";
import { prisma } from "@/server/db";
import { sqlPool } from "@/server/azure/sql";
import { quoteIdentifier, sqlIdentifier } from "@/server/security/naming";
import { previewFile, rowsFromFile, type FilePreview, type ParsedColumn, type RowsFromFileOpts } from "./parser";
import { bulkInsertFromBlob } from "./importer-bulk-blob";
import { env } from "@/server/env";
import { normalizeDateLike } from "./date-normalize";

const SMALL_CSV_TDS_THRESHOLD_BYTES = 1 * 1024 * 1024;

// ─── TDS bulk copy ────────────────────────────────────────────────────────────
// Used as the primary path for small CSVs/XLS and as automatic fallback when
// BULK INSERT fails with an OLE DB provider error.
async function tdsBulkCopy(
  pool: sql.ConnectionPool,
  source: string | NodeJS.ReadableStream,
  mapping: ParsedColumn[],
  schema: string,
  destTable: string,
  opts: RowsFromFileOpts,
  knownRowCount: number,
  uploadId: string,
  onProgress?: (rows: number) => void,
): Promise<number> {
  const batchDelay = env().CATWORLD_IMPORT_BATCH_DELAY_MS;
  const stringify = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v));

  let batch: Record<string, unknown>[] = [];
  let total = 0;

  const flush = async () => {
    if (!batch.length) return;
    const bulk = new sql.Table(`${schema}.${destTable}`);
    bulk.create = false;
    for (const c of mapping) bulk.columns.add(c.sqlName, sql.NVarChar(sql.MAX), { nullable: true });
    bulk.columns.add("_cw_rh", sql.Char(32), { nullable: true });
    const { createHash: ch } = await import("node:crypto");
    for (const row of batch) {
      const vals = mapping.map(c => stringify(row[c.sqlName]));
      const rh = ch("md5").update(vals.map(v => v ?? "").join("|")).digest("hex");
      vals.push(rh);
      bulk.rows.add(...(vals as Parameters<typeof bulk.rows.add>));
    }
    await new sql.Request(pool).bulk(bulk, { tableLock: true });
    total += batch.length;
    batch = [];
    if (batchDelay > 0) await new Promise(r => setTimeout(r, batchDelay));
    onProgress?.(total);
  };

  for await (const row of rowsFromFile(source, mapping, opts)) {
    batch.push(row);
    if (batch.length >= 50_000) await flush();
  }
  await flush();

  console.log("[tdsBulkCopy] upload=%s rows=%d", uploadId, total);
  return total;
}

// ─── Main import entry point ───────────────────────────────────────────────────
export async function importUpload(uploadId: string, source: string | NodeJS.ReadableStream) {
  const importStarted = Date.now();
  const phaseTimings: Record<string, unknown> = {};

  const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId }, include: { dataset: true, table: true } });
  if (!upload.dataset) throw new Error("Dataset não definido");

  const mapping = (upload.mappingJson
    ? JSON.parse(upload.mappingJson)
    : (await previewFile(source as string)).columns) as ParsedColumn[];
  const knownRowCount = Number(upload.rowCount ?? 0);

  if (!mapping.length) throw new Error("Nenhuma coluna mapeada — verifique o mapeamento do arquivo");

  const tableName = upload.table?.sqlName ?? sqlIdentifier(upload.originalFilename.replace(/\.[^.]+$/, ""));
  const schema = upload.dataset.schemaName;
  const stage = `cw_stage_${upload.id.replaceAll("-", "").slice(0, 20)}`;
  const pool = await sqlPool();
  const target = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
  const staging = `${quoteIdentifier(schema)}.${quoteIdentifier(stage)}`;

  // All columns imported as NVARCHAR(MAX) NULL — eliminates type-mismatch errors on bulk insert.
  const colDefs = mapping.map(c => `${quoteIdentifier(c.sqlName)} NVARCHAR(MAX) NULL`).join(",") + ",[_cw_rh] CHAR(32) NULL";

  const targetExists = Number(
    (await pool.request().query(`SELECT CASE WHEN OBJECT_ID(N'${schema}.${tableName}',N'U') IS NULL THEN 0 ELSE 1 END AS ok`))
      .recordset[0].ok,
  ) === 1;

  // Validate schema compatibility BEFORE creating staging — fail fast on bad append/upsert
  if ((upload.mode === "append" || upload.mode === "upsert") && targetExists) {
    await assertCompatible(pool.request(), schema, tableName, mapping);
  }

  const hasDeltaCol = targetExists && await checkHasDeltaCol(pool, schema, tableName);
  const schemaOk = targetExists && await schemaMatchesSilent(pool, schema, tableName, mapping);
  const deltaReplace = upload.mode === "replace" && hasDeltaCol && schemaOk;
  // Phase 2: SDK pre-computed delta — deltaJson holds JSON array of hashes to delete
  const phase2 = deltaReplace && upload.deltaJson != null;
  const toDelete: string[] = phase2 ? (JSON.parse(upload.deltaJson!) as string[]) : [];

  // ── Idempotency: if staging already exists and has rows, skip data loading ──
  // This handles retries where the staging was populated but the transaction failed.
  const stagingHasData = await checkStagingHasData(pool, schema, stage);

  if (!stagingHasData) {
    // Create staging table (Phase 2 inserts directly into target — no staging needed)
    if (!phase2) {
      await pool.request().query(
        `IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging};
         CREATE TABLE ${staging} (${colDefs})`,
      );
    }
  } else {
    console.log("[importUpload] staging já populado, pulando carga (retry idempotente) upload=%s", uploadId);
  }

  let total = 0, inserted = 0, updated = 0;
  let lastProgressMs = Date.now();
  // Scheduled cleanup of the clean blob — called after successful commit
  let deleteCleanBlob: (() => Promise<void>) | undefined;

  try {
    const ext = extname(upload.originalFilename).toLowerCase();
    const smallCsv = !phase2 && ext === ".csv" && Number(upload.sizeBytes) <= SMALL_CSV_TDS_THRESHOLD_BYTES;
    const useBlob = !!env().CATWORLD_AZURE_BLOB_CONNECTION_STRING && !smallCsv;
    const destTable = phase2 ? tableName : stage;
    const preview = upload.previewJson ? JSON.parse(upload.previewJson) as FilePreview : null;
    const opts: RowsFromFileOpts = { encoding: preview?.encoding ?? "utf8", separator: preview?.separator ?? ",", ext };

    const onProgress = (n: number) => {
      const now = Date.now();
      if (now - lastProgressMs > 10_000) {
        void prisma.upload.update({
          where: { id: upload.id },
          data: { progress: Math.min(75, 35 + Math.floor(n / Math.max(knownRowCount, 1) * 40)) },
        });
        lastProgressMs = now;
      }
    };

    if (!stagingHasData) {
      if (useBlob) {
        // Fast path: stream → clean blob → BULK INSERT
        const cleanBlobName = `bulkimport/${uploadId}.csv`;
        try {
          const blobResult = await bulkInsertFromBlob(
            uploadId, source, mapping, schema, destTable, opts, onProgress, phase2, knownRowCount,
          );
          total = blobResult.total;
          phaseTimings.importMethod = "blob-bulk";
          phaseTimings.bulkBlob = blobResult;

          // Schedule clean blob deletion after successful commit
          let cleanBlobDeleted = false;
          deleteCleanBlob = async () => {
            if (cleanBlobDeleted || !env().CATWORLD_AZURE_BLOB_CONNECTION_STRING) return;
            cleanBlobDeleted = true;
            const { BlobServiceClient } = await import("@azure/storage-blob");
            const { env: getEnv } = await import("@/server/env");
            const eBlob = getEnv();
            const s = BlobServiceClient.fromConnectionString(eBlob.CATWORLD_AZURE_BLOB_CONNECTION_STRING!);
            await s.getContainerClient(eBlob.CATWORLD_AZURE_BLOB_CONTAINER)
              .getBlockBlobClient(blobResult.cleanBlobName).delete().catch(() => {});
          };
        } catch (bulkError) {
          // Always clean up the clean blob on any failure
          await deleteBulkCleanBlob(cleanBlobName);

          const message = bulkError instanceof Error ? bulkError.message : String(bulkError);
          // OLE DB provider errors are transient infrastructure failures — fall back to TDS
          if (!message.includes('OLE DB provider "BULK"') && !message.includes("blob does not exist")) {
            throw bulkError;
          }

          // Phase 2 inserts directly into the target (no staging) — TDS fallback would risk
          // duplicates if BULK INSERT partially succeeded. Let the worker retry naturally.
          if (phase2) throw bulkError;

          console.warn("[importUpload] BULK INSERT falhou (%s), tentando TDS fallback upload=%s", message.slice(0, 80), uploadId);
          phaseTimings.importMethod = "tds-fallback-after-bulk-error";

          // TRUNCATE staging before TDS — BULK INSERT may have left partial data
          await pool.request()
            .query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL TRUNCATE TABLE ${staging}`)
            .catch(() => {});

          // Re-download original source for TDS (stream was already consumed by bulkInsertFromBlob)
          // Use originals/ first (guaranteed by PUT route copy, no lifecycle TTL)
          const { downloadFile } = await import("@/server/storage");
          let tdsSource: NodeJS.ReadableStream;
          try {
            tdsSource = await downloadFile(`originals/${upload.id}${ext}`);
          } catch {
            tdsSource = await downloadFile(upload.blobName);
          }

          total = await tdsBulkCopy(pool, tdsSource, mapping, schema, destTable, opts, knownRowCount, uploadId, onProgress);
        }
      } else {
        // TDS path: small CSV or no blob storage configured
        phaseTimings.importMethod = smallCsv ? "tds-small-csv" : "tds-primary";
        total = await tdsBulkCopy(pool, source, mapping, schema, destTable, opts, knownRowCount, uploadId, onProgress);
      }
    } else {
      // Idempotent retry: staging already populated, just count what's there
      const countRes = await pool.request().query(`SELECT COUNT_BIG(*) n FROM ${staging}`);
      total = Number(countRes.recordset[0].n);
      phaseTimings.importMethod = "idempotent-retry";
    }

    // ── Atomic transaction ─────────────────────────────────────────────────────
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const request = new sql.Request(tx);

      if (phase2) {
        // Phase 2: new rows already BULK inserted into target.
        // Delete removed rows using batched IN clauses — avoids #cw_del temp table compilation issue.
        inserted = total;
        if (toDelete.length > 0) {
          const BATCH = 500;
          for (let i = 0; i < toDelete.length; i += BATCH) {
            const batch = toDelete.slice(i, i + BATCH);
            // Hashes are validated as /^[0-9a-f]{32}$/ at the API layer — safe to inline
            const placeholders = batch.map(h => `'${h}'`).join(",");
            const delRes = await request.query(
              `DELETE FROM ${target} WHERE [_cw_rh] IN (${placeholders}); SELECT @@ROWCOUNT deleted;`,
            );
            updated += Number(delRes.recordset[0]?.deleted ?? 0);
          }
        }
      } else if (deltaReplace) {
        // Phase 1: full file in staging — INSERT new rows, DELETE removed rows
        const colList = mapping.map(c => quoteIdentifier(c.sqlName)).join(",");
        const deltaStats = await request.query(`
          DECLARE @ins INT, @del INT;
          INSERT INTO ${target} (${colList},[_cw_rh])
            SELECT ${colList},[_cw_rh] FROM ${staging} s
            WHERE NOT EXISTS(SELECT 1 FROM ${target} t WHERE t.[_cw_rh]=s.[_cw_rh]);
          SET @ins=@@ROWCOUNT;
          DELETE t FROM ${target} t
            WHERE NOT EXISTS(SELECT 1 FROM ${staging} s WHERE s.[_cw_rh]=t.[_cw_rh]);
          SET @del=@@ROWCOUNT;
          DROP TABLE ${staging};
          SELECT @ins inserted, @del deleted;
        `);
        inserted = Number(deltaStats.recordset[0]?.inserted ?? 0);
        updated = Number(deltaStats.recordset[0]?.deleted ?? 0);
      } else if (upload.mode === "replace" || !targetExists) {
        // Full replace: add hash index then rename staging to target
        await pool.request().query(`CREATE INDEX [IX__cw_rh] ON ${staging} ([_cw_rh])`);
        if (targetExists) await request.query(`DROP TABLE ${target}`);
        await request.query(`EXEC sp_rename N'${schema}.${stage}', N'${tableName}'`);
        inserted = total;
      } else if (upload.mode === "append") {
        await request.query(
          `INSERT INTO ${target} (${mapping.map(c => quoteIdentifier(c.sqlName)).join(",")})
           SELECT ${mapping.map(c => quoteIdentifier(c.sqlName)).join(",")} FROM ${staging};
           DROP TABLE ${staging}`,
        );
        inserted = total;
      } else {
        // Upsert (MERGE)
        if (!upload.keyColumn) throw new Error("Upsert exige coluna-chave");
        const key = quoteIdentifier(upload.keyColumn);
        const nonKey = mapping.filter(c => c.sqlName !== upload.keyColumn);
        const duplicates = await request.query(
          `SELECT ${key}, COUNT(*) n FROM ${staging} GROUP BY ${key} HAVING COUNT(*) > 1`,
        );
        if (duplicates.recordset.length) throw new Error("Arquivo contém chaves duplicadas para upsert");
        const whenMatched = nonKey.length > 0
          ? `WHEN MATCHED THEN UPDATE SET ${nonKey.map(c => `t.${quoteIdentifier(c.sqlName)}=s.${quoteIdentifier(c.sqlName)}`).join(",")}`
          : "";
        const merge = await request.query(`
          DECLARE @stats TABLE (action NVARCHAR(10));
          MERGE INTO ${target} AS t
          USING ${staging} AS s ON t.${key}=s.${key}
          ${whenMatched}
          WHEN NOT MATCHED BY TARGET THEN
            INSERT (${mapping.map(c => quoteIdentifier(c.sqlName)).join(",")})
            VALUES (${mapping.map(c => `s.${quoteIdentifier(c.sqlName)}`).join(",")})
          OUTPUT $action INTO @stats;
          SELECT
            SUM(CASE WHEN action='UPDATE' THEN 1 ELSE 0 END) updated,
            SUM(CASE WHEN action='INSERT' THEN 1 ELSE 0 END) inserted
          FROM @stats;
          DROP TABLE ${staging};
        `);
        updated = Number(merge.recordset[0]?.updated ?? 0);
        inserted = Number(merge.recordset[0]?.inserted ?? 0);
      }

      const countStr = (await request.query(`SELECT COUNT_BIG(*) count FROM ${target}`)).recordset[0].count as string;
      const actual = BigInt(countStr);
      const MAX_BIGINT = 9223372036854775807n;
      if (actual > MAX_BIGINT || actual < 0n)
        throw new Error(`Row count ${countStr} exceeds BIGINT range. Verifique a integridade dos dados.`);

      await tx.commit();

      // Clean blob deletion scheduled after successful commit
      if (typeof deleteCleanBlob === "function") await deleteCleanBlob();

      // Upsert table record
      const table = upload.table ?? await prisma.datasetTable.upsert({
        where: { datasetId_sqlName: { datasetId: upload.dataset.id, sqlName: tableName } },
        update: {},
        create: { datasetId: upload.dataset.id, name: tableName, sqlName: tableName },
      });

      phaseTimings.totalImportMs = Date.now() - importStarted;
      console.log("[importUpload:perf]", JSON.stringify({ uploadId: upload.id, file: upload.originalFilename, rows: Number(actual), ...phaseTimings }));

      // The physical import table stores data columns as NVARCHAR(MAX). Keep catalog
      // metadata aligned with the real SQL schema so UI/SDK type reporting is stable.
      const storedMapping = mapping.map(c => ({ ...c, sqlType: "NVARCHAR(MAX)" }));

      // Batch column metadata inserts to stay under SQL Server 2100-parameter limit
      const MAX_COLS_PER_BATCH = 500;
      for (let batchStart = 0; batchStart < storedMapping.length; batchStart += MAX_COLS_PER_BATCH) {
        const batch = storedMapping.slice(batchStart, batchStart + MAX_COLS_PER_BATCH);
        const colReq = pool.request();
        colReq.input("tableId", sql.UniqueIdentifier, table.id);
        colReq.input("uploadId", sql.UniqueIdentifier, upload.id);
        colReq.input("actual", sql.BigInt, actual);
        colReq.input("inserted", sql.BigInt, inserted);
        colReq.input("updated", sql.BigInt, updated);
        colReq.input("schemaJson", sql.NVarChar(sql.MAX), JSON.stringify(storedMapping));
        colReq.input("detailJson", sql.NVarChar(sql.MAX), JSON.stringify({ file: upload.originalFilename, rows: Number(actual), ...phaseTimings }));
        const colValues = batch.map((c, i) => {
          const gi = batchStart + i;
          colReq.input(`orig${gi}`, sql.NVarChar(255), c.originalName);
          colReq.input(`sqlName${gi}`, sql.VarChar(128), c.sqlName);
          colReq.input(`sqlType${gi}`, sql.VarChar(100), c.sqlType);
          colReq.input(`nullable${gi}`, sql.Bit, c.nullable);
          return `(NEWID(),@tableId,${gi + 1},@orig${gi},@sqlName${gi},@sqlType${gi},@nullable${gi})`;
        }).join(",");
        const isFirst = batchStart === 0;
        await colReq.query(`
          BEGIN TRANSACTION
          ${isFirst ? `DECLARE @lk INT
          EXEC @lk=sp_getapplock @Resource='ColUpd_${table.id}',@LockMode='Exclusive',@LockTimeout=120000
          IF @lk<0 THROW 50000,'lock timeout',1
          DELETE FROM dbo.cw_columns WHERE table_id=@tableId` : ""}
          INSERT INTO dbo.cw_columns(id,table_id,ordinal,original_name,sql_name,sql_type,nullable)
            VALUES${colValues}
          ${isFirst ? `UPDATE dbo.cw_tables SET row_count=@actual,updated_at=SYSUTCDATETIME() WHERE id=@tableId
          INSERT INTO dbo.cw_dataset_versions(id,table_id,upload_id,row_count,schema_json)
            VALUES(NEWID(),@tableId,@uploadId,@actual,@schemaJson)
          INSERT INTO dbo.cw_audit_events(id,event_type,resource_type,resource_id,detail_json,success)
            VALUES(NEWID(),'UPLOAD_IMPORT_PERF','upload',@uploadId,@detailJson,1)
          UPDATE dbo.cw_uploads SET table_id=@tableId,status='COMPLETED',progress=100,
            row_count=@actual,inserted_count=@inserted,updated_count=@updated,
            error_message=NULL,updated_at=SYSUTCDATETIME() WHERE id=@uploadId` : ""}
          COMMIT
        `);
      }

      return { tableId: table.id, inserted, updated, rowCount: actual };
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
  } catch (e) {
    // Best-effort: drop staging and clean blob on any failure
    await pool.request()
      .query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging}`)
      .catch(() => undefined);
    throw e;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function deleteBulkCleanBlob(cleanBlobName: string): Promise<void> {
  try {
    if (!env().CATWORLD_AZURE_BLOB_CONNECTION_STRING) return;
    const { BlobServiceClient } = await import("@azure/storage-blob");
    const { env: getEnv } = await import("@/server/env");
    const e = getEnv();
    const s = BlobServiceClient.fromConnectionString(e.CATWORLD_AZURE_BLOB_CONNECTION_STRING!);
    await s.getContainerClient(e.CATWORLD_AZURE_BLOB_CONTAINER).getBlockBlobClient(cleanBlobName).delete().catch(() => {});
  } catch { /* best-effort */ }
}

async function checkStagingHasData(pool: sql.ConnectionPool, schema: string, stage: string): Promise<boolean> {
  try {
    const r = await pool.request().query(
      `SELECT CASE WHEN OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL
              THEN (SELECT COUNT(*) FROM ${quoteIdentifier(schema)}.${quoteIdentifier(stage)})
              ELSE 0 END n`,
    );
    return Number(r.recordset[0].n) > 0;
  } catch {
    return false;
  }
}

async function checkHasDeltaCol(pool: sql.ConnectionPool, schema: string, table: string): Promise<boolean> {
  try {
    const r = await pool.request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, table)
      .query("SELECT 1 ok FROM sys.columns WHERE object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) AND name='_cw_rh'");
    return r.recordset.length > 0;
  } catch { return false; }
}

async function schemaMatchesSilent(pool: sql.ConnectionPool, schema: string, table: string, mapping: ParsedColumn[]): Promise<boolean> {
  try {
    // Check names AND that every data column is NVARCHAR nullable (system_type_id 231 = nvarchar).
    // Old tables with typed NOT NULL columns (DATE, DATETIME2, etc.) must fall through to full replace
    // to avoid implicit NULL conversion errors during delta INSERT.
    const result = await pool.request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, table)
      .query("SELECT c.name, c.system_type_id, c.is_nullable FROM sys.columns c WHERE c.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) ORDER BY c.column_id");
    const rows = result.recordset as { name: string; system_type_id: number; is_nullable: boolean }[];
    const dataRows = rows.filter(r => r.name !== "_cw_rh");
    const actual = dataRows.map(r => r.name);
    const expected = mapping.map(c => c.sqlName);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
    // All data columns must be NVARCHAR (231) and nullable for delta replace to be safe
    return dataRows.every(r => r.system_type_id === 231 && r.is_nullable);
  } catch { return false; }
}

async function assertCompatible(request: sql.Request, schema: string, table: string, columns: ParsedColumn[]) {
  const result = await request
    .input("schema", sql.NVarChar, schema)
    .input("table", sql.NVarChar, table)
    .query("SELECT c.name FROM sys.columns c JOIN sys.types t ON c.user_type_id=t.user_type_id WHERE c.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) ORDER BY c.column_id");
  const actual = result.recordset.map((r: Record<string, unknown>) => String(r.name)).filter((n: string) => n !== "_cw_rh");
  const expected = columns.map(c => c.sqlName);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Schema incompatível. Esperado: ${expected.join(", ")}; atual: ${actual.join(", ")}`);
}

export function convert(v: unknown, type: string) {
  if (v == null || String(v).trim() === "") return null;
  if (type === "BIGINT") return String(v);
  if (type.startsWith("DECIMAL")) {
    const s = String(v).trim();
    return Number(s.includes(",") ? s.replaceAll(".", "").replace(",", ".") : s);
  }
  if (type === "DATE" || type === "DATETIME2") {
    const s = String(v).trim();
    const iso = normalizeDateLike(s) ?? s;
    return new Date(type === "DATE" ? iso.slice(0, 10) + "T00:00:00Z" : iso);
  }
  if (type === "TIME") return String(v).trim();
  return String(v);
}
