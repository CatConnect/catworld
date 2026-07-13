import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import { resolveActor } from "@/server/auth/actor";
import { hasAnyWriteGrant } from "@/server/auth/permissions";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { ApiError, handleApiError, ok } from "@/server/http";
import { uploadTarget } from "@/server/storage";

export async function GET(r: NextRequest) {
  try {
    await resolveActor(r);
    return ok(
      await prisma.upload.findMany({
        take: 100,
        orderBy: { createdAt: "desc" },
        include: { dataset: true, table: true },
      }),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    if (!await hasAnyWriteGrant(actor)) throw new ApiError(403, "FORBIDDEN", "Permissao insuficiente");

    const input = z.object({
      filename: z.string().min(1).max(500),
      sizeBytes: z.number().int().positive(),
      fileHash: z.string().length(32).optional(),
      datasetId: z.string().uuid().optional(),
      tableId: z.string().uuid().optional(),
      mode: z.enum(["replace", "append", "upsert"]).default("replace"),
      keyColumn: z.string().optional(),
      previewJson: z.string().optional(),
      mappingJson: z.string().optional(),
      rowCount: z.number().int().nonnegative().optional(),
    }).parse(await r.json());

    if (input.sizeBytes > env().CATWORLD_UPLOAD_MAX_BYTES) {
      throw new ApiError(413, "FILE_TOO_LARGE", "Arquivo excede o limite configurado");
    }
    if (![".csv", ".xlsx", ".xls"].includes(extname(input.filename).toLowerCase())) {
      throw new ApiError(400, "UNSUPPORTED_FORMAT", "Use CSV, XLSX ou XLS");
    }

    const blobName = `uploads/${new Date().toISOString().slice(0, 10)}/${randomUUID()}${extname(input.filename).toLowerCase()}`;
    const upload = await prisma.upload.create({
      data: {
        originalFilename: input.filename,
        blobName,
        sizeBytes: BigInt(input.sizeBytes),
        fileHash: input.fileHash ?? null,
        datasetId: input.datasetId ?? null,
        tableId: input.tableId ?? null,
        mode: input.mode,
        keyColumn: input.keyColumn ?? null,
        previewJson: input.previewJson ?? null,
        mappingJson: input.mappingJson ?? null,
        rowCount: input.rowCount != null ? BigInt(input.rowCount) : null,
      },
    });

    return ok({ upload, sas: await uploadTarget(upload.id) }, undefined, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
