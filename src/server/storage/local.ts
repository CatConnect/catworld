import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "@/server/env";

function resolvePath(blobName: string) {
  const base = resolve(env().CATWORLD_UPLOAD_DIR);
  const target = resolve(base, blobName);
  if (target !== base && !target.startsWith(base + "\\") && !target.startsWith(base + "/")) throw new Error("Caminho de upload inválido");
  return target;
}

export async function uploadTarget(uploadId: string) {
  return { url: `/api/v1/uploads/${uploadId}/file`, expiresAt: new Date(Date.now() + 15 * 60_000) };
}

export async function writeLocal(blobName: string, body: ReadableStream<Uint8Array>) {
  const path = resolvePath(blobName);
  await mkdir(dirname(path), { recursive: true });
  await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(path));
}

export function downloadLocal(blobName: string) {
  return createReadStream(resolvePath(blobName));
}
