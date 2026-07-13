import { sqlPool } from '../src/server/azure/sql';
async function main() {
  const pool = await sqlPool();
  const tables = ['ifractal_ponto_espelho', 'ifractal_extrato_banco_horas'];
  for (const t of tables) {
    const r = await pool.request().query(
      `SELECT COUNT_BIG(*) n, MAX(data) maxData FROM [d_brasilmar_ifractal].[${t}]`
    );
    console.log(t, '→', r.recordset[0]);
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
