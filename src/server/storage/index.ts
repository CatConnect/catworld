import { env } from "@/server/env";
import { existsSync, unlinkSync } from "node:fs";
import { copyFile as fsCopy, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeLocal, downloadLocal } from "./local";
import { writeBlob, downloadBlob, deleteBlob, copyBlob } from "./blob";

function usesBlob() {
  return !!env().CATWORLD_AZURE_BLOB_CONNECTION_STRING;
}

export async function writeFile(blobName: string, body: ReadableStream<Uint8Array>) {
  if (usesBlob()) return writeBlob(blobName, body);
  return writeLocal(blobName, body);
}

export async function downloadFile(blobName: string): Promise<NodeJS.ReadableStream> {
  if (usesBlob()) return downloadBlob(blobName);
  return downloadLocal(blobName) as unknown as NodeJS.ReadableStream;
}

export async function deleteFile(blobName: string) {
  if (usesBlob()) return deleteBlob(blobName);
  try {
    const { resolve } = await import("node:path");
    const { env: getEnv } = await import("@/server/env");
    const path = resolve(getEnv().CATWORLD_UPLOAD_DIR, blobName);
    if (existsSync(path)) unlinkSync(path);
  } catch { /* best-effort */ }
}

export async function uploadTarget(uploadId: string) {
  return { url: `/api/v1/uploads/${uploadId}`, expiresAt: new Date(Date.now() + 15 * 60_000) };
}

export async function copyFile(sourceBlobName: string, destBlobName: string) {
  if (usesBlob()) return copyBlob(sourceBlobName, destBlobName);
  const { resolve } = await import("node:path");
  const { env: getEnv } = await import("@/server/env");
  const srcPath = resolve(getEnv().CATWORLD_UPLOAD_DIR, sourceBlobName);
  const dstPath = resolve(getEnv().CATWORLD_UPLOAD_DIR, destBlobName);
  await mkdir(dirname(dstPath), { recursive: true });
  await fsCopy(srcPath, dstPath);
}
