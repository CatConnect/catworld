import { Suspense } from "react";
import { FileX2 } from "lucide-react";
import { prisma } from "@/server/db";
import { PageHeader, Panel, EmptyState } from "@/components/ui/primitives";
import { CancelQueueButton } from "@/components/dashboard/cancel-queue";
import { UploadFilters } from "@/components/uploads/upload-filters";
import { UploadCard } from "@/components/uploads/upload-card";
import { UploadPagination } from "@/components/uploads/upload-pagination";
import { UploadPoller } from "@/components/uploads/upload-poller";
import { UploadFunnel, countFunnelGroups } from "@/components/uploads/upload-funnel";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const CANCELLABLE = ["PENDING_UPLOAD", "QUEUED_PREVIEW", "AWAITING_CONFIRMATION", "QUEUED_IMPORT", "RETRYING"];

const GROUP_STATUSES: Record<string, string[]> = {
  pending:   ["PENDING_UPLOAD", "QUEUED_PREVIEW", "AWAITING_CONFIRMATION"],
  active:    ["PREVIEWING", "QUEUED_IMPORT", "IMPORTING", "RETRYING"],
  completed: ["COMPLETED"],
  failed:    ["FAILED"],
};

function parseComma(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export default async function UploadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  const selectedStatuses  = parseComma(params.status);
  const selectedProjectIds = parseComma(params.projectId);
  const page  = Math.max(1, parseInt(params.page ?? "1", 10));
  const skip  = (page - 1) * PAGE_SIZE;

  // Expand selected status groups into DB status values
  const dbStatuses = selectedStatuses.flatMap((g) => GROUP_STATUSES[g] ?? []);

  const where = {
    ...(dbStatuses.length  ? { status:   { in: dbStatuses } } : {}),
    ...(selectedProjectIds.length ? { dataset: { projectId: { in: selectedProjectIds } } } : {}),
  };

  const [uploads, total, projects, queued, funnelRaw, allStatusCounts] = await Promise.all([
    prisma.upload.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip,
      include: { dataset: { include: { project: true } }, jobs: { orderBy: { createdAt: "desc" }, take: 1, select: { lockedBy: true, status: true, weight: true, attempts: true, maxAttempts: true } } },
    }),
    prisma.upload.count({ where }),
    prisma.project.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.upload.count({ where: { status: { in: CANCELLABLE } } }),
    prisma.upload.groupBy({ by: ["status"], where, _count: true }),
    // Unfiltered counts — for badge numbers on each status chip
    prisma.upload.groupBy({ by: ["status"], _count: true }),
  ]);

  const funnelCounts = countFunnelGroups(
    funnelRaw.flatMap((r) => Array(r._count).fill(r.status) as string[]),
  );

  // Count per group key from unfiltered totals
  const statusCountMap = Object.fromEntries(allStatusCounts.map((r) => [r.status, r._count]));
  const groupCounts = {
    pending:   (GROUP_STATUSES.pending!).reduce((n, s) => n + (statusCountMap[s] ?? 0), 0),
    active:    (GROUP_STATUSES.active!).reduce((n, s) => n + (statusCountMap[s] ?? 0), 0),
    completed: statusCountMap["COMPLETED"] ?? 0,
    failed:    statusCountMap["FAILED"] ?? 0,
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Gestão de dados"
        title="Uploads"
        description="Acompanhe e gerencie todos os jobs de importação da plataforma."
        actions={<CancelQueueButton queued={queued} />}
      />

      <UploadPoller statuses={uploads.map((u) => u.status)} />
      <UploadFunnel counts={funnelCounts} />
      <Panel>
        <div className="flex flex-col gap-4 border-b border-base-300 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Suspense fallback={<div className="flex gap-2"><div className="skeleton h-8 w-32 rounded-lg" /><div className="skeleton h-8 w-36 rounded-lg" /></div>}>
            <UploadFilters
              projects={projects}
              selectedStatuses={selectedStatuses}
              selectedProjectIds={selectedProjectIds}
              groupCounts={groupCounts}
            />
          </Suspense>
          <p className="shrink-0 text-xs text-base-content/50">
            {total} upload{total !== 1 ? "s" : ""}
          </p>
        </div>

        {uploads.length === 0 ? (
          <EmptyState
            icon={<FileX2 size={32} />}
            title="Nenhum upload encontrado"
            description="Tente outros filtros ou faça seu primeiro upload pelo SDK."
          />
        ) : (
          <div className="divide-y divide-base-300">
            {uploads.map((u) => (
              <UploadCard key={u.id} upload={u} />
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="border-t border-base-300 px-5 py-4">
            <Suspense>
              <UploadPagination page={page} totalPages={totalPages} />
            </Suspense>
          </div>
        )}
      </Panel>
    </div>
  );
}
