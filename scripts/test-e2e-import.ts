/**
 * Teste end-to-end do pipeline de importação contra Azure SQL + Azure Blob real.
 *
 * Valida:
 *   1. BULK INSERT com LOCATION container-level (fix do bug 7330)
 *   2. Dados que antes falhavam por tipagem (zero à esquerda, decimal BR, coluna mista)
 *   3. XLSX convertido para CSV passando pelo BULK INSERT
 *   4. Duas importações simultâneas
 *   5. Replace / append / upsert
 *   6. Colunas armazenadas como NVARCHAR no SQL Server
 *
 * Uso: npx tsx scripts/test-e2e-import.ts
 * Requer: .env com CATWORLD_DATABASE_URL + CATWORLD_AZURE_BLOB_CONNECTION_STRING
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import sql from "mssql";
import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";

// ── Load .env ──────────────────────────────────────────────────
const envPath = resolve(".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const sep = t.indexOf("=");
    if (sep === -1) continue;
    const key = t.slice(0, sep).trim();
    let val = t.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

for (const k of ["CATWORLD_DATABASE_URL", "CATWORLD_AZURE_BLOB_CONNECTION_STRING", "CATWORLD_AZURE_BLOB_CONTAINER"]) {
  if (!process.env[k]) {
    console.error(`❌ ${k} não definido. Crie .env ou export a variável.`);
    process.exit(1);
  }
}

const CONN_STR = process.env["CATWORLD_AZURE_BLOB_CONNECTION_STRING"]!;
const CONTAINER = process.env["CATWORLD_AZURE_BLOB_CONTAINER"]!;
const ACCOUNT = CONN_STR.match(/AccountName=([^;]+)/i)![1]!;
const KEY = CONN_STR.match(/AccountKey=([^;]+)/i)![1]!;

// ── Helpers ─────────────────────────────────────────────────────
function parseSqlUrl(url: string): sql.config {
  const without = url.replace(/^sqlserver:\/\//i, "");
  const [hostPort, ...rest] = without.split(";").filter(Boolean);
  const [server, port] = hostPort!.split(":");
  const params = Object.fromEntries(rest.map((p) => { const i = p.indexOf("="); return [p.slice(0, i).toLowerCase(), p.slice(i + 1)]; }));
  return {
    server: server!,
    port: port ? Number(port) : 1433,
    database: params["database"],
    user: params["user"],
    password: params["password"],
    options: { encrypt: params["encrypt"] !== "false", trustServerCertificate: params["trustservercertificate"] === "true", packetSize: 16384 },
    requestTimeout: 600_000,
    connectionTimeout: 30_000,
    pool: { max: 10, min: 2, idleTimeoutMillis: 30_000 },
  };
}

function generateSas(blobName: string, expiryMs = 60 * 60_000): string {
  const credential = new StorageSharedKeyCredential(ACCOUNT, KEY);
  return generateBlobSASQueryParameters(
    { containerName: CONTAINER, blobName, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + expiryMs) },
    credential
  ).toString();
}

function escapeSqlLiteral(v: string) {
  return v.replaceAll("'", "''");
}

function md5(s: string) { return createHash("md5").update(s).digest("hex"); }

let pass = 0;
let fail = 0;
function ok(msg: string) {
  pass++;
  console.log(`  ✅ ${msg}`);
}
function ng(msg: string, err?: unknown) {
  fail++;
  console.error(`  ❌ ${msg}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ""}`);
}

// ── Test suite ──────────────────────────────────────────────────
async function main() {
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  Teste E2E: Pipeline de Importação (Azure SQL + Blob)`);
  console.log(`  Container: ${CONTAINER}`);
  console.log(`  Account:   ${ACCOUNT}`);
  console.log(`═══════════════════════════════════════════════════════\n`);

  const pool = await new sql.ConnectionPool(parseSqlUrl(process.env["CATWORLD_DATABASE_URL"]!)).connect();
  const service = BlobServiceClient.fromConnectionString(CONN_STR);
  const containerClient = service.getContainerClient(CONTAINER);
  const testRun = `e2e_${Date.now()}`;
  const blobsToClean: string[] = [];
  const tablesToClean: string[] = [];

  async function uploadCsv(blobName: string, content: string): Promise<string> {
    const bc = containerClient.getBlockBlobClient(blobName);
    await bc.upload(content, Buffer.byteLength(content), { blobHTTPHeaders: { blobContentType: "text/csv; charset=utf-8" } });
    blobsToClean.push(blobName);
    return blobName;
  }

  async function bulkInsertFromBlob(
    schema: string,
    table: string,
    blobName: string,
    fieldTerminator = "|"
  ): Promise<number> {
    const uid = `${testRun}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const credName = `CatworldBulkCred_${uid}`;
    const dsName = `CatworldBulkDS_${uid}`;
    const sasToken = generateSas(blobName);

    // Atomic DROP+CREATE — mesmo padrão do fix no importer-bulk-blob.ts
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sys.database_scoped_credentials WHERE name='${credName}')
        DROP DATABASE SCOPED CREDENTIAL [${credName}];
      CREATE DATABASE SCOPED CREDENTIAL [${credName}]
      WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sasToken}'
    `);
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sys.external_data_sources WHERE name='${dsName}')
        DROP EXTERNAL DATA SOURCE [${dsName}];
      CREATE EXTERNAL DATA SOURCE [${dsName}]
      WITH (
        TYPE = BLOB_STORAGE,
        LOCATION = 'https://${ACCOUNT}.blob.core.windows.net',
        CREDENTIAL = [${credName}]
      )
    `);

    try {
      const r = await pool.request().query(`
        BULK INSERT ${schema}.[${table}]
        FROM '${CONTAINER}/${blobName}'
        WITH (
          DATA_SOURCE = '${dsName}',
          FORMAT = 'CSV',
          FIELDTERMINATOR = '${escapeSqlLiteral(fieldTerminator)}',
          ROWTERMINATOR = '\n',
          FIELDQUOTE = '"',
          FIRSTROW = 2,
          TABLOCK,
          CODEPAGE = '65001'
        )
      `);
      const count = (await pool.request().query(`SELECT COUNT(*) AS n FROM ${schema}.[${table}]`)).recordset[0] as { n: number };
      return count.n;
    } finally {
      await pool.request().query(`DROP EXTERNAL DATA SOURCE IF EXISTS [${dsName}]`).catch(() => {});
      await pool.request().query(`DROP DATABASE SCOPED CREDENTIAL IF EXISTS [${credName}]`).catch(() => {});
    }
  }

  async function createStagingTable(schema: string, table: string, columns: { name: string }[], includeCwRh = false) {
    const colDefs = columns.map((c) => `[${c.name}] NVARCHAR(MAX) NULL`).join(",\n") + (includeCwRh ? ",\n[_cw_rh] CHAR(32) NULL" : "");
    await pool.request().query(`
      IF OBJECT_ID(N'${schema}.${table}', N'U') IS NOT NULL DROP TABLE ${schema}.[${table}];
      CREATE TABLE ${schema}.[${table}] (${colDefs})
    `);
    tablesToClean.push(`${schema}.[${table}]`);
  }

  function csvEscape(v: unknown): string {
    if (v == null || String(v).trim() === "") return '""';
    const s = String(v).replace(/"/g, '""').replace(/[\n\r\t]/g, " ").replace(/\|/g, " ");
    return `"${s}"`;
  }

  function makeCsv(header: string[], rows: unknown[][]): string {
    const headerLine = header.join("|");
    const dataLines = rows.map((r) => r.map(csvEscape).join("|"));
    return headerLine + "\n" + dataLines.join("\n") + "\n";
  }

  // ═══════════════════════════════════════════════════════════════
  //  TESTE 1: BULK INSERT com LOCATION container-level
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n─── Teste 1: BULK INSERT com LOCATION container-level ───`);
  {
    const tableName = `t1_container_loc_${testRun}`;
    const blobName = `tmp/${tableName}.csv`;
    const header = ["id", "nome", "valor"];
    const rows = Array.from({ length: 5000 }, (_, i) => [i + 1, `Produto ${i}`, (Math.random() * 1000).toFixed(2)]);
    await createStagingTable("dbo", tableName, header.map((n) => ({ name: n })));
    await uploadCsv(blobName, makeCsv(header, rows));
    try {
      const n = await bulkInsertFromBlob("dbo", tableName, blobName);
      if (n === 5000) ok(`BULK INSERT: 5000 linhas importadas via LOCATION container-level`);
      else ng(`Esperava 5000 linhas, recebeu ${n}`);
    } catch (e) {
      ng("BULK INSERT falhou", e);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  TESTE 2: Dados que antes falhavam por tipagem
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n─── Teste 2: Dados que antes quebravam por tipagem ──────`);
  {
    const tableName = `t2_typing_${testRun}`;
    const blobName = `tmp/${tableName}.csv`;
    const header = ["codigo", "produto", "preco_br", "data"];
    const rows: unknown[][] = [
      ["00123", "Parafuso 1/4\"", "1.234,56", "04/05/2026"],
      ["00001", "ÁGUA SANITÁRIA 5L", "999,90", "31/12/2024"],
      ["01234", "Caneta AZUL CX C/50", "0,50", "2026-01-15"],
      ["99999", "Produto com número 123 no meio", "1.000,00", "15/01/2026 08:30"],
      [null, "", "", ""],
      ["ABC01", "100% algodão", "0,00", null],
    ];
    await createStagingTable("dbo", tableName, header.map((n) => ({ name: n })));
    await uploadCsv(blobName, makeCsv(header, rows));
    try {
      const n = await bulkInsertFromBlob("dbo", tableName, blobName);
      if (n === 6) ok(`Tipagem: 6 linhas com dados problemáticos importadas sem erro de conversão`);
      else ng(`Esperava 6 linhas, recebeu ${n}`);

      // Verifica que os dados chegaram como NVARCHAR (sem perda de zero à esquerda)
      const data = await pool.request().query(`SELECT codigo, produto, preco_br, data FROM dbo.[${tableName}] ORDER BY (SELECT NULL)`);
      const rowsOut = data.recordset as { codigo: string | null; produto: string | null; preco_br: string | null; data: string | null }[];
      if (rowsOut[0]?.codigo === "00123") ok("Zero à esquerda preservado: '00123'");
      else ng(`Zero à esquerda perdido: '${rowsOut[0]?.codigo}'`);
      if (String(rowsOut[0]?.preco_br) === "1.234,56") ok("Decimal brasileiro preservado: '1.234,56'");
      else ng(`Decimal brasileiro alterado: '${rowsOut[0]?.preco_br}'`);
      if (String(rowsOut[0]?.produto)?.includes("1/4\"")) ok("Caractere especial (aspas) preservado");
      else ng(`Aspas perdidas: '${rowsOut[0]?.produto}'`);
      if (String(rowsOut[2]?.codigo) === "01234") ok("Zero à esquerda linha 3 preservado: '01234'");
      else ng(`Zero à esquerda linha 3 perdido: '${rowsOut[2]?.codigo}'`);
      if (rowsOut[4]?.codigo === null && rowsOut[4]?.produto === null) ok("Nulos preservados como NULL");
      else ng(`Nulos: codigo='${rowsOut[4]?.codigo}' produto='${rowsOut[4]?.produto}'`);
    } catch (e) {
      ng("Teste de tipagem falhou", e);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  TESTE 3: XLSX → CSV via BULK INSERT
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n─── Teste 3: XLSX convertido para CSV via BULK INSERT ─────`);
  {
    // Simula o que o worker faz: XLSX → preview → mapping → CSV limpo → blob → BULK INSERT
    const tableName = `t3_xlsx_flow_${testRun}`;
    const blobName = `tmp/${tableName}.csv`;
    const header = ["codigo", "unidade", "pack"];
    const rows = [
      ["AMA240", "UN", "272"],
      ["AMD120", "UN", "20"],
      [null, "CX", "1"],
    ];
    await createStagingTable("dbo", tableName, header.map((n) => ({ name: n })));
    await uploadCsv(blobName, makeCsv(header, rows));
    try {
      const n = await bulkInsertFromBlob("dbo", tableName, blobName);
      if (n === 3) ok(`XLSX flow: 3 linhas importadas via BULK INSERT`);
      else ng(`Esperava 3, recebeu ${n}`);
    } catch (e) {
      ng("XLSX flow BULK INSERT falhou", e);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  TESTE 4: Duas importações simultâneas
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n─── Teste 4: Duas importações simultâneas ────────────────`);
  {
    const tA = `t4a_parallel_${testRun}`;
    const tB = `t4b_parallel_${testRun}`;
    const bA = `tmp/${tA}.csv`;
    const bB = `tmp/${tB}.csv`;
    await createStagingTable("dbo", tA, [{ name: "id" }, { name: "nome" }]);
    await createStagingTable("dbo", tB, [{ name: "codigo" }, { name: "valor" }]);
    await uploadCsv(bA, makeCsv(["id", "nome"], [[1, "Ana"], [2, "Bob"]]));
    await uploadCsv(bB, makeCsv(["codigo", "valor"], [["X001", "100"], ["X002", "200"]]));
    try {
      const [nA, nB] = await Promise.all([
        bulkInsertFromBlob("dbo", tA, bA),
        bulkInsertFromBlob("dbo", tB, bB),
      ]);
      if (nA === 2 && nB === 2) ok(`Paralelo: ambas importaram 2 linhas (A=${nA}, B=${nB})`);
      else ng(`Resultado inesperado: A=${nA}, B=${nB}`);
    } catch (e) {
      ng("Teste paralelo falhou", e);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  TESTE 5: Replace / Append / Upsert
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n─── Teste 5: Replace / Append / Upsert ───────────────────`);
  {
    const base = `t5_modes_${testRun}`;
    const blob1 = `tmp/${base}_1.csv`;
    const blob2 = `tmp/${base}_2.csv`;

    // ── 5a. Replace ──
    // Cria uma tabela alvo com 2 linhas, depois faz replace com 3 linhas novas
    const replaceTable = `${base}_replace`;
    await createStagingTable("dbo", replaceTable, [{ name: "id" }, { name: "nome" }]);
    // Insert initial data (simulating first import)
    await pool.request().query(`INSERT INTO dbo.[${replaceTable}] ([id],[nome]) VALUES ('1','Old'),('2','Old2')`);
    // Replace: create staging with new data, drop old, rename staging → target
    const stageReplace = `${base}_replace_stage`;
    await createStagingTable("dbo", stageReplace, [{ name: "id" }, { name: "nome" }]);
    await uploadCsv(blob1, makeCsv(["id", "nome"], [["3", "Novo"], ["4", "Novo2"], ["5", "Novo3"]]));
    try {
      const n = await bulkInsertFromBlob("dbo", stageReplace, blob1);
      if (n === 3) {
        // Simula o replace: drop target, rename staging
        await pool.request().query(`DROP TABLE dbo.[${replaceTable}]`);
        await pool.request().query(`EXEC sp_rename N'dbo.${stageReplace}', N'${replaceTable}'`);
        const cnt = (await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.[${replaceTable}]`)).recordset[0] as { n: number };
        if (cnt.n === 3) ok(`Replace: tabela substituída (3 novas linhas)`);
        else ng(`Replace: esperava 3 linhas, recebeu ${cnt.n}`);
      } else {
        ng(`Replace bulk: esperava 3, recebeu ${n}`);
      }
    } catch (e) {
      ng("Replace falhou", e);
    }

    // ── 5b. Append ──
    const appendTable = `${base}_append`;
    await createStagingTable("dbo", appendTable, [{ name: "id" }, { name: "nome" }]);
    await pool.request().query(`INSERT INTO dbo.[${appendTable}] ([id],[nome]) VALUES ('1','Existente')`);
    const stageAppend = `${base}_append_stage`;
    await createStagingTable("dbo", stageAppend, [{ name: "id" }, { name: "nome" }]);
    await uploadCsv(blob2, makeCsv(["id", "nome"], [["2", "Adicionado"]]));
    try {
      const n = await bulkInsertFromBlob("dbo", stageAppend, blob2);
      if (n === 1) {
        await pool.request().query(`INSERT INTO dbo.[${appendTable}] ([id],[nome]) SELECT [id],[nome] FROM dbo.[${stageAppend}]`);
        const cnt = (await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.[${appendTable}]`)).recordset[0] as { n: number };
        if (cnt.n === 2) ok(`Append: 2 linhas (1 existente + 1 adicionada)`);
        else ng(`Append: esperava 2, recebeu ${cnt.n}`);
      } else ng(`Append bulk: esperava 1, recebeu ${n}`);
    } catch (e) {
      ng("Append falhou", e);
    }

    // ── 5c. Upsert ──
    const upsertTable = `${base}_upsert`;
    await createStagingTable("dbo", upsertTable, [{ name: "id" }, { name: "nome" }, { name: "valor" }]);
    await pool.request().query(`INSERT INTO dbo.[${upsertTable}] ([id],[nome],[valor]) VALUES ('1','Velho','100'),('2','Fixo','200')`);
    const stageUpsert = `${base}_upsert_stage`;
    await createStagingTable("dbo", stageUpsert, [{ name: "id" }, { name: "nome" }, { name: "valor" }]);
    await uploadCsv(blob1, makeCsv(["id", "nome", "valor"], [["1", "Novo", "999"], ["3", "Inserido", "300"]]));
    try {
      const n = await bulkInsertFromBlob("dbo", stageUpsert, blob1);
      if (n === 2) {
        // Simula MERGE: atualiza id=1, insere id=3
        await pool.request().query(`
          MERGE INTO dbo.[${upsertTable}] AS t
          USING dbo.[${stageUpsert}] AS s ON t.[id]=s.[id]
          WHEN MATCHED THEN UPDATE SET t.[nome]=s.[nome], t.[valor]=s.[valor]
          WHEN NOT MATCHED THEN INSERT ([id],[nome],[valor]) VALUES (s.[id],s.[nome],s.[valor]);
        `);
        const cnt = (await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.[${upsertTable}]`)).recordset[0] as { n: number };
        const updated = (await pool.request().query(`SELECT nome, valor FROM dbo.[${upsertTable}] WHERE id='1'`)).recordset[0] as { nome: string; valor: string };
        if (cnt.n === 3 && updated.nome === "Novo" && updated.valor === "999") ok(`Upsert: 3 linhas (1 atualizada, 1 inserida, 1 intacta)`);
        else ng(`Upsert: resultado inesperado count=${cnt.n} nome='${updated?.nome}' valor='${updated?.valor}'`);
      } else ng(`Upsert bulk: esperava 2, recebeu ${n}`);
    } catch (e) {
      ng("Upsert falhou", e);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  TESTE 6: Colunas são NVARCHAR no SQL Server
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n─── Teste 6: Verificação de tipos NVARCHAR no SQL Server ──`);
  {
    const tableName = `t6_columns_${testRun}`;
    const blobName = `tmp/${tableName}.csv`;
    await createStagingTable("dbo", tableName, [{ name: "col1" }, { name: "col2" }, { name: "col3" }], true);
    await uploadCsv(blobName, makeCsv(["col1", "col2", "col3", "_cw_rh"], [["a", "b", "c", md5("a|b|c")]]));
    try {
      await bulkInsertFromBlob("dbo", tableName, blobName);
      const cols = await pool.request().query(`
        SELECT c.name, t.name AS type_name, c.max_length
        FROM sys.columns c
        JOIN sys.types t ON c.user_type_id = t.user_type_id
        WHERE c.object_id = OBJECT_ID(N'dbo.${tableName}')
        ORDER BY c.column_id
      `);
      const rows = cols.recordset as { name: string; type_name: string; max_length: number }[];
      const nvarcharCols = rows.filter((r) => r.name !== "_cw_rh" && r.type_name === "nvarchar" && r.max_length === -1);
      if (nvarcharCols.length === 3) ok(`NVARCHAR(MAX): 3 colunas de dados confirmadas como NVARCHAR(MAX)`);
      else ng(`Colunas NVARCHAR: esperava 3, encontrou ${nvarcharCols.length}`);
      const cwCol = rows.find((r) => r.name === "_cw_rh");
      if (cwCol && cwCol.type_name === "char" && cwCol.max_length === 32) ok("_cw_rh: CHAR(32) confirmado");
      else ng(`_cw_rh: esperava CHAR(32), encontrou ${cwCol?.type_name}(${cwCol?.max_length})`);
    } catch (e) {
      ng("Verificação de colunas falhou", e);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  RESULTADO
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  RESULTADO: ${pass} passaram, ${fail} falharam`);
  console.log(`═══════════════════════════════════════════════════════\n`);

  // ── Cleanup ────────────────────────────────────────────────────
  console.log(`\n─── Cleanup ─────────────────────────────────────────────`);
  for (const t of tablesToClean) {
    await pool.request().query(`IF OBJECT_ID(N'${t.replace("[", "").replace("]", "").replace(".", "].[")}', N'U') IS NOT NULL DROP TABLE ${t}`).catch(() => {});
  }
  for (const b of blobsToClean) {
    await containerClient.getBlockBlobClient(b).delete().catch(() => {});
  }
  console.log(`  Blobs: ${blobsToClean.length} removidos`);
  console.log(`  Tabelas: ${tablesToClean.length} removidas`);
  await pool.close();

  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((e) => {
  console.error("\n❌ Erro fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
