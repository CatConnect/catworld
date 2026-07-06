import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { previewFile, type ParsedColumn } from "../src/server/uploads/parser";
import { bulkInsertFromBlob } from "../src/server/uploads/importer-bulk-blob";
import { downloadFile } from "../src/server/storage";
import { sqlPool } from "../src/server/azure/sql";
import { quoteIdentifier } from "../src/server/security/naming";

// Load .env
const envPath = resolve(".", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const sep = t.indexOf("=");
    if (sep === -1) continue;
    const key = t.slice(0, sep).trim();
    let val = t.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

async function main() {
  const prisma = new PrismaClient();

  // Pick distinct uploads that failed with generic error - focus on smaller files first
  const ids = [
    // XLSX files (small, easy to repro)
    "a1b1eb85-419d-4294-be8a-594fe7222867", // Meta_Minas_2026.xlsx - 113 rows, 5 cols
    "28cf07f0-c4bb-4e11-b712-8b0678e79772", // Feriado.xlsx - 129 rows, 6 cols
    "6fbadb41-de1c-40b9-8d85-e845905b5464", // 2.18 Acomp Custos.xlsx - 26 rows, 163 cols
    // Small CSV with generic error
    "22ad2b51-d001-4c4f-92f3-9757c20c8bbf", // faturamento_direto.csv - 14 rows, 15 cols
    "dc098716-6545-49b3-987c-7c55b2119b1f", // empresa.csv - 19 rows, 51 cols
    // CSV with concrete errors (verify parser fix works)
    "771fc6e8-febe-4699-b8c5-9815d47efc7d", // vendas.csv - row 178657, col 17
    "103a7e02-0f19-48a3-bb3e-adc1133f7a57", // insumos_comprados.csv - row 88233, col 133
  ];

  for (const id of ids) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`PROCESSANDO: ${id}`);
    console.log(`${"=".repeat(80)}`);

    const upload = await prisma.upload.findUnique({
      where: { id },
      include: { dataset: true }
    });

    if (!upload) {
      console.log(`  -> Upload não encontrado no banco.`);
      continue;
    }

    console.log(`  File: ${upload.originalFilename}`);
    console.log(`  Blob: ${upload.blobName}`);
    console.log(`  Schema: ${upload.dataset?.schemaName}`);
    console.log(`  Size: ${upload.sizeBytes} bytes`);

    let tempDir: string | undefined;
    let tempPath: string | undefined;
    const pool = await sqlPool();
    const ext = extname(upload.originalFilename).toLowerCase();
    const hash8 = id.replaceAll("-", "").slice(0, 8);
    const stageTable = `cw_fresh_${hash8}`;
    const schema = upload.dataset!.schemaName;

    try {
      // 1. Download blob to temp file
      console.log(`  [1/5] Baixando blob...`);
      tempDir = await mkdtemp(join(tmpdir(), "catworld-repro-"));
      tempPath = join(tempDir, basename(upload.originalFilename));
      const stream = await downloadFile(upload.blobName);
      await pipeline(stream, createWriteStream(tempPath));
      console.log(`  -> Baixado para: ${tempPath}`);

      // 2. Run previewFile with CURRENT parser
      console.log(`  [2/5] Rodando previewFile com parser atual...`);
      const preview = await previewFile(tempPath);
      console.log(`  -> ${preview.columns.length} colunas, ${preview.rowCount} linhas, encoding=${preview.encoding}, separator=${preview.separator}`);
      console.log(`  -> Schema inferido:`);
      for (const c of preview.columns.slice(0, 10)) {
        console.log(`       ${c.sqlName}: ${c.sqlType}${c.nullable ? " NULL" : " NOT NULL"}`);
      }
      if (preview.columns.length > 10) console.log(`       ... +${preview.columns.length - 10} mais`);

      // Compare with stored mapping
      if (upload.mappingJson) {
        const storedMapping = JSON.parse(upload.mappingJson) as ParsedColumn[];
        const diffs: string[] = [];
        for (let i = 0; i < Math.max(storedMapping.length, preview.columns.length); i++) {
          const s = storedMapping[i];
          const p = preview.columns[i];
          if (!s || !p) {
            diffs.push(`  col[${i}]: stored=${s?.sqlType ?? "MISSING"} vs preview=${p?.sqlType ?? "MISSING"}`);
          } else if (s.sqlType !== p.sqlType || s.sqlName !== p.sqlName) {
            diffs.push(`  col[${i}]: stored ${s.sqlName}:${s.sqlType} != preview ${p.sqlName}:${p.sqlType}`);
          }
        }
        if (diffs.length > 0) {
          console.log(`  -> DIFERENÇAS do mapping armazenado:`);
          for (const d of diffs) console.log(d);
        } else {
          console.log(`  -> Schema do preview atual IDÊNTICO ao mapping armazenado.`);
        }
      }

      // 3. Create temp table
      console.log(`  [3/5] Criando tabela temporária ${schema}.${stageTable}...`);
      const colDefs = preview.columns.map(c =>
        `${quoteIdentifier(c.sqlName)} ${c.sqlType} ${c.nullable ? "NULL" : "NOT NULL"}`
      ).join(",") + ",[_cw_rh] CHAR(32) NULL";

      await pool.request().query(`IF OBJECT_ID(N'${schema}.${stageTable}',N'U') IS NOT NULL DROP TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(stageTable)}`);
      await pool.request().query(`CREATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(stageTable)} (${colDefs})`);
      console.log(`  -> Tabela criada.`);

      // 4. Run bulkInsertFromBlob
      console.log(`  [4/5] Executando BULK INSERT de teste...`);
      const start = Date.now();
      try {
        const result = await bulkInsertFromBlob(
          id,
          tempPath,
          preview.columns,
          schema,
          stageTable,
          { encoding: preview.encoding, separator: preview.separator ?? ",", ext }
        );
        const elapsed = Date.now() - start;
        console.log(`  -> SUCESSO! ${result.total} linhas em ${elapsed}ms (bulkAttempts=${result.bulkAttempts})`);
      } catch (bulkError: unknown) {
        const elapsed = Date.now() - start;
        const msg = bulkError instanceof Error ? bulkError.message : String(bulkError);
        console.log(`  -> BULK INSERT FALHOU após ${elapsed}ms`);
        console.log(`  -> Erro: ${msg}`);

        // Try to extract precedingErrors from mssql
        if (bulkError && typeof bulkError === "object" && "precedingErrors" in bulkError) {
          const preceding = (bulkError as Record<string, unknown>).precedingErrors;
          console.log(`  -> precedingErrors: ${JSON.stringify(preceding, null, 2)}`);
        }

        // If error mentions row/column, try to inspect the CSV content
        const rowMatch = msg.match(/row (\d+)/i);
        const colMatch = msg.match(/column (\d+)/i);
        if (rowMatch || colMatch) {
          console.log(`  -> Referência a linha/coluna no erro - inspecionando valores próximos...`);
          // We'll inspect the converted CSV in step 5 if needed
        }
      }

      // 5. If it failed, let's look at the actual data via previewFile rows
      if (preview.columns.length <= 30) {
        console.log(`  [5/5] Amostra de dados (primeiras 5 linhas):`);
        for (let i = 0; i < Math.min(5, preview.rows.length); i++) {
          const row = preview.rows[i];
          const entries = Object.entries(row).slice(0, 8);
          const vals = entries.map(([k, v]) => `${k}=${JSON.stringify(String(v ?? "")).slice(0, 40)}`).join(" | ");
          console.log(`    Row ${i + 1}: ${vals}`);
        }
      }

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  -> ERRO GERAL: ${msg}`);
      if (e instanceof Error && e.stack) {
        console.log(`  -> Stack: ${e.stack.slice(0, 500)}`);
      }
    } finally {
      // Cleanup
      try {
        console.log(`  [Cleanup] Removendo tabela ${schema}.${stageTable}...`);
        await pool.request().query(`IF OBJECT_ID(N'${schema}.${stageTable}',N'U') IS NOT NULL DROP TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(stageTable)}`);
      } catch { /* ignore */ }

      if (tempDir) {
        try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }

  await prisma.$disconnect();
  console.log(`\n${"=".repeat(80)}`);
  console.log(`REPRODUÇÃO CONCLUÍDA.`);
}

void main().catch(e => {
  console.error("FATAL:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});