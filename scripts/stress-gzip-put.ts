/**
 * Stress test: simula o PUT handler recebendo um body gzip e gravando no blob.
 * Testa o chain ANTIGO (fromWeb→pipe→gunzip→toWeb) vs NOVO (pipeline→disco).
 *
 * Reproduz o bug onde arquivos > ~8MB descomprimidos eram truncados ao usar
 * o chain de conversão Web RS ↔ Node.js stream sem backpressure adequada.
 */
import { createGunzip, createGzip } from "node:zlib";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile as fsWriteFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, pipeline as streamPipeline } from "node:stream";
import { promisify } from "node:util";

const pipeline = promisify(streamPipeline);

// Gera CSV com dados mais variados (ratio de compressão ~6-8x, similar a dados reais)
function generateCsv(targetBytes: number): Buffer {
  const header = "matricula;nome;data;hora_entrada;hora_saida;horas_trabalhadas;situacao\n";
  const rows: string[] = [header];
  let total = header.length;
  let i = 0;
  while (total < targetBytes) {
    const mat  = (10000 + (i % 50000)).toString();
    const nome = `FUNC${String(i % 999).padStart(3,'0')} ${['SILVA','SOUZA','OLIVEIRA','SANTOS','PEREIRA'][i%5]}`;
    const day  = String(1 + (i % 28)).padStart(2,'0');
    const mon  = String(1 + (i % 12)).padStart(2,'0');
    const row  = `${mat};${nome};2026-${mon}-${day};08:${String(i%60).padStart(2,'0')};17:${String(i%60).padStart(2,'0')};8.5;PRESENTE\n`;
    rows.push(row);
    total += row.length;
    i++;
  }
  return Buffer.from(rows.join(''));
}

// Comprime buffer para gzip, simulando o Python SDK (level=1, chunks de 1MB)
async function compressGzip(buf: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((res, rej) => {
    const chunks: Buffer[] = [];
    const gz = createGzip({ level: 1 });
    gz.on('data', c => chunks.push(c));
    gz.on('end', () => res(Buffer.concat(chunks)));
    gz.on('error', rej);
    let offset = 0;
    const CHUNK = 1024 * 1024;
    const write = () => {
      while (offset < buf.length) {
        const slice = buf.subarray(offset, offset + CHUNK);
        offset += CHUNK;
        if (!gz.write(slice)) { gz.once('drain', write); return; }
      }
      gz.end();
    };
    write();
  });
}

// Cria Web ReadableStream que entrega buf em chunks de chunkSize bytes
function chunkedWebRS(buf: Buffer, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (offset >= buf.length) { ctrl.close(); return; }
      await new Promise(r => setTimeout(r, 0)); // yield para event loop
      const end = Math.min(offset + chunkSize, buf.length);
      ctrl.enqueue(new Uint8Array(buf.subarray(offset, end)));
      offset = end;
    }
  });
}

// Chain ANTIGO: Web RS → fromWeb → pipe(gunzip) → toWeb → fromWeb → writeStream
async function oldChain(gzBuf: Buffer, outPath: string, chunkSize: number): Promise<number> {
  const webRS  = chunkedWebRS(gzBuf, chunkSize);
  const gunzip = createGunzip();
  Readable.fromWeb(webRS as Parameters<typeof Readable.fromWeb>[0]).pipe(gunzip);
  const bodyRS = Readable.toWeb(gunzip) as ReadableStream<Uint8Array>;
  const nodeRS = Readable.fromWeb(bodyRS as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(nodeRS, createWriteStream(outPath));
  return (await stat(outPath)).size;
}

// Chain ANTIGO com backpressure: lê em blocos de 8MB com pausa entre blocos (simula Azure uploadStream)
async function oldChainBackpressure(gzBuf: Buffer, outPath: string, chunkSize: number): Promise<number> {
  const BLOCK = 8 * 1024 * 1024;
  const webRS  = chunkedWebRS(gzBuf, chunkSize);
  const gunzip = createGunzip();
  Readable.fromWeb(webRS as Parameters<typeof Readable.fromWeb>[0]).pipe(gunzip);
  const bodyRS = Readable.toWeb(gunzip) as ReadableStream<Uint8Array>;
  const reader = bodyRS.getReader();
  const ws     = createWriteStream(outPath);

  let accumulated = Buffer.alloc(0);
  let done = false;
  while (!done) {
    // Lê até ter 8MB ou fim do stream
    while (accumulated.length < BLOCK && !done) {
      const { value, done: d } = await reader.read();
      if (d) { done = true; break; }
      accumulated = Buffer.concat([accumulated, value!]);
    }
    if (accumulated.length > 0) {
      const block = accumulated.subarray(0, BLOCK);
      accumulated = accumulated.subarray(BLOCK);
      // Simula latência de upload Azure (20ms entre blocos)
      await new Promise(r => setTimeout(r, 20));
      await new Promise<void>((res, rej) => ws.write(block, e => e ? rej(e) : res()));
    }
  }
  ws.end();
  await new Promise<void>((res, rej) => ws.on('finish', res).on('error', rej));
  return (await stat(outPath)).size;
}

// Chain NOVO: fromWeb → pipeline(gunzip) → disco → readStream → writeStream
async function newChain(gzBuf: Buffer, outPath: string, tmpDir: string, chunkSize: number): Promise<number> {
  const webRS   = chunkedWebRS(gzBuf, chunkSize);
  const tmpPath = join(tmpDir, "decomp.tmp");
  await pipeline(
    Readable.fromWeb(webRS as Parameters<typeof Readable.fromWeb>[0]),
    createGunzip(),
    createWriteStream(tmpPath),
  );
  await pipeline(createReadStream(tmpPath), createWriteStream(outPath));
  return (await stat(outPath)).size;
}

async function runTest(label: string, csvBuf: Buffer, gzBuf: Buffer, chunkKB: number) {
  const chunkSize = chunkKB * 1024;
  const expected  = csvBuf.length;
  const dir = await mkdtemp(join(tmpdir(), "stress-"));
  try {
    const oldSize   = await oldChain(gzBuf, join(dir, "old.csv"), chunkSize);
    const oldBpSize = await oldChainBackpressure(gzBuf, join(dir, "oldbp.csv"), chunkSize);
    const newSize   = await newChain(gzBuf, join(dir, "new.csv"), dir, chunkSize);

    const fmt = (actual: number) => {
      if (actual === expected) return '✓         ';
      const diff = ((expected - actual) / 1024).toFixed(0);
      const pct  = ((expected - actual) / expected * 100).toFixed(2);
      return `✗ -${diff}KB (${pct}%)`.padEnd(18);
    };
    const ratio = (csvBuf.length / gzBuf.length).toFixed(1);
    console.log(
      `${label.padEnd(25)} csv=${(csvBuf.length/1024/1024).toFixed(1).padStart(5)}MB` +
      ` gz=${(gzBuf.length/1024).toFixed(0).padStart(5)}KB ratio=${ratio}x chunks=${chunkKB}KB` +
      ` | old=${fmt(oldSize)}old+bp=${fmt(oldBpSize)}new=${fmt(newSize)}`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  console.log("Stress test: gzip PUT handler — old chain vs new chain");
  console.log("Simula Python SDK (level=1, chunks de 1MB) enviando para PUT /api/v1/uploads/[id]");
  console.log("=".repeat(120));

  // 1. Arquivos sintéticos em vários tamanhos — dados variados para ratio ~6-8x
  const syntheticSizes = [2, 4, 6, 8, 9, 10, 12, 15, 20];
  for (const mb of syntheticSizes) {
    const csvBuf = generateCsv(mb * 1024 * 1024);
    const gzBuf  = await compressGzip(csvBuf);
    // Chunk HTTP = tamanho médio dos chunks gzip do SDK (gz.length / nChunks)
    const nChunks = Math.ceil(csvBuf.length / (1024 * 1024));
    const chunkKB = Math.max(8, Math.ceil(gzBuf.length / nChunks / 1024));
    await runTest(`synthetic-${mb}MB`, csvBuf, gzBuf, chunkKB);
  }

  console.log("=".repeat(120));

  // 2. Arquivos REAIS do IFRACTAL (se disponíveis)
  const realFiles = [
    {
      path: String.raw`C:\Users\TRABALHO\AppData\Local\Temp\ifractal_check_9584c13873fa4ce09de2543b89baee2b\output\ifractal_extrato_banco_horas.csv`,
      label: 'extrato_banco_horas',
    },
    {
      path: String.raw`C:\Users\TRABALHO\AppData\Local\Temp\ifractal_check_9584c13873fa4ce09de2543b89baee2b\output\ifractal_ponto_espelho.csv`,
      label: 'ponto_espelho',
    },
  ];

  for (const { path, label } of realFiles) {
    let csvBuf: Buffer;
    try {
      csvBuf = await readFile(path);
    } catch {
      console.log(`${label}: arquivo não encontrado, pulando`);
      continue;
    }
    const gzBuf  = await compressGzip(csvBuf);
    const nChunks = Math.ceil(csvBuf.length / (1024 * 1024));
    const chunkKB = Math.max(8, Math.ceil(gzBuf.length / nChunks / 1024));
    // Testa com chunk do SDK e também com chunks menores/maiores
    for (const ck of [chunkKB, Math.floor(chunkKB/2), chunkKB*2]) {
      await runTest(label, csvBuf, gzBuf, ck);
    }
  }

  console.log("=".repeat(120));
  console.log("old    = chain antigo (Readable.fromWeb→pipe→gunzip→toWeb) sem pausa");
  console.log("old+bp = chain antigo com pausa de 20ms entre blocos de 8MB (simula Azure uploadStream)");
  console.log("new    = chain novo: pipeline()→disco (fix atual)");
}

void main().catch(e => { console.error(e); process.exit(1); });
