import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import sql from "mssql";

// Carrega .env manualmente
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("=");
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

const url = process.env.CATWORLD_DATABASE_URL;
if (!url) throw new Error("CATWORLD_DATABASE_URL ausente");

// Converte sqlserver://host:port;key=value;... para ADO.NET (formato que o mssql entende)
function toAdoNet(url) {
  const uriMatch = url.match(/^sqlserver:\/\/([^:/]+)(?::(\d+))?;/);
  if (!uriMatch) throw new Error("Formato inválido: não encontrou host na URL");
  const host = uriMatch[1];
  const port = uriMatch[2] || "1433";

  const params = url.slice(uriMatch[0].length);
  const parts = {};

  let i = 0;
  let currentKey = "";
  let currentVal = "";
  let parsingKey = true;
  while (i < params.length) {
    if (params[i] === "=" && parsingKey) {
      currentKey = currentVal;
      currentVal = "";
      parsingKey = false;
    } else if (params[i] === ";" && !parsingKey) {
      parts[currentKey.toLowerCase()] = currentVal;
      currentKey = "";
      currentVal = "";
      parsingKey = true;
    } else {
      currentVal += params[i];
    }
    i++;
  }
  if (currentKey) parts[currentKey.toLowerCase()] = currentVal;

  const map = {
    server: `Server=${host},${port}`,
    database: `Database=${parts["database"] || ""}`,
    user: `User Id=${parts["user"] || ""}`,
    password: `Password=${parts["password"] || ""}`,
    encrypt: `Encrypt=${parts["encrypt"] || "true"}`,
    trustservercertificate: `TrustServerCertificate=${parts["trustservercertificate"] || "false"}`,
  };

  return Object.values(map).join(";");
}

const adoNet = toAdoNet(url);
const name = url.match(/database=([^;]+)/i)?.[1];
if (!name) throw new Error("database ausente na URL");
if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error("Nome de banco inválido");

// Tenta conectar direto no banco alvo; se falhar, cria via master
let pool;
try {
  pool = await new sql.ConnectionPool(adoNet).connect();
} catch {
  console.log(`Banco "${name}" não encontrado. Criando via master...`);
  const masterAdoNet = adoNet.replace(/Database=[^;]+/i, "Database=master");
  const masterPool = await new sql.ConnectionPool(masterAdoNet).connect();
  await masterPool.request().query(`CREATE DATABASE [${name}]`);
  await masterPool.close();
  pool = await new sql.ConnectionPool(adoNet).connect();
  console.log(`Banco "${name}" criado.`);
}

// Garante db_owner
const user = url.match(/user=([^;]+)/i)?.[1];
if (user) {
  try {
    await pool.request().query(`ALTER ROLE db_owner ADD MEMBER [${user}]`);
    console.log(`Permissão db_owner concedida a "${user}".`);
  } catch {
    // Já tem permissão, ignorar
  }
}

// Droppa todas as tabelas, views, procedures e funções para começar limpo
await pool.request().query(`
  DECLARE @sql NVARCHAR(MAX) = N'';

  -- Remove foreign keys primeiro
  SELECT @sql += 'ALTER TABLE [' + OBJECT_SCHEMA_NAME(fk.parent_object_id) + '].[' + OBJECT_NAME(fk.parent_object_id) + '] DROP CONSTRAINT [' + fk.name + '];' + CHAR(10)
  FROM sys.foreign_keys fk;

  -- Drop tables
  SELECT @sql += 'DROP TABLE IF EXISTS [' + SCHEMA_NAME(schema_id) + '].[' + name + '];' + CHAR(10)
  FROM sys.tables;

  -- Drop views
  SELECT @sql += 'DROP VIEW IF EXISTS [' + SCHEMA_NAME(schema_id) + '].[' + name + '];' + CHAR(10)
  FROM sys.views;

  -- Drop procedures
  SELECT @sql += 'DROP PROCEDURE IF EXISTS [' + SCHEMA_NAME(schema_id) + '].[' + name + '];' + CHAR(10)
  FROM sys.procedures;

  EXEC sp_executesql @sql;
`);
await pool.close();

console.log("Banco limpo — todas as tabelas removidas.");
