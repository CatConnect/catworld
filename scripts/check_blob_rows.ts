import { prisma } from '../src/server/db';
import { downloadFile } from '../src/server/storage';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'csv-parse';
import iconv from 'iconv-lite';
import { extname } from 'node:path';

async function main() {
  const upload = await prisma.upload.findFirst({
    where: { originalFilename: { contains: 'ponto_espelho' } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, createdAt: true, blobName: true, originalFilename: true, sizeBytes: true }
  });
  console.log('Upload:', upload?.id, upload?.status, upload?.createdAt?.toISOString(), 'sizeBytes:', upload?.sizeBytes);

  const dir = await mkdtemp(join(tmpdir(), 'check-'));
  try {
    const ext = extname(upload!.originalFilename).toLowerCase();
    const blobPath = `originals/${upload!.id}${ext}`;
    console.log('Baixando:', blobPath);

    let stream: NodeJS.ReadableStream;
    try {
      stream = await downloadFile(blobPath);
    } catch (e) {
      console.log('originals/ não encontrado, tentando blobName:', upload!.blobName);
      stream = await downloadFile(upload!.blobName);
    }

    const localPath = join(dir, 'ponto.csv');
    await pipeline(stream, createWriteStream(localPath));
    const s = await stat(localPath);
    console.log('Arquivo local:', s.size, 'bytes');

    // Conta linhas físicas
    let physLines = 0;
    const rf = createReadStream(localPath);
    const buf = Buffer.alloc(65536);
    let remainder = '';
    for await (const chunk of rf) {
      const text = remainder + (chunk as Buffer).toString('utf8');
      const lines = text.split('\n');
      remainder = lines.pop() ?? '';
      physLines += lines.length;
    }
    if (remainder) physLines++;
    console.log('Linhas físicas no blob:', physLines);

    // Conta com csv-parse
    let csvRows = 0;
    let header = true;
    const csvStream = createReadStream(localPath)
      .pipe(iconv.decodeStream('utf8'))
      .pipe(parse({ delimiter: ';', bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true }));
    for await (const _row of csvStream) {
      if (header) { header = false; continue; }
      csvRows++;
    }
    console.log('Linhas csv-parse no blob:', csvRows);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
