/**
 * Diagnostics: find exactly where rows are lost during import of a large CSV.
 *
 * Stages measured:
 *   1. Raw line count (wc -l equivalent via streaming)
 *   2. csv-parse row count (same as preview + rowsFromFile non-UTF8 path)
 *   3. rowsFromFile generator count (actual rows the importer sees)
 *   4. Clean blob row count (rows written to Azure Blob before BULK INSERT)
 *   5. Physical table row count after a real import into a temp table
 *
 * Usage: npx tsx scripts/diagnose-row-loss.ts
 */

import { createReadStream } from "node:fs";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { parse } from "csv-parse";
import iconv from "iconv-lite";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { prisma } from "../src/server/db";
import { sqlPool } from "../src/server/azure/sql";
import { quoteIdentifier } from "../src/server/security/naming";
import { rowsFromFile } from "../src/server/uploads/parser";
import { sanitizeCsvField, typedCsvField } from "../src/server/uploads/importer-bulk-blob";
import { env } from "../src/server/env";

const FILE_PATH = "C:/Users/TRABALHO/CpCr - 3.4.csv";
const DATASET_ID = "02b51d71-b9f0-4594-89a4-aa310ebafc0e";
const ENCODING = "win1252";
const SEPARATOR = ";";

async function countRawLines(path: string): Promise<number> {
  let lines = 0;
  let remainder = 0;
  for await (const chunk of createReadStream(path)) {
    const buf = chunk as Buffer;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) lines++; // LF
    }
    remainder = buf.length > 0 ? (buf[buf.length - 1] === 0x0a ? 0 : 1) : 0;
  }
  return lines + remainder; // includes header
}

async function countCsvParseRows(path: string, encoding: string, separator: string): Promise<{ rows: number; emptySkipped: number; header: string[] }> {
  let rows = 0;
  let emptySkipped = 0;
  let header: string[] = [];
  let isHeader = true;
  const stream = createReadStream(path)
    .pipe(iconv.decodeStream(encoding))
    .pipe(parse({ delimiter: separator, bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true }));
  for await (const row of stream as AsyncIterable<string[]>) {
    if (isHeader) { header = row; isHeader = false; continue; }
    rows++;
  }
  return { rows, emptySkipped, header };
}

async function countCsvParseRowsNoSkip(path: string, encoding: string, separator: string): Promise<number> {
  let rows = 0;
  let isHeader = true;
  const stream = createReadStream(path)
    .pipe(iconv.decodeStream(encoding))
    .pipe(parse({ delimiter: separator, bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: false }));
  for await (const _row of stream as AsyncIterable<string[]>) {
    if (isHeader) { isHeader = false; continue; }
    rows++;
  }
  return rows;
}

async function main() {
  console.log("=== Diagnose Row Loss ===");
  const size = statSync(FILE_PATH).size;
  console.log(`File: ${FILE_PATH}`);
  console.log(`Size: ${size.toLocaleString()} bytes`);

  // Stage 1: raw line count
  console.log("\n[1] Counting raw lines (LF)...");
  const rawLines = await countRawLines(FILE_PATH);
  console.log(`    Raw lines (including header): ${rawLines}`);
  console.log(`    Data rows (excl. header):    ${rawLines - 1}`);

  // Stage 2: csv-parse with skip_empty_lines=true
  console.log("\n[2] csv-parse (skip_empty_lines=true, same as preview)...");
  const { rows: csvRows, header } = await countCsvParseRows(FILE_PATH, ENCODING, SEPARATOR);
  console.log(`    Rows: ${csvRows} (preview would report this as rowCount)`);
  console.log(`    Columns: ${header.length}`);

  // Stage 3: csv-parse WITHOUT skip_empty_lines
  console.log("\n[3] csv-parse (skip_empty_lines=false, to see if empty lines exist)...");
  const csvRowsNoSkip = await countCsvParseRowsNoSkip(FILE_PATH, ENCODING, SEPARATOR);
  console.log(`    Rows: ${csvRowsNoSkip}`);
  console.log(`    Empty lines filtered by skip_empty_lines=true: ${csvRowsNoSkip - csvRows}`);

  // Stage 4: rowsFromFile (actual importer path — with preview mapping)
  console.log("\n[4] rowsFromFile generator (importer sees these rows)...");
  const { previewFile } = await import("../src/server/uploads/parser");
  const preview = await previewFile(FILE_PATH);
  let generatorRows = 0;
  for await (const _row of rowsFromFile(FILE_PATH, preview.columns, { encoding: ENCODING, separator: SEPARATOR, ext: ".csv" })) {
    generatorRows++;
  }
  console.log(`    Rows yielded by rowsFromFile: ${generatorRows}`);

  // Stage 5: count rows written to clean blob (same as bulkInsertFromBlob writes)
  console.log("\n[5] Simulating clean blob row count (typedCsvField conversion)...");
  let blobRows = 0;
  for await (const row of rowsFromFile(FILE_PATH, preview.columns, { encoding: ENCODING, separator: SEPARATOR, ext: ".csv" })) {
    const csvLine = preview.columns.map(c => typedCsvField(row[c.sqlName], c.sqlType)).join("|");
    const hashLine = preview.columns.map(c => sanitizeCsvField(row[c.sqlName])).join("|");
    const _hash = createHash("md5").update(hashLine).digest("hex");
    void csvLine; // just counting, not actually writing
    blobRows++;
  }
  console.log(`    Rows that would be written to clean blob: ${blobRows}`);

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Raw LF lines (data):       ${rawLines - 1}`);
  console.log(`csv-parse (skip_empty):    ${csvRows}  ← preview rowCount`);
  console.log(`csv-parse (no skip):       ${csvRowsNoSkip}`);
  console.log(`rowsFromFile generator:    ${generatorRows}`);
  console.log(`Clean blob rows:           ${blobRows}`);
  console.log();

  const lostInCsvParse   = (rawLines - 1) - csvRows;
  const lostInGenerator  = csvRows - generatorRows;
  const lostInBlobConv   = generatorRows - blobRows;

  if (lostInCsvParse > 0)  console.log(`⚠  ${lostInCsvParse} rows lost: raw → csv-parse (empty lines skipped)`);
  if (lostInGenerator > 0) console.log(`⚠  ${lostInGenerator} rows lost: csv-parse → rowsFromFile`);
  if (lostInBlobConv > 0)  console.log(`⚠  ${lostInBlobConv} rows lost: rowsFromFile → clean blob`);
  if (lostInCsvParse === 0 && lostInGenerator === 0 && lostInBlobConv === 0)
    console.log("✓  No rows lost before BULK INSERT. If physical table has fewer rows, BULK INSERT is dropping them.");

  // Optionally do a live import into a temp table
  const args = process.argv.slice(2);
  if (args.includes("--live-import")) {
    console.log("\n[6] Live import into temp table (--live-import flag)...");
    const dataset = await prisma.dataset.findUniqueOrThrow({ where: { id: DATASET_ID } });
    const tmpTable = `tmp_diagnose_${Date.now()}`;
    const table = await prisma.datasetTable.create({ data: { datasetId: DATASET_ID, name: tmpTable, sqlName: tmpTable } });
    const md5hash = createHash("md5");
    for await (const chunk of createReadStream(FILE_PATH)) md5hash.update(chunk);
    const fileHash = md5hash.digest("hex");
    const upload = await prisma.upload.create({
      data: {
        datasetId: DATASET_ID, tableId: table.id,
        originalFilename: "CpCr - 3.4.csv",
        blobName: `local-test/${Date.now()}-CpCr-3.4.csv`,
        sizeBytes: BigInt(size), fileHash, mode: "replace",
        status: "QUEUED_IMPORT", progress: 25,
        previewJson: JSON.stringify(preview),
        mappingJson: JSON.stringify(preview.columns),
        rowCount: BigInt(preview.rowCount),
      },
    });
    try {
      const { importUpload } = await import("../src/server/uploads/importer");
      const result = await importUpload(upload.id, FILE_PATH);
      const pool = await sqlPool();
      const count = await pool.request().query(
        `SELECT COUNT_BIG(*) n FROM ${quoteIdentifier(dataset.schemaName)}.${quoteIdentifier(tmpTable)}`,
      );
      console.log(`    importUpload result:`, JSON.stringify(result, (_, v) => typeof v === "bigint" ? v.toString() : v));
      console.log(`    Physical table rows: ${count.recordset[0].n}`);
      console.log(`    Delta (blobRows - physical): ${blobRows - Number(count.recordset[0].n)}`);
    } finally {
      const pool = await sqlPool();
      await pool.request().query(
        `IF OBJECT_ID(N'${dataset.schemaName}.${tmpTable}','U') IS NOT NULL DROP TABLE ${quoteIdentifier(dataset.schemaName)}.${quoteIdentifier(tmpTable)}`,
      ).catch(() => {});
      await prisma.job.deleteMany({ where: { uploadId: upload.id } }).catch(() => {});
      await prisma.upload.delete({ where: { id: upload.id } }).catch(() => {});
      await prisma.datasetTable.delete({ where: { id: table.id } }).catch(() => {});
    }
  } else {
    console.log("\nTip: run with --live-import to also measure physical table rows via a real import.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
