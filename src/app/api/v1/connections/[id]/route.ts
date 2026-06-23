import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { encryptSecret } from "@/server/security/crypto";
import { handleApiError, ok } from "@/server/http";

export async function PATCH(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const a = await resolveActor(r);
    requireRole(a, ["ADMIN"]);
    const i = z.object({
      name: z.string().min(2).optional(),
      environment: z.enum(["Produção", "Homologação", "Desenvolvimento"]).optional(),
      server: z.string().min(3).optional(),
      databaseName: z.string().min(1).optional(),
      username: z.string().min(1).optional(),
      password: z.string().min(1).optional(),
      active: z.boolean().optional(),
    }).parse(await r.json());
    const { password, ...data } = i;
    const updated = await prisma.connection.update({
      where: { id: (await params).id },
      data: { ...data, ...(password ? { encryptedCredentials: encryptSecret(JSON.stringify({ password })) } : {}) },
      select: { id: true, name: true, environment: true, server: true, databaseName: true, username: true, active: true, lastStatus: true, lastLatencyMs: true, lastCheckedAt: true, createdAt: true, updatedAt: true },
    });
    return ok(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const a = await resolveActor(r);
    requireRole(a, ["ADMIN"]);
    return ok(await prisma.connection.update({ where: { id: (await params).id }, data: { active: false }, select: { id: true } }));
  } catch (e) {
    return handleApiError(e);
  }
}
