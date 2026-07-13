import { DuckDBInstance } from '@duckdb/node-api';

const filePath = 'C:/Users/TRABALHO/AppData/Local/Temp/ifractal_check_9584c13873fa4ce09de2543b89baee2b/output/ifractal_ponto_espelho.csv';

async function main() {
  const instance = await DuckDBInstance.create(':memory:', { threads: '2' });
  const conn = await instance.connect();

  // Conta total de linhas físicas
  const countAll = await conn.runAndReadAll(
    `SELECT COUNT(*) cnt FROM read_csv('${filePath}', header=false)`
  );
  console.log('Linhas físicas (header=false):', countAll.getRows()[0][0]);

  // Lê com as mesmas opções do parser
  const countRows = await conn.runAndReadAll(
    `SELECT COUNT(*) cnt FROM read_csv_auto('${filePath}', sample_size=-1, null_padding=true, all_varchar=true)`
  );
  console.log('Linhas DuckDB (null_padding=true):', countRows.getRows()[0][0]);

  // Sem null_padding
  try {
    const countNoPad = await conn.runAndReadAll(
      `SELECT COUNT(*) cnt FROM read_csv_auto('${filePath}', sample_size=-1, all_varchar=true)`
    );
    console.log('Linhas DuckDB (sem null_padding):', countNoPad.getRows()[0][0]);
  } catch (e) {
    console.log('DuckDB sem null_padding falhou:', (e as Error).message?.slice(0, 100));
  }

  // Com allow_quoted_nulls=false para ver se muda
  try {
    const countQ = await conn.runAndReadAll(
      `SELECT COUNT(*) cnt FROM read_csv_auto('${filePath}', sample_size=-1, null_padding=true, all_varchar=true, quote='"')`
    );
    console.log('Linhas DuckDB (quote explícito):', countQ.getRows()[0][0]);
  } catch (e) {
    console.log('DuckDB com quote explícito falhou:', (e as Error).message?.slice(0, 100));
  }

  conn.closeSync();
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
