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

  const ids = [
    "c7c9bcdc-a878-4c09-a76b-cf8ed2b13eff", // Transferencia Estoque.csv - too many params
    "207c55dc-28c3-47e6-99b1-b43c97c54425", // Invalid time value
    "8585d83f-31fb-4930-8454-7501e69d9466", // vendas_completo_pennacorp.csv - retry bug
    "f20cffe1-dad1-47bd-bd9f-a2e71b13642c", // razaoconsolidada.csv - retry bug
    "7e3d5a46-fea7-433a-bf9b-8d09ed109c94", // Cp Rateado.csv - retry bug
  ];

  for (const id of ids) {
    const u = await prisma.upload.findUnique({
      where: { id },
      include: { dataset: true, jobs: true }
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

    // Show all jobs
    for (const j of u.jobs) {
      console.log(`  Job ${j.type}: ${j.status} (attempt ${j.attempts}/${j.maxAttempts})`);
      if (j.lastError) console.log(`    lastError: ${j.lastError.slice(0, 400)}`);
    }

    // Parse preview/mapping
    if (u.previewJson) {
      try {
        const preview = JSON.parse(u.previewJson);
        console.log(`\n  Preview columns: ${preview.columns?.length} total`);
        // Show all column types to find TIME or problematic types
        for (const c of (preview.columns || [])) {
          if (c.sqlType === 'TIME' || c.sqlType === 'BIGINT' || c.sqlType === 'DATE' || c.sqlType === 'DATETIME2') {
            console.log(`    ${c.sqlName}: ${c.sqlType}${c.nullable ? " NULL" : " NOT NULL"}`);
          }
        }
      } catch { /* ignore */ }
    }
  }

  await prisma.$disconnect();
}

void main().catch(e => { console.error("ERRO:", e.message); process.exit(1); });