import { sqlPool } from '../src/server/azure/sql';
async function main() {
  const pool = await sqlPool();
  const tables = await pool.request().query(`
    SELECT t.name, t.create_date, SUM(p.rows) row_count
    FROM sys.tables t JOIN sys.schemas s ON t.schema_id=s.schema_id
    JOIN sys.partitions p ON p.object_id=t.object_id AND p.index_id<2
    WHERE s.name LIKE '%poliview%' OR s.name LIKE '%rp%' OR s.name LIKE '%engenharia%'
    GROUP BY t.name, t.create_date
    ORDER BY t.create_date DESC
  `);
  console.log('Tabelas POLIVIEW/RP:', tables.recordset.map((r:{name:string,create_date:Date,row_count:number}) => `${r.name}: ${r.row_count} rows (criada ${r.create_date.toISOString().slice(0,19)})`).join('\n'));
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
