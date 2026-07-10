import type { NextRequest } from "next/server";
import { resolveActor } from "@/server/auth/actor";
import { syncActorGrants } from "@/server/auth/sync-grants";
import { executeReadOnly } from "@/server/azure/sql";
import { ApiError, handleApiError } from "@/server/http";
import { prisma } from "@/server/db";
import { hashToken } from "@/server/security/crypto";
import type { Actor } from "@/server/auth/actor";

async function resolveODataActor(request: NextRequest): Promise<Actor> {
  // 1. Bearer token no header
  const auth = request.headers.get("authorization");
  if (auth?.match(/^Bearer\s+/i)) return resolveActor(request);

  // 2. Basic auth (usuário qualquer, senha = token) — Power BI Desktop
  const basic = auth?.match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) {
    const decoded = Buffer.from(basic, "base64").toString("utf-8");
    const colonIdx = decoded.indexOf(":");
    const password = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
    if (password) {
      const token = await prisma.apiToken.findUnique({ where: { tokenHash: hashToken(password) } });
      if (token?.active && !(token.expiresAt && token.expiresAt <= new Date())) {
        await prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
        return { type: "token", id: token.id, role: "TOKEN", principal: `cw_t_${token.id.replaceAll("-", "").slice(0, 24)}` };
      }
    }
  }

  // 3. Query param ?api_key=TOKEN — Power BI Service (autenticação Anônima + token na URL)
  const apiKey = request.nextUrl.searchParams.get("api_key");
  if (apiKey) {
    const token = await prisma.apiToken.findUnique({ where: { tokenHash: hashToken(apiKey) } });
    if (token?.active && !(token.expiresAt && token.expiresAt <= new Date())) {
      await prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
      return { type: "token", id: token.id, role: "TOKEN", principal: `cw_t_${token.id.replaceAll("-", "").slice(0, 24)}` };
    }
  }

  throw new ApiError(401, "UNAUTHENTICATED", "Autenticação necessária. Use Authorization: Bearer <token>, Basic auth ou ?api_key=<token>.");
}

function sqlToEdmType(sqlType: string): string {
  const t = sqlType.toUpperCase().replace(/\(.*\)/, "").trim();
  if (["NVARCHAR", "VARCHAR", "CHAR", "NCHAR", "TEXT", "NTEXT"].includes(t)) return "Edm.String";
  if (t === "BIGINT") return "Edm.Int64";
  if (["INT", "INTEGER", "SMALLINT", "TINYINT"].includes(t)) return "Edm.Int32";
  if (t === "BIT") return "Edm.Boolean";
  if (["DECIMAL", "NUMERIC", "MONEY", "SMALLMONEY"].includes(t)) return "Edm.Decimal";
  if (["FLOAT", "REAL"].includes(t)) return "Edm.Double";
  if (["DATETIME", "DATETIME2", "SMALLDATETIME", "DATETIMEOFFSET"].includes(t)) return "Edm.DateTimeOffset";
  if (t === "DATE") return "Edm.Date";
  if (t === "TIME") return "Edm.TimeOfDay";
  if (t === "UNIQUEIDENTIFIER") return "Edm.Guid";
  return "Edm.String";
}

function escXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Column = { sqlName: string; sqlType: string; nullable: boolean };
type Table = { sqlName: string; columns: Column[] };
type Dataset = { schemaName: string; tables: Table[] };

async function loadDataset(projectSlug: string, datasetSlug: string): Promise<Dataset> {
  const project = await prisma.project.findFirst({ where: { slug: projectSlug, active: true } });
  if (!project) throw new ApiError(404, "NOT_FOUND", "Projeto não encontrado");
  const dataset = await prisma.dataset.findFirst({
    where: { projectId: project.id, slug: datasetSlug, active: true },
    include: { tables: { include: { columns: { orderBy: { ordinal: "asc" } } } } },
  });
  if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset não encontrado");
  return dataset;
}

function buildServiceDocument(baseUrl: string, dataset: Dataset) {
  return {
    "@odata.context": `${baseUrl}/$metadata`,
    value: dataset.tables.map((t) => ({ name: t.sqlName, kind: "EntitySet", url: t.sqlName })),
  };
}

function buildMetadata(dataset: Dataset): string {
  const ns = "catworld";
  const entityTypes = dataset.tables
    .map((t) => {
      const props = t.columns
        .map((c) => `      <Property Name="${escXml(c.sqlName)}" Type="${sqlToEdmType(c.sqlType)}" Nullable="${c.nullable}"/>`)
        .join("\n");
      return `    <EntityType Name="${escXml(t.sqlName)}">
      <Key><PropertyRef Name="_row_number"/></Key>
      <Property Name="_row_number" Type="Edm.Int64" Nullable="false"/>
${props}
    </EntityType>`;
    })
    .join("\n");

  const entitySets = dataset.tables
    .map((t) => `      <EntitySet Name="${escXml(t.sqlName)}" EntityType="${ns}.${escXml(t.sqlName)}"/>`)
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="${ns}" xmlns="http://docs.oasis-open.org/odata/ns/edm">
${entityTypes}
      <EntityContainer Name="Container">
${entitySets}
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const actor = await resolveODataActor(request);
    const path = (await params).path ?? [];

    if (path.length < 2) throw new ApiError(400, "BAD_REQUEST", "URL inválida. Use /api/odata/{projeto}/{dataset}");

    const [projectSlug, datasetSlug, ...rest] = path;
    const dataset = await loadDataset(projectSlug!, datasetSlug!);

    await syncActorGrants(actor);

    const baseUrl = `${request.nextUrl.origin}/api/odata/${projectSlug}/${datasetSlug}`;

    if (rest.length === 0) {
      return Response.json(buildServiceDocument(baseUrl, dataset), { headers: { "OData-Version": "4.0" } });
    }

    if (rest[0] === "$metadata") {
      return new Response(buildMetadata(dataset), {
        headers: { "content-type": "application/xml; charset=utf-8", "OData-Version": "4.0" },
      });
    }

    const tableSqlName = rest[0]!;
    const table = dataset.tables.find((t) => t.sqlName === tableSqlName);
    if (!table) throw new ApiError(404, "NOT_FOUND", "Tabela não encontrada");

    const url = request.nextUrl;
    const rawTop = parseInt(url.searchParams.get("$top") ?? "1000", 10);
    const rawSkip = parseInt(url.searchParams.get("$skip") ?? "0", 10);
    const selectParam = url.searchParams.get("$select");
    const countParam = url.searchParams.get("$count");

    const top = Math.min(Math.max(1, isNaN(rawTop) ? 1000 : rawTop), 10_000);
    const skip = Math.max(0, isNaN(rawSkip) ? 0 : rawSkip);

    const cols = selectParam
      ? table.columns.filter((c) => selectParam.split(",").map((s) => s.trim()).includes(c.sqlName))
      : table.columns;
    if (cols.length === 0) throw new ApiError(400, "BAD_REQUEST", "Nenhuma coluna válida selecionada");

    const colList = cols.map((c) => `[${c.sqlName}]`).join(", ");
    const sql = `SELECT ${colList}, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) + ${skip} AS [_row_number] FROM [${dataset.schemaName}].[${table.sqlName}] ORDER BY (SELECT NULL) OFFSET ${skip} ROWS FETCH NEXT ${top} ROWS ONLY`;

    const result = await executeReadOnly(actor.principal, sql, 120, top, [dataset.schemaName]);

    const response: Record<string, unknown> = {
      "@odata.context": `${baseUrl}/$metadata#${table.sqlName}`,
      value: result.rows,
    };

    if (countParam === "true") {
      const countSql = `SELECT COUNT(*) AS [cnt] FROM [${dataset.schemaName}].[${table.sqlName}]`;
      const cr = await executeReadOnly(actor.principal, countSql, 30, 1, [dataset.schemaName]);
      response["@odata.count"] = Number((cr.rows[0] as Record<string, unknown>)?.cnt ?? 0);
    }

    if (result.rows.length === top) {
      const next = new URL(`${baseUrl}/${table.sqlName}`);
      next.searchParams.set("$top", String(top));
      next.searchParams.set("$skip", String(skip + top));
      if (selectParam) next.searchParams.set("$select", selectParam);
      if (countParam === "true") next.searchParams.set("$count", "true");
      response["@odata.nextLink"] = next.toString();
    }

    return Response.json(response, { headers: { "OData-Version": "4.0" } });
  } catch (e) {
    return handleApiError(e);
  }
}
