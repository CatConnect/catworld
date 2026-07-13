import { prisma } from '../src/server/db';
import { sqlPool } from '../src/server/azure/sql';
async function main() {
  const upload = await prisma.upload.findFirst({
    where: { id: 'dabfaa28-a445-4379-8344-6a23022c5669' },
    select: { id:true, status:true, rowCount:true, originalFilename:true, errorMessage:true, sizeBytes:true }
  });
  console.log('Upload DABFAA28:', upload?.originalFilename, upload?.status, 'rowCount:', upload?.rowCount?.toString(), 'size:', upload?.sizeBytes?.toString(), 'err:', upload?.errorMessage);

  const pool = await sqlPool();
  const r = await pool.request().query(`
    SELECT COUNT_BIG(*) n, MAX(data) maxData FROM [d_brasilmar_ifractal].[ifractal_ponto_espelho]
  `);
  console.log('Table now:', r.recordset[0]);
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
