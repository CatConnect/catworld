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

  const rows = await prisma.upload.findMany({
    where: {
      OR: [
        { errorMessage: { contains: 'OLE DB provider "BULK"' } },
        { errorMessage: { contains: "Bulk load data conversion error" } },
        { jobs: { some: { lastError: { contains: 'OLE DB provider "BULK"' } } } },
        { jobs: { some: { lastError: { contains: "Bulk load data conversion error" } } } }
      ]
    },
    include: { dataset: true, jobs: true },
    orderBy: { updatedAt: "desc" },
    take: 50
  });

  console.log(JSON.stringify(rows.map(u => ({
    id: u.id,
    file: u.originalFilename,
    ext: u.originalFilename.split(".").pop(),
    status: u.status,
    rowCount: String(u.rowCount),
    error: u.errorMessage?.slice(0, 300),
    dataset: u.dataset?.schemaName,
    updatedAt: u.updatedAt,
    jobs: u.jobs.map(j => ({
      type: j.type,
      status: j.status,
      attempts: j.attempts,
      lastError: j.lastError?.slice(0, 500)
    }))
  })), null, 2));

  await prisma.$disconnect();
}

void main().catch(e => { console.error("ERRO:", e.message); process.exit(1); });