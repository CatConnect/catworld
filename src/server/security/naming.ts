import { createHash } from "node:crypto";

export function slugify(value: string, max = 100): string {
  const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("Nome não produz um identificador válido");
  return shorten(normalized, max);
}

export function sqlIdentifier(value: string, max = 128): string {
  let normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) normalized = "campo";
  if (/^\d/.test(normalized)) normalized = `col_${normalized}`;
  return shorten(normalized, max);
}

export function datasetSchema(projectSlug: string, datasetSlug: string): string {
  return sqlIdentifier(`d_${projectSlug.replaceAll("-", "_")}__${datasetSlug.replaceAll("-", "_")}`, 128);
}

function shorten(value: string, max: number) {
  if (value.length <= max) return value;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${value.slice(0, max - 11)}_${hash}`;
}

export function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(value)) throw new Error(`Identificador SQL inválido: ${value}`);
  return `[${value}]`;
}