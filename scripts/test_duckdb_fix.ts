import { rowsFromCsvDuckDB } from '../src/server/uploads/parser-duckdb';

const filePath = 'C:/Users/TRABALHO/AppData/Local/Temp/ifractal_check_9584c13873fa4ce09de2543b89baee2b/output/ifractal_ponto_espelho.csv';

async function main() {
  // Colunas mínimas para teste
  const columns = [{ originalName: 'matricula', sqlName: 'matricula', sqlType: 'NVARCHAR(MAX)', nullable: true },
                   { originalName: 'data', sqlName: 'data', sqlType: 'DATE', nullable: true }];
  let count = 0;
  let maxData = '';
  for await (const row of rowsFromCsvDuckDB(filePath, columns)) {
    count++;
    if (String(row.data) > maxData) maxData = String(row.data);
  }
  console.log('DuckDB linhas:', count, '(esperado: 35918)');
  console.log('MAX(data):', maxData, '(esperado: 2026-07-13)');
  console.log(count === 35918 ? '✓ CORRETO' : '✗ ERRADO');
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
