import { createReadStream } from 'node:fs';
import csvParse from 'csv-parse';

const filePath = 'C:/Users/TRABALHO/AppData/Local/Temp/ifractal_check_9584c13873fa4ce09de2543b89baee2b/output/ifractal_ponto_espelho.csv';

async function main() {
  let rows = 0;
  let headers: string[] = [];
  const parser = createReadStream(filePath).pipe(
    csvParse({ delimiter: ';', columns: true, bom: true, relax_quotes: true, skip_records_with_error: true })
  );
  for await (const row of parser) {
    if (rows === 0) headers = Object.keys(row);
    rows++;
  }
  console.log('Headers:', headers.length, headers.slice(0, 5));
  console.log('Rows csv-parse:', rows);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
