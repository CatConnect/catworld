# Checklist de Melhorias — Catworld

> Baseado em `RESEARCH.md` (2026-07-07). Ordenado por risco crescente e impacto decrescente.

---

## Fase 1 — Colheita fácil (baixo risco, sem dependências)

### #6 Remover polling de blob pós-upload
**Arquivo:** `src/server/uploads/importer-bulk-blob.ts:112-127`
- [ ] Remover o loop `while (Date.now() - pollStarted < 30_000)`
- [ ] Remover a variável `blobVerified` e o `if (!blobVerified) throw`
- [ ] Verificar que o `await uploadPromise` continua sendo aguardado antes do `bulkInsert`
- [ ] Rodar um upload de teste e confirmar que BULK INSERT ainda funciona

### #4 Substituir MERGE por DELETE+INSERT no upsert
**Arquivo:** `src/server/uploads/importer.ts:328-358`
- [ ] Substituir o bloco `MERGE INTO ... USING` por `DELETE ... INNER JOIN` + `INSERT ... SELECT`
- [ ] Ajustar o retorno de `updated` e `inserted` (perdem granularidade, retornam total)
- [ ] Escrever um teste de upsert com chave duplicada e linha nova
- [ ] Confirmar que `DROP TABLE ${staging}` permanece no bloco

### #5 Python SDK: streaming gzip sem carregar na RAM
**Arquivo:** `sdk/python/src/catworld/client.py:108-138`
- [ ] Substituir `file.read_bytes()` por função geradora com chunks de 1 MB
- [ ] Calcular `file_hash` (MD5 do raw) incrementalmente dentro do generator
- [ ] Calcular `sizeBytes` com `file.stat().st_size` antes de iniciar o stream (já é feito)
- [ ] Testar com arquivo > 200 MB e confirmar que RAM do processo Python não estoura
- [ ] Rodar `tests/test_client.py` para garantir que nada quebrou

---

## Fase 2 — Infraestrutura de banco (1 migration, impacto em concorrência)

### #2 Credencial permanente no banco
**Arquivo:** `prisma/migrations/` (nova migration) + `src/server/uploads/importer-bulk-blob.ts`
- [ ] Criar migration SQL com `CREATE DATABASE SCOPED CREDENTIAL [CatworldBulkCredPermanent]`
- [ ] Criar migration SQL com `CREATE EXTERNAL DATA SOURCE [CatworldBulkDSPermanent]`
- [ ] Substituir `ensureCredentialAndDataSource()` por `ALTER DATABASE SCOPED CREDENTIAL ... SECRET = '${sas}'`
- [ ] Substituir `tempCred` e `tempDs` por as constantes permanentes no BULK INSERT
- [ ] Remover os `DROP` do bloco `finally` (credencial agora é permanente)
- [ ] Testar com 2 uploads simultâneos e confirmar que não há conflito de DDL
- [ ] Documentar no README que a credencial precisa existir no banco de produção

---

## Fase 3 — Frontend sem job de preview (maior impacto em UX)

### #1 DuckDB-WASM para preview no browser
**Pacote:** `@duckdb/duckdb-wasm`
- [ ] Instalar `@duckdb/duckdb-wasm` no frontend (`npm install @duckdb/duckdb-wasm`)
- [ ] Criar hook/util `useFilePreview(file: File)` que retorna `{ columns, rows, encoding, separator }`
- [ ] Adaptar componente de upload para chamar o hook antes de criar o upload na API
- [ ] Incluir `mappingJson` e `previewJson` no body do `POST /api/v1/uploads` com os dados calculados no browser
- [ ] Ajustar `actions.ts` para não enfileirar `PREVIEW_UPLOAD` quando `previewJson` já vier no payload
- [ ] Testar com CSV UTF-8, CSV win1252, XLSX e arquivos com separador `;`
- [ ] Testar com arquivo grande (> 100 MB) para confirmar que o browser não trava
- [ ] Manter `PREVIEW_UPLOAD` como fallback para uploads feitos fora do browser (API direta, SDK Python)

---

## Fase 4 — Hashing (requer planejamento de migração)

### #3 Substituir MD5 por xxHash
**⚠️ ADIADO — risco alto sem benefício imediato justificado**

**Problema descoberto em testes:** xxhash-wasm v1.1.0 não exporta `h128ToString` (128-bit/32 chars). Para manter `CHAR(32)` sem migration, precisaria concatenar dois `h64` (2 chamadas por linha vs 1 do MD5 — benefício reduzido).

**Problema mais crítico:** qualquer mudança de algoritmo de hash invalida o delta replace de TODAS as tabelas existentes. Na primeira importação após o deploy, todos os hashes seriam diferentes (MD5 vs xxHash), causando full replace involuntário em toda tabela com dados.

**Para implementar corretamente no futuro:**
- [ ] Versionar o algoritmo de hash na coluna `_cw_rh` ou em metadata separada
- [ ] Criar job de reprocessamento que recalcula hashes em background (sem downtime)
- [ ] Só ativar novo algoritmo em tabelas migradas
- [ ] Medir ganho real com `npx tsx scripts/benchmark-hash.ts` antes de decidir

---

## Fase 5 — Storage analítico (maior ganho em queries)

### #7 Columnstore Index nas tabelas de dados
**⚠️ BLOQUEADO — Service tier atual não suporta Columnstore Index (error 40536)**

O banco Azure SQL em uso (`77indicadores`) retornou:
> "'COLUMNSTORE' is not supported in this service tier of the database."

Columnstore requer Standard S3+ ou Premium tier. O benchmark foi criado em `scripts/benchmark-columnstore.ts` e pode ser rodado quando o tier for atualizado.

**Antes de reativar esta fase:**
- [ ] Verificar tier atual: `SELECT DATABASEPROPERTYEX(DB_NAME(), 'ServiceObjective')`
- [ ] Confirmar upgrade para S3+ ou Premium no Azure portal
- [ ] Rodar `npx tsx scripts/benchmark-columnstore.ts` para medir ganho real
- [ ] Só então aplicar em produção (checklist original abaixo)

**Checklist original (quando tier permitir):**
- [ ] Substituir `CREATE INDEX [IX__cw_rh]` por `CREATE CLUSTERED COLUMNSTORE INDEX` + `CREATE NONCLUSTERED INDEX [IX__cw_rh]`
- [ ] Testar todos os modos: replace, deltaReplace, append, upsert
- [ ] Medir impacto em queries via `executeReadOnly` com `executionTimeMs`

---

## Fase 6 — Parser (maior ganho em throughput, maior esforço)

### #8 DuckDB no worker para parsing CSV
**Pacote:** `duckdb-async` ou `@duckdb/node-api`
- [ ] Instalar e testar `@duckdb/node-api` no ambiente de worker (Windows + Linux)
- [ ] Criar função `parseWithDuckDB(path, mapping, outputPath)` que escreve CSV normalizado via `COPY ... TO`
- [ ] Integrar no path de `bulkInsertFromBlob`: se DuckDB disponível, usar; senão, fallback para csv-parse atual
- [ ] Testar com arquivos de encoding win1252 (DuckDB pode não ter suporte automático — verificar)
- [ ] Testar com XLSX (DuckDB suporta via extensão `spatial` ou `excel` — verificar disponibilidade)
- [ ] Medir tempo de end-to-end para arquivo de 500K e 2M rows antes e depois
- [ ] Monitorar uso de memória no worker (DuckDB usa memória para sort/aggregation)

---

## Tarefas transversais

- [ ] Adicionar logging de `executionTimeMs` no `executeReadOnly` para baseline de queries antes de aplicar columnstore
- [ ] Criar script de benchmark sintético: gerar CSV de 100K, 500K e 1M rows e medir tempo de import end-to-end
- [ ] Documentar no `README.md` os requisitos mínimos de Node.js (v22+ para `crc32` nativo, se usado)
- [ ] Após cada fase, medir e registrar métricas de performance no `RESEARCH.md`
