import { sqlPool } from '../src/server/azure/sql';
async function main() {
  const pool = await sqlPool();
  
  // Verifica timestamps da tabela
  const r = await pool.request().query(`
    SELECT t.name, t.create_date, t.modify_date, s.row_count,
           (SELECT COUNT_BIG(*) FROM [d_brasilmar_ifractal].[ifractal_ponto_espelho]) actual_rows
    FROM sys.tables t 
    JOIN sys.schemas sc ON t.schema_id=sc.schema_id
    OUTER APPLY (
      SELECT SUM(p.rows) row_count FROM sys.partitions p WHERE p.object_id=t.object_id AND p.index_id<2
    ) s
    WHERE sc.name='d_brasilmar_ifractal' AND t.name='ifractal_ponto_espelho'
  `);
  console.log('Table info:', r.recordset[0]);

  // Verifica se a fonte (source) tem dataset_source configurado para ponto_espelho
  const sources = await pool.request().query(`
    SELECT TOP 5 ds.id, ds.name, dst.sql_name table_name, ds.mode, ds.last_run_at, ds.last_run_status
    FROM dbo.cw_dataset_sources ds
    JOIN dbo.cw_datasets d ON ds.dataset_id=d.id
    JOIN dbo.cw_schemas sc ON d.schema_name=sc.schema_name  
    LEFT JOIN dbo.cw_dataset_tables dst ON dst.dataset_id=d.id AND dst.sql_name LIKE '%ponto%'
    WHERE sc.schema_name='d_brasilmar_ifractal'
    ORDER BY ds.last_run_at DESC
  `);
  console.log('Sources:', sources.recordset);

  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
