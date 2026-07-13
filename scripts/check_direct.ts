import { sqlPool } from '../src/server/azure/sql';
async function main() {
  const pool = await sqlPool();
  
  // Conta linhas agora
  const r = await pool.request().query(`SELECT COUNT_BIG(*) n, MAX(data) mx FROM [d_brasilmar_ifractal].[ifractal_ponto_espelho]`);
  console.log('rows now:', r.recordset[0]);

  // Verifica histórico de versões da tabela
  const v = await pool.request().query(`
    SELECT TOP 5 v.row_count, v.created_at, u.original_filename, u.status
    FROM dbo.cw_dataset_versions v
    JOIN dbo.cw_dataset_tables t ON v.table_id=t.id
    LEFT JOIN dbo.cw_uploads u ON v.upload_id=u.id
    WHERE t.sql_name='ifractal_ponto_espelho'
    ORDER BY v.created_at DESC
  `);
  console.log('Versões:', v.recordset);
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
