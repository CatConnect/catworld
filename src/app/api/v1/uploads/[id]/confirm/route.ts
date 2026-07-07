import type { NextRequest } from "next/server";
import { resolveActor } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { confirmUploadSchema, queueImportUpload } from "@/server/uploads/actions";

export async function POST(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    const input = confirmUploadSchema.parse(await r.json());
    return ok(await queueImportUpload(actor, (await params).id, input), undefined, 202);
  } catch (e) {
    return handleApiError(e);
  }
}
