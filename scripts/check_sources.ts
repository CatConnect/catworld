import { prisma } from '../src/server/db';
async function main() {
  const sources = await prisma.datasetSource.findMany({
    where: { dataset: { schemaName: 'd_brasilmar_ifractal' } },
    include: { dataset: { select: { name: true } } },
    orderBy: { lastRunAt: 'desc' },
  });
  for (const s of sources) {
    console.log('Source:', s.id, s.name, 'lastRun:', s.lastRunAt?.toISOString(), 'status:', s.lastRunStatus, 'mode:', s.mode);
    const cfg = JSON.parse(s.configJson ?? '{}');
    console.log('  table:', cfg.tableName ?? cfg.table ?? cfg.query?.slice(0,80));
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
