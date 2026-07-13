import { sqlPool } from '../src/server/azure/sql';

async function main() {
  const pool = await sqlPool();
  const r = await pool.request().query(`
    SELECT COUNT_BIG(*) n, MAX(data) maxData, MIN(data) minData 
    FROM [d_brasilmar_ifractal].[ifractal_ponto_espelho]
  `);
  console.log('Resultado:', r.recordset[0]);
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
