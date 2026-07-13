import { prisma } from '../src/server/db';
async function main() {
  const jobs = await prisma.$queryRawUnsafe<{type:string,status:string,locked_by:string,upload_id:string,available_at:Date,created_at:Date}[]>(
    `SELECT TOP 10 type, status, locked_by, CAST(upload_id AS VARCHAR(36)) upload_id, available_at, created_at FROM dbo.cw_jobs ORDER BY created_at DESC`
  );
  console.log('Jobs recentes:');
  jobs.forEach(j => console.log(j.type, j.status, j.locked_by, j.upload_id, j.created_at?.toISOString()));
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
