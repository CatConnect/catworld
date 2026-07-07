import type { NextRequest } from "next/server";
import { createGunzip } from "node:zlib";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { hasAnyWriteGrant } from "@/server/auth/permissions";
import { writeFile, copyFile } from "@/server/storage";
import { ApiError, handleApiError, ok } from "@/server/http";
import { confirmUploadSchema, queueImportUpload, queuePreviewUpload } from "@/server/uploads/actions";

export async function GET(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await resolveActor(r);
    return ok(await prisma.upload.findUniqueOrThrow({ where: { id: (await params).id }, include: { dataset: true, table: true, jobs: true } }));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PUT(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    if (!await hasAnyWriteGrant(actor)) throw new ApiError(403, "FORBIDDEN", "Permissão insuficiente");
    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: (await params).id } });
    if (!r.body) throw new ApiError(400, "EMPTY_BODY", "Corpo da requisição vazio");

    let body: ReadableStream<Uint8Array> = r.body;
    if (r.headers.get("content-encoding") === "gzip") {
      const gunzip = createGunzip();
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]).pipe(gunzip);
      body = Readable.toWeb(gunzip) as ReadableStream<Uint8Array>;
    }

    await writeFile(upload.blobName, body);
    // Immediately copy to originals/ so the blob survives any lifecycle policy on uploads/ prefix
    const ext = extname(upload.originalFilename).toLowerCase();
    await copyFile(upload.blobName, `originals/${upload.id}${ext}`).catch((e) => {
      console.error("[PUT upload] originals/ copy failed for", upload.id, e instanceof Error ? e.message : e);
    });
    return ok({ stored: true });
  } catch (e) {
    return handleApiError(e);
  }
}
export async function POST(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    const id = (await params).id;
    const action = r.nextUrl.searchParams.get("action");

    if (action === "uploaded") {
      return ok(await queuePreviewUpload(id), undefined, 202);
    }

    if (action === "confirm") {
      const input = confirmUploadSchema.parse(await r.json());
      return ok(await queueImportUpload(actor, id, input), undefined, 202);
    }

    throw new ApiError(400, "INVALID_ACTION", "A??o de upload inv?lida");
  } catch (e) {
    return handleApiError(e);
  }
}
