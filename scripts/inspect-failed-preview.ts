import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

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

  // Pick distinct representative failures
  const ids = [
    // XLSX - small files that keep failing
    "6fbadb41-de1c-40b9-8d85-e845905b5464", // 2.18 Acomp Custos.xlsx - 26 rows
    "a1b1eb85-419d-4294-be8a-594fe7222867", // Meta_Minas_2026.xlsx - 113 rows
    "28cf07f0-c4bb-4e11-b712-8b0678e79772", // Feriado.xlsx - 129 rows
    // CSV - ones with concrete error
    "771fc6e8-febe-4699-b8c5-9815d47efc7d", // vendas.csv - row 178657, col 17 nome_produto
    "103a7e02-0f19-48a3-bb3e-adc1133f7a57", // insumos_comprados.csv - row 88233, col 133
    // CSV - small files failing with generic error
    "22ad2b51-d001-4c4f-92f3-9757c20c8bbf", // faturamento_direto.csv - 14 rows
    "dc098716-6545-49b3-987c-7c55b2119b1f", // empresa.csv - 19 rows
    // CSV - medium files with generic error
    "d8b60bb0-d7ca-4473-95bd-e31360607429", // razaoconsolidada(1).csv - 338k rows
    "afcaa38d-8712-41e1-b635-2d47223a041c", // Movimenta├º├úo_analitica.csv - 109k rows
  ];

  for (const id of ids) {
    const u = await prisma.upload.findUnique({
      where: { id },
      include: { dataset: true, table: true, jobs: true }
    });

    if (!u) { console.log(`\n=== ${id} NOT FOUND ===`); continue; }

    console.log(`\n========================================`);
    console.log(`ID: ${u.id}`);
    console.log(`File: ${u.originalFilename}`);
    console.log(`Dataset: ${u.dataset?.schemaName}`);
    console.log(`Status: ${u.status}`);
    console.log(`RowCount: ${String(u.rowCount)}`);
    console.log(`Size: ${String(u.sizeBytes)} bytes`);
    console.log(`Error: ${u.errorMessage}`);
    console.log(`Blob: ${u.blobName}`);

    // Show jobs
    for (const j of u.jobs) {
      console.log(`  Job ${j.type}: ${j.status} (attempt ${j.attempts}/${j.maxAttempts})`);
    }

    // Parse preview/mapping
    if (u.previewJson) {
      try {
        const preview = JSON.parse(u.previewJson);
        console.log(`\n  Preview encoding: ${preview.encoding}, separator: ${preview.separator}`);
        const cols = preview.columns?.slice(0, 20) || [];
        console.log(`  Preview columns (${preview.columns?.length} total):`);
        for (const c of cols) {
          console.log(`    ${c.sqlName}: ${c.sqlType}${c.nullable ? " NULL" : " NOT NULL"} (orig: ${c.originalName})`);
        }
        if (preview.columns?.length > 20) console.log(`    ... +${preview.columns.length - 20} more`);
      } catch (e) { console.log(`  previewJson parse error: ${String(e)}`); }
    }

    if (u.mappingJson && u.mappingJson !== u.previewJson) {
      try {
        const mapping = JSON.parse(u.mappingJson);
        console.log(`\n  Mapping columns (${mapping.length} total):`);
        for (const c of mapping.slice(0, 20)) {
          console.log(`    ${c.sqlName}: ${c.sqlType}${c.nullable ? " NULL" : " NOT NULL"}`);
        }
        if (mapping.length > 20) console.log(`    ... +${mapping.length - 20} more`);
      } catch { /* ignore */ }
    }
  }

  await prisma.$disconnect();
}

void main().catch(e => { console.error("ERRO:", e.message); process.exit(1); });