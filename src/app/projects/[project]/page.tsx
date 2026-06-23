import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { ProjectWorkspace } from "@/components/workspace/project-workspace";
import { resolveActor } from "@/server/auth/actor";
import { visibleProjectIds } from "@/server/auth/permissions";
export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ project: string }> }) {
  const actor = await resolveActor(), ids = await visibleProjectIds(actor);
  const p = await prisma.project.findFirst({
    where: { slug: (await params).project, ...(ids ? { id: { in: ids } } : {}) },
    include: { datasets: { where: { active: true }, include: { tables: { include: { columns: { orderBy: { ordinal: "asc" } } } } } } },
  });
  if (!p) notFound();
  const project = {
    id: p.id,
    name: p.name,
    description: p.description,
    active: p.active,
    datasets: p.datasets.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      active: d.active,
      schemaName: d.schemaName,
      tables: d.tables.map((t) => ({
        id: t.id,
        name: t.name,
        sqlName: t.sqlName,
        rowCount: String(t.rowCount),
        columns: t.columns.map((c) => ({ id: c.id, sqlName: c.sqlName, originalName: c.originalName, sqlType: c.sqlType, nullable: c.nullable })),
      })),
    })),
  };
  return <ProjectWorkspace project={project} />;
}
