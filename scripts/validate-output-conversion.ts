import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { previewFile, rowsFromFile } from "../src/server/uploads/parser";
import { normalizeDateLike } from "../src/server/uploads/date-normalize";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: npx tsx scripts/validate-output-conversion.ts <output-dir>");
  process.exit(1);
}

function makeCleanConverter(type: string): (v: unknown) => string {
  if (type === "BIGINT") {
    return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  }
  if (type.startsWith("DECIMAL")) {
    return v => {
      if (v == null || String(v).trim() === "") return "";
      const s = String(v).trim();
      const n = Number(s.includes(",") ? s.replaceAll(".", "").replace(",", ".") : s);
      return Number.isFinite(n) ? n.toFixed(4) : "";
    };
  }
  if (type === "DATE") {
    return v => {
      if (v == null || String(v).trim() === "") return "";
      return normalizeDateLike(String(v))?.slice(0, 10) ?? "";
    };
  }
  if (type === "DATETIME2") {
    return v => {
      if (v == null || String(v).trim() === "") return "";
      const iso = normalizeDateLike(String(v)) ?? String(v).trim();
      return new Date(iso).toISOString().replace("T", " ").replace("Z", "");
    };
  }
  if (type === "TIME") {
    return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  }
  return v => {
    if (v == null || String(v).trim() === "") return '""';
    return `"${String(v).replace(/"/g, '""')}"`;
  };
}

async function validateFile(path: string) {
  const preview = await previewFile(path);
  const converters = preview.columns.map(c => makeCleanConverter(c.sqlType));
  const issues: Array<{ line: number; column: string; type: string; value: string; error: string }> = [];
  let rows = 0;

  for await (const row of rowsFromFile(path, preview.columns, {
    encoding: preview.encoding,
    separator: preview.separator ?? ",",
    ext: extname(path).toLowerCase(),
  })) {
    rows++;
    for (let i = 0; i < preview.columns.length; i++) {
      const col = preview.columns[i]!;
      const value = row[col.sqlName];
      try {
        converters[i]!(value);
      } catch (error) {
        issues.push({
          line: rows + 1,
          column: col.sqlName,
          type: col.sqlType,
          value: String(value).slice(0, 180),
          error: error instanceof Error ? error.message : String(error),
        });
        if (issues.length >= 20) break;
      }
    }
    if (issues.length >= 20) break;
  }

  return {
    file: path,
    rows,
    previewRows: preview.rowCount,
    columns: preview.columns.length,
    issues,
  };
}

async function main() {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter(e => e.isFile() && [".csv", ".xlsx"].includes(extname(e.name).toLowerCase()))
    .map(e => join(dir, e.name))
    .sort((a, b) => a.localeCompare(b));

  console.log(`Validando ${files.length} arquivos em ${dir}`);
  const failed = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const started = Date.now();
    try {
      const result = await validateFile(file);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (result.issues.length) {
        failed.push(result);
        console.log(`FAIL ${i + 1}/${files.length} ${file} rows=${result.rows}/${result.previewRows} cols=${result.columns} ${seconds}s`);
        console.log(JSON.stringify(result.issues, null, 2));
      } else {
        console.log(`OK   ${i + 1}/${files.length} ${file} rows=${result.rows}/${result.previewRows} cols=${result.columns} ${seconds}s`);
      }
    } catch (error) {
      const result = { file, rows: 0, previewRows: 0, columns: 0, issues: [{ line: 0, column: "", type: "", value: "", error: error instanceof Error ? error.message : String(error) }] };
      failed.push(result);
      console.log(`FAIL ${i + 1}/${files.length} ${file}`);
      console.log(JSON.stringify(result.issues, null, 2));
    }
  }

  console.log("SUMMARY");
  console.log(JSON.stringify({ total: files.length, failed: failed.length, failedFiles: failed.map(f => f.file) }, null, 2));
  if (failed.length) process.exit(1);
}

void main();
