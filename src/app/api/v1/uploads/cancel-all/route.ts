import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

const CANCELLABLE_UPLOAD_STATUSES = [
  "PENDING_UPLOAD",
  "QUEUED_PREVIEW",
  "PREVIEWING",
  "AWAITING_CONFIRMATION",
  "QUEUED_IMPORT",
  "IMPORTING",
  "RETRYING",
];

export async function POST() {
  const result = await prisma.$transaction(async (tx) => {
    // Cancel uploads in any non-terminal state
    const uploads = await tx.upload.updateMany({
      where: { status: { in: CANCELLABLE_UPLOAD_STATUSES } },
      data: { status: "FAILED", errorMessage: "Cancelado pelo usuário" },
    });

    // Cancel all pending/queued jobs — running jobs will detect FAILED status via guard in worker
    const jobs = await tx.job.updateMany({
      where: { status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "FAILED", lastError: "Cancelled" },
    });

    return { cancelled: uploads.count, jobsCancelled: jobs.count };
  });

  return NextResponse.json(result);
}
