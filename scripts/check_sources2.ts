import { prisma } from '../src/server/db';
async function main() {
  // Ver todos os jobs recentes com mais detalhes, incluindo payloads
  const jobs = await prisma.$queryRawUnsafe<{type:string,status:string,created_at:Date,updated_at:Date,payload_json:string,last_error:string}[]>(
    `SELECT TOP 20 type, status, created_at, updated_at, payload_json, last_error 
     FROM dbo.cw_jobs 
     ORDER BY updated_at DESC`
  );
  console.log('Jobs por updated_at:');
  jobs.forEach(j => console.log(
    j.type.padEnd(20), j.status.padEnd(12), 
    'created:', j.created_at?.toISOString().slice(11,19),
    'updated:', j.updated_at?.toISOString().slice(11,19),
    j.payload_json ? j.payload_json.slice(0,80) : ''
  ));

  // Fontes configuradas
  const sources = await prisma.datasetSource.findMany({
    select: { id:true, sourceTable:true, sourceSql:true, lastRefreshedAt:true, lastStatus:true, lastRowCount:true, active:true,
              targetTable: { select: { sqlName:true } },
              dataset: { select: { schemaName:true } } },
    where: { active: true }
  });
  console.log('\nFontes ativas:');
  sources.forEach(s => console.log(s.dataset?.schemaName, '→', s.targetTable?.sqlName, '|', s.sourceTable ?? s.sourceSql?.slice(0,50), '| lastRun:', s.lastRefreshedAt?.toISOString()));
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
