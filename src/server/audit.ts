import { prisma } from "@/server/db";
import type { Actor } from "@/server/auth/actor";
export async function audit(actor: Actor | null, eventType: string, resourceType?: string, resourceId?: string, detail?: unknown, success = true) {
  await prisma.auditEvent.create({ data: { userId: actor?.type === "user" ? actor.id : null, tokenId: actor?.type === "token" ? actor.id : null, eventType, resourceType, resourceId, detailJson: detail ? JSON.stringify(detail) : null, success } });
}