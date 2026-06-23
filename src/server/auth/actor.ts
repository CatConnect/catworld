import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http";
import { hashToken } from "@/server/security/crypto";

export type Actor = { type: "user" | "token"; id: string; role: string; principal: string };

export async function resolveActor(request?: NextRequest): Promise<Actor> {
  const bearer = request?.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    const token = await prisma.apiToken.findUnique({ where: { tokenHash: hashToken(bearer) } });
    if (!token?.active || (token.expiresAt && token.expiresAt <= new Date())) throw new ApiError(401, "INVALID_TOKEN", "Token inválido, expirado ou revogado");
    await prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
    return { type: "token", id: token.id, role: "TOKEN", principal: `cw_t_${token.id.replaceAll("-", "").slice(0, 24)}` };
  }
  const session = await auth();
  if (!session?.user?.id) throw new ApiError(401, "UNAUTHENTICATED", "Autenticação necessária");
  return { type: "user", id: session.user.id, role: session.user.role, principal: `cw_u_${session.user.id.replaceAll("-", "").slice(0, 24)}` };
}

export function requireRole(actor: Actor, roles: string[]) {
  if (!roles.includes(actor.role)) throw new ApiError(403, "FORBIDDEN", "Permissão insuficiente");
}