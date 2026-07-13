import { sqlPool } from '../src/server/azure/sql';
import { prisma } from '../src/server/db';

async function main() {
  const upload = await prisma.upload.findFirst({
    where: { originalFilename: { contains: 'ponto_espelho' } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, table: { select: { sqlName: true } }, dataset: { select: { schemaName: true } } }
  });
  console.log('Upload:', upload?.id, upload?.status, 'table:', upload?.table?.sqlName, 'schema:', upload?.dataset?.schemaName);

  const pool = await sqlPool();
  const schema = upload!.dataset!.schemaName;
  const table = upload!.table!.sqlName;

  const r = await pool.request().query(`
    SELECT COUNT_BIG(*) n, MAX(data) maxData, MIN(data) minData FROM [${schema}].[${table}]
  `);
  console.log('Rows in DB:', r.recordset[0]);

  // Verifica o log de perf do import via jobs
  const jobs = await prisma.job.findMany({
    where: { uploadId: upload!.id },
    orderBy: { createdAt: 'desc' },
    select: { type: true, status: true, log: true, createdAt: true }
  });
  for (const j of jobs) {
    console.log('\nJob:', j.type, j.status, j.createdAt?.toISOString());
    if (j.log) console.log('Log:', j.log.slice(-500));
  }

  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
