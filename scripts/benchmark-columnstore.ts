/**
 * Benchmark: Rowstore vs Columnstore Index em Azure SQL
 *
 * Cria duas tabelas temporárias com os mesmos 500K rows sintéticos,
 * mede SUM/GROUP BY/COUNT/filtro de range em cada uma e imprime o resultado.
 *
 * Uso: npx tsx scripts/benchmark-columnstore.ts
 */
import { sqlPool } from "@/server/azure/sql";
import { env } from "@/server/env";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env") });

const ROWS = 500_000;
const SCHEMA = "dbo";
const RS_TABLE = "_cw_bench_rowstore";
const CS_TABLE = "_cw_bench_columnstore";

async function run() {
  const pool = await sqlPool();

  console.log(`\n=== Benchmark Columnstore — ${ROWS.toLocaleString()} rows ===\n`);

  // ── Criar tabelas de teste ──────────────────────────────────────────────────
  await pool.request().query(`
    IF OBJECT_ID(N'${SCHEMA}.${RS_TABLE}', N'U') IS NOT NULL DROP TABLE [${SCHEMA}].[${RS_TABLE}];
    IF OBJECT_ID(N'${SCHEMA}.${CS_TABLE}', N'U') IS NOT NULL DROP TABLE [${SCHEMA}].[${CS_TABLE}];

    CREATE TABLE [${SCHEMA}].[${RS_TABLE}] (
      id          BIGINT NOT NULL,
      categoria   NVARCHAR(50) NOT NULL,
      valor       DECIMAL(18,4) NOT NULL,
      data_ref    DATE NOT NULL,
      descricao   NVARCHAR(200) NOT NULL
    );

    CREATE TABLE [${SCHEMA}].[${CS_TABLE}] (
      id          BIGINT NOT NULL,
      categoria   NVARCHAR(50) NOT NULL,
      valor       DECIMAL(18,4) NOT NULL,
      data_ref    DATE NOT NULL,
      descricao   NVARCHAR(200) NOT NULL
    );
  `);
  console.log("Tabelas criadas.");

  // ── Inserir dados sintéticos ────────────────────────────────────────────────
  // Inserir em lotes via CTE recursivo para evitar timeout
  const BATCH = 10_000;
  const batches = Math.ceil(ROWS / BATCH);

  process.stdout.write("Inserindo dados rowstore");
  for (let b = 0; b < batches; b++) {
    const offset = b * BATCH;
    await pool.request().query(`
      INSERT INTO [${SCHEMA}].[${RS_TABLE}] (id, categoria, valor, data_ref, descricao)
      SELECT
        n + ${offset},
        CHOOSE((n % 5) + 1, N'Vendas', N'Marketing', N'TI', N'RH', N'Financeiro'),
        CAST(((n * 7919) % 100000) AS DECIMAL(18,4)) / 100.0,
        DATEADD(DAY, n % 730, '2023-01-01'),
        N'Descrição do item ' + CAST(n + ${offset} AS NVARCHAR(20))
      FROM (
        SELECT TOP(${Math.min(BATCH, ROWS - offset)}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS n
        FROM sys.all_columns a CROSS JOIN sys.all_columns b
      ) nums
    `);
    if (b % 10 === 9) process.stdout.write(".");
  }

  process.stdout.write("\nInserindo dados columnstore");
  for (let b = 0; b < batches; b++) {
    const offset = b * BATCH;
    await pool.request().query(`
      INSERT INTO [${SCHEMA}].[${CS_TABLE}] (id, categoria, valor, data_ref, descricao)
      SELECT id, categoria, valor, data_ref, descricao FROM [${SCHEMA}].[${RS_TABLE}]
      WHERE id BETWEEN ${offset} AND ${offset + BATCH - 1}
    `);
    if (b % 10 === 9) process.stdout.write(".");
  }
  console.log("\nDados inseridos.\n");

  // ── Criar índices ──────────────────────────────────────────────────────────
  await pool.request().query(`
    CREATE CLUSTERED COLUMNSTORE INDEX [CCI_bench] ON [${SCHEMA}].[${CS_TABLE}];
  `);
  console.log("Columnstore index criado.\n");

  // ── Benchmark ──────────────────────────────────────────────────────────────
  const queries: { name: string; sql: (t: string) => string }[] = [
    {
      name: "SUM(valor) total",
      sql: (t) => `SELECT SUM(valor) FROM [${SCHEMA}].[${t}]`,
    },
    {
      name: "GROUP BY categoria + SUM",
      sql: (t) => `SELECT categoria, SUM(valor), COUNT(*) FROM [${SCHEMA}].[${t}] GROUP BY categoria`,
    },
    {
      name: "Filtro de range (data 6 meses)",
      sql: (t) => `SELECT COUNT(*), SUM(valor) FROM [${SCHEMA}].[${t}] WHERE data_ref BETWEEN '2023-01-01' AND '2023-06-30'`,
    },
    {
      name: "GROUP BY data_ref (730 grupos)",
      sql: (t) => `SELECT data_ref, SUM(valor) FROM [${SCHEMA}].[${t}] GROUP BY data_ref ORDER BY data_ref`,
    },
    {
      name: "Filtro + GROUP BY (2 colunas)",
      sql: (t) => `SELECT categoria, data_ref, SUM(valor) FROM [${SCHEMA}].[${t}] WHERE valor > 500 GROUP BY categoria, data_ref`,
    },
  ];

  const results: { query: string; rowstoreMs: number; columnstoreMs: number; speedup: string }[] = [];

  for (const q of queries) {
    // Warm up caches
    await pool.request().query(q.sql(RS_TABLE));
    await pool.request().query(q.sql(CS_TABLE));

    // Measure (3 runs each, take min)
    const rsTimes: number[] = [];
    const csTimes: number[] = [];
    for (let i = 0; i < 3; i++) {
      let t = Date.now();
      await pool.request().query(q.sql(RS_TABLE));
      rsTimes.push(Date.now() - t);

      t = Date.now();
      await pool.request().query(q.sql(CS_TABLE));
      csTimes.push(Date.now() - t);
    }

    const rsMs = Math.min(...rsTimes);
    const csMs = Math.min(...csTimes);
    const speedup = rsMs > 0 ? (rsMs / csMs).toFixed(1) + "×" : "n/a";
    results.push({ query: q.name, rowstoreMs: rsMs, columnstoreMs: csMs, speedup });
  }

  // ── Resultados ─────────────────────────────────────────────────────────────
  console.log("Query".padEnd(45), "Rowstore".padStart(12), "Columnstore".padStart(13), "Speedup".padStart(9));
  console.log("─".repeat(82));
  for (const r of results) {
    console.log(
      r.query.padEnd(45),
      `${r.rowstoreMs}ms`.padStart(12),
      `${r.columnstoreMs}ms`.padStart(13),
      r.speedup.padStart(9),
    );
  }
  console.log();

  const avgSpeedup =
    results.reduce((sum, r) => sum + (r.rowstoreMs > 0 ? r.rowstoreMs / r.columnstoreMs : 1), 0) / results.length;
  console.log(`Speedup médio: ${avgSpeedup.toFixed(1)}×`);

  // ── Limpeza ────────────────────────────────────────────────────────────────
  await pool.request().query(`
    DROP TABLE IF EXISTS [${SCHEMA}].[${RS_TABLE}];
    DROP TABLE IF EXISTS [${SCHEMA}].[${CS_TABLE}];
  `);
  console.log("\nTabelas de teste removidas.");

  await pool.close();
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
