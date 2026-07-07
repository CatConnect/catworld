import { prisma } from "@/server/db";

async function main() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const uploads = await prisma.upload.findMany({
    where: {
      status: "FAILED",
      createdAt: { gte: today },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      dataset: { include: { project: true } },
      jobs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  for (const u of uploads) {
    const dest = u.dataset ? `${u.dataset.project?.name} → ${u.dataset.name}` : "sem destino";
    const jobErr = u.jobs[0]?.lastError ?? "-";
    console.log(`\n── ${u.originalFilename} [${dest}]`);
    console.log(`   upload error : ${u.errorMessage ?? "-"}`);
    console.log(`   job error    : ${jobErr}`);
    console.log(`   job type     : ${u.jobs[0]?.type ?? "-"} (tentativas: ${u.jobs[0]?.attempts ?? 0})`);
    console.log(`   criado em    : ${u.createdAt.toISOString()}`);
    console.log(`   tamanho      : ${Number(u.sizeBytes)} bytes`);
  }

  console.log(`\nTotal: ${uploads.length} falhas hoje`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
