import { sqlPool } from '../src/server/azure/sql';
import { prisma } from '../src/server/db';

async function main() {
  const upload = await prisma.upload.findFirst({
    where: { originalFilename: { contains: 'ponto_espelho' } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, rowCount: true, errorMessage: true,
              table: { select: { sqlName: true } }, dataset: { select: { schemaName: true } } }
  });
  console.log('Upload:', upload?.id, 'status:', upload?.status, 'rowCount:', upload?.rowCount?.toString(), 'err:', upload?.errorMessage);

  const pool = await sqlPool();
  const schema = upload!.dataset!.schemaName;
  const table = upload!.table!.sqlName;

  // Lista tabelas no schema
  const tables = await pool.request().query(`
    SELECT t.name, t.create_date, t.modify_date
    FROM sys.tables t JOIN sys.schemas s ON t.schema_id=s.schema_id
    WHERE s.name='${schema}' AND t.name LIKE '%ponto%'
    ORDER BY t.create_date DESC
  `);
  console.log('Tabelas ponto:', tables.recordset);

  for (const t of tables.recordset) {
    const r = await pool.request().query(`
      SELECT COUNT_BIG(*) n FROM [${schema}].[${t.name}]
    `);
    console.log(`[${t.name}]: ${r.recordset[0].n} linhas`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
