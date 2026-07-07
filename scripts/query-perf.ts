import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

async function main() {
  const { prisma } = await import("../src/server/db");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events = await (prisma as any).auditEvent.findMany({
    where: { eventType: "UPLOAD_IMPORT_PERF" },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { detailJson: true, createdAt: true },
  });

  for (const e of events) {
    const d = JSON.parse((e as { detailJson: string }).detailJson ?? "{}") as Record<string, unknown>;
    const b = ((d.bulkBlob as Record<string, unknown> | undefined)?.timings ?? {}) as Record<string, number>;
    const rows = Number(d.rows ?? 0);
    const total = Number(d.totalImportMs ?? 0);
    console.log(`\n── ${d.file}`);
    console.log(`   linhas        : ${rows.toLocaleString("pt-BR")}`);
    console.log(`   método        : ${d.importMethod}`);
    console.log(`   total         : ${(total/1000).toFixed(1)}s`);
    if (b.convertUploadCleanBlobMs) console.log(`   parse+upload  : ${(b.convertUploadCleanBlobMs/1000).toFixed(1)}s`);
    if (b.bulkInsertMs) console.log(`   BULK INSERT   : ${(b.bulkInsertMs/1000).toFixed(1)}s  (${Math.round(rows/(b.bulkInsertMs/1000)).toLocaleString()} rows/s)`);
    const rest = total - (b.convertUploadCleanBlobMs ?? 0) - (b.bulkInsertMs ?? 0);
    if (rest > 0) console.log(`   delta+outros  : ${(rest/1000).toFixed(1)}s`);
    // column count from schemaJson in latest cw_dataset_version
    const bulkBlobObj = d.bulkBlob as Record<string, unknown> | undefined;
    const reused = bulkBlobObj?.reusedCleanBlob;
    if (reused !== undefined) console.log(`   reused blob   : ${reused}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).$disconnect();
}

void main().catch(e => { console.error(e); process.exit(1); });
