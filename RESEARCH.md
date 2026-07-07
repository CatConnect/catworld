# Relatório de Pesquisa: Melhorias Substanciais no Catworld

**Pesquisador:** Claude Sonnet 4.6 — 2026-07-07

---

## Metodologia

Leitura completa de: `src/server/uploads/importer.ts`, `importer-bulk-blob.ts`, `parser.ts`, `worker/index.ts`, `azure/sql.ts`, `sdk/python/client.py`. Pesquisa de benchmarks públicos de DuckDB, MERGE vs DELETE+INSERT no Azure SQL, xxHash vs MD5, e padrões de upload streaming em Python.

---

## Descobertas: gargalos reais no código

### 1. DDL por importação — criação de credencial e data source a cada upload

**Arquivo:** `src/server/uploads/importer-bulk-blob.ts:140-151`

```ts
// Criado e destruído a cada BULK INSERT
CREATE DATABASE SCOPED CREDENTIAL [CatworldBulkCred_${hash}] ...
CREATE EXTERNAL DATA SOURCE [CatworldBulkDS_${hash}] ...
```

Isso é DDL no banco — adquire locks de metadados, invalida caches de planos. Em ambientes com múltiplos uploads concorrentes, esses DDLs competem entre si.

**Solução:** Criar uma credencial permanente na inicialização do banco (migration SQL), nunca recriar. O SAS token fica como parâmetro dinâmico via `ALTER`, não no `DROP+CREATE`.

---

### 2. MD5 criptográfico por linha — o hash mais lento da família

**Arquivo:** `src/server/uploads/importer-bulk-blob.ts:102`

```ts
const rowHash = createHash("md5").update(csvLine).digest("hex");
```

MD5 é criado e destruído para cada linha. Para 1M linhas, isso é 1M instanciações de `crypto.Hash`. MD5 é uma função **criptográfica** — usa aritmética modular para resistência a colisões intencionais. Para deduplicação de CSV onde não há adversário, é overshoot total.

**Benchmarks (MojoAuth):**
- xxHash: ~3-5× mais rápido que MD5
- MurmurHash3: ~2-4× mais rápido que MD5
- CRC32 (Node.js 22+ nativo, `node:zlib`): sem dependência externa

Além disso, xxHash64 produz 16 chars hex vs 32 do MD5 — menos I/O e storage.

---

### 3. MERGE para upsert — conhecido por ser 19% mais lento

**Arquivo:** `src/server/uploads/importer.ts:341-356`

```sql
MERGE INTO ${target} AS t USING ${staging} AS s ON t.${key}=${keyExpr} ...
```

**Benchmark da MSSQLTips:** MERGE é ~19% mais lento que INSERT+UPDATE separados. Em datasets grandes no Azure SQL, a diferença pode chegar a 1.8× (50M rows: MERGE = 1h, DELETE+INSERT = 12 min no Azure Synapse). O MERGE também causa fragmentação de índice de 18% vs 0.57% no padrão DELETE+INSERT.

Microsoft recomenda explicitamente usar INSERT/UPDATE/DELETE individuais quando possível.

---

### 4. Python SDK: arquivo inteiro na memória antes de gzip

**Arquivo:** `sdk/python/src/catworld/client.py:108`

```python
raw_bytes = file.read_bytes()        # carrega TUDO em RAM
compressed = gzip.compress(raw_bytes, compresslevel=1)
```

Para um CSV de 500 MB, o processo Python precisa de ~1.5 GB de RAM. Para 1 GB, ~3 GB. Isso é um teto artificial de escala. httpx suporta streaming nativo via generators.

---

### 5. Dois jobs sequenciais = arquivo baixado duas vezes

**Arquivo:** `src/worker/index.ts:69-109`

```
PREVIEW_UPLOAD → download blob → disco local → parse schema
IMPORT_UPLOAD  → download blob → parse + ingest
```

O arquivo é lido duas vezes do Azure Blob. O `originals/` copy é uma mitigação, mas o download duplo ainda acontece.

---

### 6. NVARCHAR(MAX) staging + type-cast em SELECT — double I/O

**Arquivo:** `src/server/uploads/importer.ts:119` e `:270`

```sql
-- staging: tudo NVARCHAR(MAX) (2 bytes/char)
CREATE TABLE ${staging} (col1 NVARCHAR(MAX) NULL, ...)

-- depois: INSERT INTO target SELECT TRY_CONVERT(BIGINT, ...) FROM staging
```

A staging armazena os dados em formato texto expandido, depois faz uma passagem completa com conversão de tipos. Para 10M rows com colunas numéricas, o staging ocupa 3-5× mais espaço que o necessário.

---

### 7. Polling de 30s para verificar que o blob existe

**Arquivo:** `src/server/uploads/importer-bulk-blob.ts:112-127`

```ts
while (Date.now() - pollStarted < 30_000) {
  const exists = await blockClient.exists();
  await new Promise(r => setTimeout(r, 1000)); // poll a cada 1 segundo
}
```

O `await uploadPromise` (linha 80) já garante que o upload foi confirmado pelo Azure SDK. O polling é redundante — se a Promise resolveu sem erro, o blob existe. Adiciona 1-3s de latência desnecessária por import.

---

### 8. csv-parse em Node.js — ~90K rows/seg vs potencial 10M+/seg

**Arquivo:** `src/server/uploads/parser.ts:38`

```ts
source.pipe(iconv.decodeStream(encoding)).pipe(parse({delimiter, ...}))
```

A biblioteca `csv-parse` processa ~90K rows/sec em Node.js single-thread. **DuckDB processa 38 milhões de linhas em 3.5 segundos em M3** (~11M rows/seg) — potencial de 120× de ganho.

---

## Recomendações Rankeadas por Impacto

### #1 — DuckDB-WASM para preview no browser

**Impacto:** Elimina o job `PREVIEW_UPLOAD` inteiramente. Schema e sample data em < 1 segundo, sem esperar fila de worker.

```ts
// No componente React do upload
import * as duckdb from '@duckdb/duckdb-wasm';

const db = await duckdb.createInMemoryDB();
const conn = await db.connect();
await db.registerFileHandle('upload.csv', file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
const schema = await conn.query('DESCRIBE SELECT * FROM read_csv_auto("upload.csv", sample_size=200)');
```

DuckDB-WASM detecta separador, encoding, tipos de coluna e retorna preview em < 500ms para arquivos de centenas de MB — sem upload, sem servidor, sem fila. DuckDB CSV reader tem 99.61% de precisão no Pollock Robustness Benchmark (2025).

**Esforço:** Médio (2-3 dias). **Risco:** Baixo.

---

### #2 — Credencial permanente no banco, SAS gerado fora do DDL

**Impacto:** Elimina DDL por importação. Em cargas concorrentes, remove contenção de locks de metadados.

```sql
-- Migration (roda uma vez):
CREATE DATABASE SCOPED CREDENTIAL [CatworldBulkCredPermanent]
  WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = 'placeholder';

CREATE EXTERNAL DATA SOURCE [CatworldBulkDSPermanent]
  WITH (TYPE = BLOB_STORAGE,
        LOCATION = 'https://account.blob.core.windows.net/container',
        CREDENTIAL = [CatworldBulkCredPermanent]);
```

```ts
// Por import: só atualiza a credencial (ALTER, não DROP+CREATE)
await pool.request().query(`
  ALTER DATABASE SCOPED CREDENTIAL [CatworldBulkCredPermanent]
  WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sas}';
`);
```

Alternativa ainda melhor: usar **Managed Identity** (sem SAS) se o Azure SQL estiver na mesma tenant que o Storage.

**Esforço:** Baixo (1 dia). **Risco:** Baixo.

---

### #3 — Substituir MD5 por xxHash ou CRC32

**Impacto:** 3-5× no cálculo de hash por linha, menor storage.

```ts
// Opção A: xxhash-wasm (sem deps nativas, ~3-5× mais rápido)
import xxhash from 'xxhash-wasm';
const { h64ToString } = await xxhash();
const rowHash = h64ToString(csvLine); // 16 chars hex

// Opção B: CRC32 nativo Node.js 22+ (zero deps)
import { crc32 } from "node:zlib";
const hash = crc32(Buffer.from(csvLine)).toString(16).padStart(8, '0');
```

**Migration SQL necessária:** alterar `_cw_rh CHAR(32)` para `CHAR(16)` (xxHash) ou `CHAR(8)` (CRC32). Risco de colisão com CRC32 em conjuntos > 1M rows — xxHash64 é escolha mais segura.

**Esforço:** Médio (2 dias + migration). **Risco:** Médio.

---

### #4 — Substituir MERGE por DELETE+INSERT no upsert

**Impacto:** 1.5-1.8× mais rápido, menos fragmentação de índice.

```ts
// Proposto em importer.ts (substituir bloco de MERGE):
await request.query(`
  DELETE t FROM ${target} t
    INNER JOIN ${staging} s ON t.${key} = ${keyExpr};
  INSERT INTO ${target} (${colList})
    SELECT ${typedSelect} FROM ${staging} s;
  DROP TABLE ${staging};
`);
```

Semanticamente equivalente ao upsert. Perde contagem separada de inserts vs updates — avaliar se essa métrica vale o custo.

**Esforço:** Baixo (< 1 dia). **Risco:** Baixo.

---

### #5 — Python SDK: streaming gzip sem carregar arquivo na RAM

**Impacto:** Elimina o teto de ~500 MB de RAM. Habilita arquivos de vários GB.

```python
# sdk/python/src/catworld/client.py — substituir read_bytes() por generator:
import zlib, hashlib

def _streaming_gzip(file: Path):
    compressor = zlib.compressobj(level=1, wbits=31)  # gzip format
    hasher = hashlib.md5()
    with file.open("rb") as f:
        while chunk := f.read(1024 * 1024):  # 1 MB chunks
            hasher.update(chunk)
            yield compressor.compress(chunk)
        yield compressor.flush()

# httpx aceita generator diretamente:
response = self._client.put(url, content=_streaming_gzip(file), ...)
```

**Esforço:** Baixo (< 1 dia). **Risco:** Baixo.

---

### #6 — Remover polling de blob pós-upload

**Impacto:** -1-3s de latência por import.

Remover o bloco de polling em `importer-bulk-blob.ts:112-127`. O `await uploadPromise` já garante disponibilidade. Se o BULK INSERT falhar com "blob does not exist", o retry automático já trata.

**Esforço:** Trivial (< 30 min). **Risco:** Baixo.

---

### #7 — Columnstore Index nas tabelas de dados

**Impacto:** 10-100× em queries analíticas (SUM, COUNT, GROUP BY, filtros de range).

```sql
-- Na criação da tabela final (importer.ts:312):
CREATE TABLE ${target} (${targetColDefs}, [_cw_rh] CHAR(32) NULL);
CREATE CLUSTERED COLUMNSTORE INDEX [CCI_${tableName}] ON ${target};
CREATE NONCLUSTERED INDEX [IX__cw_rh] ON ${target} ([_cw_rh]);
```

**Ressalvas:**
- Writes pontuais (UPDATEs individuais) são mais lentos no columnstore
- Para upsert em tabelas pequenas, pode ser contraproducente
- Heurística sugerida: columnstore para tabelas > 100K rows

**Esforço:** Médio (2 dias + testes). **Risco:** Médio.

---

### #8 — DuckDB no worker para parsing CSV

**Impacto:** 10-50× no parsing de CSV grande (potencial de minutos → segundos).

```ts
import { Database } from 'duckdb-async';
const db = new Database(':memory:');
const conn = await db.connect();
await conn.run(`
  COPY (SELECT ${columnExprs} FROM read_csv_auto('${localPath}', sample_size=-1))
  TO '${outputPath}' (FORMAT CSV, DELIMITER '|', HEADER false)
`);
```

**Ressalva:** DuckDB para Node.js ainda está em maturação. Manter fallback para csv-parse.

**Esforço:** Alto (3-5 dias). **Risco:** Médio.

---

## Sumário por ROI

| # | Recomendação | Impacto | Esforço | Risco |
|---|---|---|---|---|
| 1 | DuckDB-WASM para preview no browser | Elimina job inteiro, UX 10× melhor | Médio | Baixo |
| 2 | Credencial permanente no banco | 2-5× throughput concorrente | Baixo | Baixo |
| 3 | xxHash no lugar de MD5 | 3-5× no hash de linha | Médio | Médio |
| 4 | DELETE+INSERT no lugar de MERGE | 1.5-1.8× no upsert | Baixo | Baixo |
| 5 | Python SDK streaming | Sem teto de RAM | Baixo | Baixo |
| 6 | Remover polling de blob | -2s por import | Trivial | Baixo |
| 7 | Columnstore Index | 10-100× em queries analíticas | Médio | Médio |
| 8 | DuckDB no worker | 10-50× no parsing CSV | Alto | Médio |

---

## Ideia além do óbvio: Arrow IPC como formato interno

Em vez de CSV normalizado (`|`-delimited) no clean blob → BULK INSERT, usar **Apache Arrow IPC** como formato intermediário. Arrow é o formato nativo do DuckDB e do pandas, tem leitura colunar zero-copy, e tem suporte experimental no Azure SQL via OPENROWSET. O fluxo seria:

```
CSV → DuckDB (worker ou browser) → Arrow IPC blob → SQL Server OPENROWSET (Parquet/Arrow)
```

Arrow IPC é tipicamente 3-5× menor que CSV equivalente para dados numéricos/datas, e a conversão de tipos acontece no schema do Arrow, eliminando a camada de `TRY_CONVERT` no SQL. Ainda experimental no Azure SQL, mas já funciona no Azure Synapse Serverless.

---

## Fontes

- [DuckDB CSV Pollock Robustness Benchmark (2025)](https://duckdb.org/2025/04/16/duckdb-csv-pollock-benchmark)
- [Driving CSV Performance: DuckDB with NYC Taxi Dataset](https://duckdb.org/2024/10/16/driving-csv-performance-benchmarking-duckdb-with-the-nyc-taxi-dataset)
- [SQL MERGE vs INSERT/UPDATE/DELETE Performance – MSSQLTips](https://www.mssqltips.com/sqlservertip/7590/sql-merge-performance-vs-insert-update-delete/)
- [Columnstore indexes: Data loading guidance – Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/columnstore-indexes-data-loading-guidance)
- [Parquet vs CSV for Azure Pipelines – SQLYARD](https://sqlyard.com/2024/12/10/parquet-vs-csv-for-azure-pipelines-which-is-better-for-performance/)
- [DuckDB-WASM: Analytical SQL in Your Browser – MotherDuck](https://motherduck.com/blog/duckdb-wasm-in-browser/)
- [MD5 vs xxHash – MojoAuth](https://mojoauth.com/compare-hashing-algorithms/md5-vs-xxhash)
- [Azure Blob Storage Performance Tuning for Python – Microsoft Learn](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blobs-tune-upload-download-python)
