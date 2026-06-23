const forbidden = new Set(["alter", "create", "delete", "deny", "drop", "exec", "execute", "grant", "insert", "merge", "reconfigure", "revoke", "truncate", "update", "use"]);

export type SqlValidation = { safe: true; statement: string } | { safe: false; reason: string };

export function validateReadOnlySql(input: string): SqlValidation {
  if (!input.trim()) return { safe: false, reason: "Consulta vazia" };
  if (input.length > 50_000) return { safe: false, reason: "Consulta excede 50.000 caracteres" };
  const cleaned = stripCommentsAndStrings(input);
  const statements = cleaned.split(";").map((part) => part.trim()).filter(Boolean);
  if (statements.length !== 1) return { safe: false, reason: "Apenas uma instrução SQL é permitida" };
  const tokens = statements[0].toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  if (!tokens.length || !["select", "with"].includes(tokens[0]!)) return { safe: false, reason: "Somente SELECT ou WITH são permitidos" };
  const blocked = tokens.find((token) => forbidden.has(token));
  if (blocked) return { safe: false, reason: `Comando bloqueado: ${blocked.toUpperCase()}` };
  return { safe: true, statement: input.trim().replace(/;+\s*$/, "") };
}

function stripCommentsAndStrings(sql: string): string {
  let out = "", i = 0, state: "normal" | "single" | "double" | "line" | "block" = "normal";
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (state === "normal") {
      if (c === "'" ) { state = "single"; out += " "; }
      else if (c === '"') { state = "double"; out += " "; }
      else if (c === "-" && n === "-") { state = "line"; out += "  "; i++; }
      else if (c === "/" && n === "*") { state = "block"; out += "  "; i++; }
      else out += c;
    } else if (state === "single") {
      if (c === "'" && n === "'") { out += "  "; i++; }
      else if (c === "'") { state = "normal"; out += " "; }
      else out += c === "\n" ? "\n" : " ";
    } else if (state === "double") {
      if (c === '"') state = "normal";
      out += c === "\n" ? "\n" : " ";
    } else if (state === "line") {
      if (c === "\n") { state = "normal"; out += "\n"; } else out += " ";
    } else {
      if (c === "*" && n === "/") { state = "normal"; out += "  "; i++; } else out += c === "\n" ? "\n" : " ";
    }
    i++;
  }
  return out;
}