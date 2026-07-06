import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

const CANCELLABLE = [
  "PENDING_UPLOAD",
  "QUEUED_PREVIEW",
  "AWAITING_CONFIRMATION",
  "QUEUED_IMPORT",
  "RETRYING",
];

export async function POST() {
  const result = await prisma.$transaction(async (tx) => {
    const uploads = await tx.upload.updateMany({
      where: { status: { in: CANCELLABLE } },
      data: { status: "FAILED", errorMessage: "Cancelado pelo usuário" },
    });
    const jobs = await tx.job.updateMany({
      where: { status: "QUEUED" },
      data: { status: "FAILED", lastError: "Cancelled" },
    });
    return { cancelled: uploads.count, jobsCancelled: jobs.count };
  });

  return NextResponse.json(result);
}
