import { prisma } from '../src/server/db';
import { sqlPool } from '../src/server/azure/sql';

async function main() {
  const upload = await prisma.upload.findFirst({
    where: { originalFilename: { contains: 'Cp_Rateado' } },
    orderBy: { createdAt: 'desc' },
    select: { id:true, status:true, rowCount:true, originalFilename:true, errorMessage:true, 
              table: { select: { sqlName:true } }, dataset: { select: { schemaName:true, name:true } } }
  });
  console.log('Upload:', upload?.originalFilename, upload?.status, 'rowCount:', upload?.rowCount?.toString(), 'dataset:', upload?.dataset?.name, 'err:', upload?.errorMessage);

  if (upload?.table && upload?.dataset) {
    const pool = await sqlPool();
    const r = await pool.request().query(
      `SELECT COUNT_BIG(*) n FROM [${upload.dataset.schemaName}].[${upload.table.sqlName}]`
    );
    console.log('Rows in DB:', r.recordset[0].n);
  }

  // Contar linhas locais
  const { createReadStream } = await import('node:fs');
  const { parse } = await import('csv-parse');
  const iconv = await import('iconv-lite');
  let rows = 0, header = true;
  const stream = createReadStream('C:/Users/TRABALHO/Downloads/Cp_Rateado_2.csv')
    .pipe(iconv.default.decodeStream('utf8'))
    .pipe(parse({ delimiter: ';', bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true }));
  for await (const _ of stream) { if (header) { header=false; continue; } rows++; }
  console.log('Linhas locais (csv-parse):', rows);

  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
