import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { ApiError, handleApiError, ok } from "@/server/http";

async function assertOwner(actorId: string, actorType: string, id: string) {
  if (actorType !== "user") throw new ApiError(403, "FORBIDDEN", "Tokens não gerenciam consultas salvas");
  const query = await prisma.savedQuery.findUniqueOrThrow({ where: { id } });
  if (query.userId !== actorId) throw new ApiError(404, "NOT_FOUND", "Consulta não encontrada");
  return query;
}

export async function PATCH(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const a = await resolveActor(r);
    const id = (await params).id;
    await assertOwner(a.id, a.type, id);
    const i = z.object({ name: z.string().min(2).max(200).optional(), description: z.string().max(1000).optional(), sqlText: z.string().min(1).max(50000).optional() }).parse(await r.json());
    return ok(await prisma.savedQuery.update({ where: { id }, data: i }));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const a = await resolveActor(r);
    const id = (await params).id;
    await assertOwner(a.id, a.type, id);
    await prisma.savedQuery.delete({ where: { id } });
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}
