import { DuckDBInstance } from '@duckdb/node-api';

const filePath = 'C:/Users/TRABALHO/AppData/Local/Temp/ifractal_check_9584c13873fa4ce09de2543b89baee2b/output/ifractal_ponto_espelho.csv';

async function main() {
  const instance = await DuckDBInstance.create(':memory:', { threads: '2' });
  const conn = await instance.connect();

  // Simula exatamente o que parser-duckdb.ts faz:
  // 1) header scan com LIMIT 0
  const headerResult = await conn.runAndReadAll(
    `SELECT * FROM read_csv_auto('${filePath}', sample_size=-1, null_padding=true, all_varchar=true) LIMIT 0`
  );
  console.log('Headers OK, colunas:', headerResult.columnCount);

  // 2) stream de dados
  let emitted = 0;
  try {
    const reader = await conn.stream(
      `SELECT * FROM read_csv_auto('${filePath}', sample_size=-1, null_padding=true, all_varchar=true)`
    );
    for await (const chunk of reader) {
      const rows = chunk.getRows() as unknown[][];
      emitted += rows.length;
    }
    console.log('DuckDB stream OK, linhas emitidas:', emitted);
  } catch (e) {
    console.log('DuckDB stream falhou após', emitted, 'linhas:', (e as Error).message?.slice(0, 150));
  }

  // 3) Conta csv-parse
  const { createReadStream } = await import('node:fs');
  const { parse } = await import('csv-parse');
  const iconv = await import('iconv-lite');
  let csvRows = 0;
  let header = true;
  const stream = createReadStream(filePath)
    .pipe(iconv.default.decodeStream('utf8'))
    .pipe(parse({ delimiter: ';', bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true }));
  for await (const _row of stream) {
    if (header) { header = false; continue; }
    csvRows++;
  }
  console.log('csv-parse linhas:', csvRows);
  console.log('Total se DuckDB+csv-parse:', emitted + csvRows);

  conn.closeSync();
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
