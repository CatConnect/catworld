import { Suspense } from "react";
import { FileX2 } from "lucide-react";
import { prisma } from "@/server/db";
import { PageHeader, Panel, EmptyState } from "@/components/ui/primitives";
import { CancelQueueButton } from "@/components/dashboard/cancel-queue";
import { UploadFilters } from "@/components/uploads/upload-filters";
import { UploadCard } from "@/components/uploads/upload-card";
import { UploadPagination } from "@/components/uploads/upload-pagination";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const CANCELLABLE = ["PENDING_UPLOAD", "QUEUED_PREVIEW", "AWAITING_CONFIRMATION", "QUEUED_IMPORT", "RETRYING"];

const STATUS_LABELS: Record<string, string> = {
  PENDING_UPLOAD: "Aguardando upload",
  QUEUED_PREVIEW: "Na fila de análise",
  AWAITING_CONFIRMATION: "Aguardando confirmação",
  QUEUED_IMPORT: "Na fila de importação",
  RETRYING: "Tentando novamente",
  COMPLETED: "Concluído",
  FAILED: "Falhou",
};

export default async function UploadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const status = params.status ?? "";
  const datasetId = params.datasetId ?? "";
  const page = Math.max(1, parseInt(params.page ?? "1", 10));
  const skip = (page - 1) * PAGE_SIZE;

  const where = {
    ...(status ? { status } : {}),
    ...(datasetId ? { datasetId } : {}),
  };

  const [uploads, total, datasets, queued] = await Promise.all([
    prisma.upload.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip,
      include: { dataset: { include: { project: true } } },
    }),
    prisma.upload.count({ where }),
    prisma.dataset.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.upload.count({ where: { status: { in: CANCELLABLE } } }),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Gestão de dados"
        title="Uploads"
        description="Acompanhe e gerencie todos os jobs de importação da plataforma."
        actions={<CancelQueueButton queued={queued} />}
      />

      <Panel>
        <div className="flex flex-col gap-4 border-b border-base-300 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Suspense fallback={<div className="flex gap-2"><div className="skeleton h-8 w-32 rounded-lg" /><div className="skeleton h-8 w-36 rounded-lg" /></div>}>
            <UploadFilters
              datasets={datasets}
              currentStatus={status}
              currentDatasetId={datasetId}
              statusLabels={STATUS_LABELS}
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
