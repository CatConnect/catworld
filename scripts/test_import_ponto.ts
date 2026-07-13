import { importUpload } from '../src/server/uploads/importer';
import { prisma } from '../src/server/db';

async function main() {
  const upload = await prisma.upload.findFirst({
    where: { originalFilename: { contains: 'ponto_espelho' } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, createdAt: true }
  });
  console.log('Upload:', upload?.id, upload?.status, upload?.createdAt?.toISOString());

  const filePath = 'C:\Users\TRABALHO\AppData\Local\Temp\ifractal_check_9584c13873fa4ce09de2543b89baee2b\output\ifractal_ponto_espelho.csv';
  console.log('Importando de:', filePath);
  const result = await importUpload(upload!.id, filePath);
  console.log('Result:', JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v));
  process.exit(0);
}
main().catch(e => { console.error(e.message ?? e); process.exit(1); });
