/**
 * Stress test com arquivos reais de C:\Users\TRABALHO\Documents\output
 *
 * Para cada arquivo:
 *   1. Preview (detecta encoding, separator, rowCount esperado)
 *   2. 1º import (replace — cria tabela)
 *   3. 2º import (replace na MESMA tabela — re-upload, cenário que estava quebrando)
 *   4. Verifica physicalRows == previewRowCount em ambas as importações
 *   5. Registra importMethod, parsedRows, physicalRows, timing
 *
 * Usage: npx tsx scripts/stress-real-files.ts [arquivo.csv]
 *   sem argumento → testa todos os arquivos
 */

import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { prisma } from "../src/server/db";
import { sqlPool } from "../src/server/azure/sql";
import { quoteIdentifier } from "../src/server/security/naming";
import { previewFile } from "../src/server/uploads/parser";
import { importUpload } from "../src/server/uploads/importer";
import { sqlIdentifier } from "../src/server/security/naming";

const OUTPUT_DIR = "C:/Users/TRABALHO/Documents/output";
const DATASET_ID = "02b51d71-b9f0-4594-89a4-aa310ebafc0e";

// Arquivos grandes que demoram muito podem ser skipaados com --skip-large
const SKIP_LARGE_MB = process.argv.includes("--skip-large") ? 20 : Infinity;
const ONLY_FILE = process.argv.find(a => a.endsWith(".csv") && !a.includes("stress"));

type RunResult = {
  file: string;
  sizeMb: number;
  encoding: string;
  separator: string;
  previewRows: number;
  import1: { physicalRows: number; method: string; ms: number } | null;
  import2: { physicalRows: number; method: string; ms: number } | null;
  passed: boolean;
  error?: string;
};

async function runOneFile(filePath: string): Promise<RunResult> {
  const file = basename(filePath);
  const sizeMb = Math.round(statSync(filePath).size / 1024 / 1024 * 10) / 10;
  let encoding = "?", separator = "?", previewRows = 0;

  try {
    const preview = await previewFile(filePath);
    encoding = preview.encoding;
    separator = preview.separator ?? ",";
    previewRows = preview.rowCount;
  } catch (e) {
    return { file, sizeMb, encoding, separator, previewRows: 0, import1: null, import2: null, passed: false, error: `preview: ${e instanceof Error ? e.message : e}` };
  }

  const dataset = await prisma.dataset.findUniqueOrThrow({ where: { id: DATASET_ID } });
  const tableName = `stress_real_${sqlIdentifier(file.replace(/\.csv$/i, "")).slice(0, 40)}_${Date.now()}`;
  const tableRecord = await prisma.datasetTable.create({
    data: { datasetId: DATASET_ID, name: tableName, sqlName: tableName },
  });

  async function doImport(label: string): Promise<{ physicalRows: number; method: string; ms: number }> {
    const preview = await previewFile(filePath);
    const upload = await prisma.upload.create({
      data: {
        datasetId: DATASET_ID,
        tableId: tableRecord.id,
        originalFilename: file,
        blobName: `local-test/${Date.now()}-${file}`,
        sizeBytes: BigInt(statSync(filePath).size),
        mode: "replace",
        status: "QUEUED_IMPORT",
        progress: 25,
        previewJson: JSON.stringify(preview),
        mappingJson: JSON.stringify(preview.columns),
        rowCount: BigInt(preview.rowCount),
      },
    });
    const t0 = Date.now();
    try {
      await importUpload(upload.id, filePath);
      const pool = await sqlPool();
      const cr = await pool.request().query(
        `SELECT COUNT_BIG(*) n FROM ${quoteIdentifier(dataset.schemaName)}.${quoteIdentifier(tableName)}`,
      );
      const physicalRows = Number(cr.recordset[0].n);
      const audit = await prisma.auditEvent.findFirst({
        where: { resourceId: upload.id, eventType: "UPLOAD_IMPORT_PERF" },
        orderBy: { createdAt: "desc" },
      });
      const detail = audit?.detailJson ? JSON.parse(audit.detailJson as string) : {};
      return { physicalRows, method: detail.importMethod ?? "unknown", ms: Date.now() - t0 };
    } finally {
      await prisma.job.deleteMany({ where: { uploadId: upload.id } }).catch(() => {});
      await prisma.upload.delete({ where: { id: upload.id } }).catch(() => {});
    }
  }

  const result: RunResult = { file, sizeMb, encoding, separator, previewRows, import1: null, import2: null, passed: false };

  try {
    result.import1 = await doImport("1º import");
    result.import2 = await doImport("re-upload (replace)");

    const ok1 = result.import1.physicalRows === previewRows;
    const ok2 = result.import2.physicalRows === previewRows;
    result.passed = ok1 && ok2;
    if (!ok1) result.error = (result.error ?? "") + `1º import: ${result.import1.physicalRows}/${previewRows} `;
    if (!ok2) result.error = (result.error ?? "") + `re-upload: ${result.import2.physicalRows}/${previewRows} `;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    const pool = await sqlPool();
    await pool.request().query(
      `IF OBJECT_ID(N'${dataset.schemaName}.${tableName}','U') IS NOT NULL DROP TABLE ${quoteIdentifier(dataset.schemaName)}.${quoteIdentifier(tableName)}`,
    ).catch(() => {});
    await prisma.datasetTable.delete({ where: { id: tableRecord.id } }).catch(() => {});
  }

  return result;
}

async function main() {
  console.log("=== Stress Test — Arquivos Reais (re-upload) ===\n");

  const all = readdirSync(OUTPUT_DIR)
    .filter(f => f.toLowerCase().endsWith(".csv"))
    .map(f => join(OUTPUT_DIR, f));

  const files = all.filter(f => {
    if (ONLY_FILE && basename(f) !== ONLY_FILE) return false;
    const mb = statSync(f).size / 1024 / 1024;
    if (mb > SKIP_LARGE_MB) { console.log(`  SKIP (>${SKIP_LARGE_MB}MB): ${basename(f)}`); return false; }
    return true;
  });

  console.log(`Arquivos a testar: ${files.length}\n`);

  const results: RunResult[] = [];

  for (const fp of files) {
    const file = basename(fp);
    const mb = Math.round(statSync(fp).size / 1024 / 1024 * 10) / 10;
    process.stdout.write(`  ${file} (${mb}MB) ... `);
    const r = await runOneFile(fp);
    results.push(r);

    if (r.passed) {
      const m1 = r.import1?.method ?? "?";
      const m2 = r.import2?.method ?? "?";
      const ms1 = r.import1?.ms ?? 0;
      const ms2 = r.import2?.ms ?? 0;
      console.log(`✓ ${r.previewRows} rows | enc=${r.encoding} sep="${r.separator}" | 1º:${m1} ${ms1}ms 2º:${m2} ${ms2}ms`);
    } else {
      console.log(`✗ ${r.error ?? "unknown"}`);
    }
  }

  // Sumário
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed);
  console.log(`\n=== Resultados: ${passed}/${results.length} passaram ===`);

  if (failed.length > 0) {
    console.log("\nFalhas:");
    for (const r of failed) {
      console.log(`  ✗ ${r.file}: ${r.error}`);
      if (r.import1) console.log(`       1º: physical=${r.import1.physicalRows} expected=${r.previewRows} method=${r.import1.method}`);
      if (r.import2) console.log(`       2º: physical=${r.import2.physicalRows} expected=${r.previewRows} method=${r.import2.method}`);
    }
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
