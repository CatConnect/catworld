import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { deleteTable } from "@/server/data/catalog";
import { ApiError, handleApiError, ok } from "@/server/http";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const id = (await params).id;
    const table = await prisma.datasetTable.findUniqueOrThrow({ where: { id } });
    const { confirmName } = z.object({ confirmName: z.string() }).parse(await request.json());
    if (confirmName !== table.name) throw new ApiError(400, "CONFIRMATION_MISMATCH", "Nome de confirmação não confere");
    await deleteTable(id);
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}
