/**
 * Benchmark end-to-end do parser (DuckDB fast path + csv-parse fallback)
 * Uso: npx tsx scripts/benchmark-parser.ts
 */
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { previewFile, rowsFromFile } from "../src/server/uploads/parser";

async function countRows(filePath: string): Promise<{ count: number; ms: number }> {
  const preview = await previewFile(filePath);
  const t = Date.now();
  let count = 0;
  for await (const _ of rowsFromFile(filePath, preview.columns)) count++;
  return { count, ms: Date.now() - t };
}

async function main() {
  const tmp = tmpdir();

  // ── Teste 1: UTF-8, separador vírgula, 100K rows ──────────────────────────
  const p1 = join(tmp, "bench_utf8_100k.csv");
  {
    const rows = ["id,nome,valor,data"];
    for (let i = 0; i < 100_000; i++)
      rows.push(`${i},produto_${i},${(i * 1.5).toFixed(2)},2025-${String((i % 12) + 1).padStart(2, "0")}-01`);
    writeFileSync(p1, rows.join("\n"), "utf8");
  }
  {
    const { count, ms } = await countRows(p1);
    console.log(`[UTF-8 100K  ] ${count} rows em ${ms}ms  → ${Math.round(count / ms * 1000).toLocaleString("pt-BR")} rows/s`);
    unlinkSync(p1);
  }

  // ── Teste 2: UTF-8, separador ponto-e-vírgula, decimais BR, 100K rows ─────
  const p2 = join(tmp, "bench_utf8_br.csv");
  {
    const rows = ["nome;valor;codigo"];
    for (let i = 0; i < 100_000; i++)
      rows.push(`produto_${i};1.${String(i % 1000).padStart(3, "0")},50;00${String(i).padStart(5, "0")}`);
    writeFileSync(p2, rows.join("\n"), "utf8");
  }
  {
    const { count, ms } = await countRows(p2);
    console.log(`[UTF-8 BR 100K] ${count} rows em ${ms}ms  → ${Math.round(count / ms * 1000).toLocaleString("pt-BR")} rows/s`);
    unlinkSync(p2);
  }

  // ── Teste 3: UTF-8 500K rows ──────────────────────────────────────────────
  const p3 = join(tmp, "bench_utf8_500k.csv");
  {
    const rows = ["id,nome,valor,categoria"];
    for (let i = 0; i < 500_000; i++)
      rows.push(`${i},item_${i},${(i * 1.5).toFixed(2)},cat_${i % 10}`);
    writeFileSync(p3, rows.join("\n"), "utf8");
  }
  {
    const { count, ms } = await countRows(p3);
    console.log(`[UTF-8 500K  ] ${count} rows em ${ms}ms  → ${Math.round(count / ms * 1000).toLocaleString("pt-BR")} rows/s`);
    unlinkSync(p3);
  }

  // ── Teste 4: win1252 (fallback csv-parse) ─────────────────────────────────
  const p4 = join(tmp, "bench_win1252.csv");
  {
    const rows = ["nome,cidade,descricao"];
    for (let i = 0; i < 5_000; i++)
      rows.push(`João ${i},São Paulo,Descrição com ação e ç ${i}`);
    writeFileSync(p4, iconv.encode(rows.join("\n"), "win1252"));
  }
  {
    const preview = await previewFile(p4);
    const t = Date.now();
    let count = 0;
    let firstRow: Record<string, unknown> | null = null;
    for await (const row of rowsFromFile(p4, preview.columns)) {
      if (!firstRow) firstRow = row;
      count++;
    }
    const ms = Date.now() - t;
    console.log(`[win1252 5K  ] encoding=${preview.encoding} | ${count} rows em ${ms}ms`);
    console.log(`  primeira row: ${JSON.stringify(firstRow)}`);
    unlinkSync(p4);
  }

  // ── Teste 5: UTF-8 com headers duplicados + coluna sem nome ──────────────
  const p5 = join(tmp, "bench_edge.csv");
  {
    writeFileSync(p5, [
      "nome,valor,nome,,valor",
      "Alice,100,Maria,extra,200",
      "Bob,150,Ana,outro,250",
    ].join("\n"), "utf8");
  }
  {
    const preview = await previewFile(p5);
    console.log(`[edge cases  ] cols: ${preview.columns.map(c => `${c.sqlName}(${c.sqlType})`).join(", ")}`);
    const rows: Record<string, unknown>[] = [];
    for await (const row of rowsFromFile(p5, preview.columns)) rows.push(row);
    console.log(`  rows: ${JSON.stringify(rows)}`);
    unlinkSync(p5);
  }

  console.log("\n✓ Todos os benchmarks concluídos");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
