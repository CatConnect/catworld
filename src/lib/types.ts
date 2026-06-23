export type Status = "healthy" | "warning" | "error" | "inactive";
export type Permission = "Leitura" | "Escrita" | "Administração";

export interface Column {
  name: string;
  originalName: string;
  type: string;
  nullable: boolean;
  description?: string;
}

export interface DataTable {
  slug: string;
  name: string;
  rows: number;
  size: string;
  updatedAt: string;
  columns: Column[];
  preview: Record<string, string | number | null>[];
}

export interface Dataset {
  slug: string;
  name: string;
  description: string;
  owner: string;
  status: Status;
  size: string;
  updatedAt: string;
  tables: DataTable[];
}

export interface Project {
  slug: string;
  name: string;
  description: string;
  owner: string;
  color: string;
  updatedAt: string;
  datasets: Dataset[];
}

export interface Token {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  permission: Permission;
  lastUsed: string;
  expiresAt: string;
  status: Status;
}

export interface DatabaseUser {
  id: string;
  name: string;
  kind: "Power BI" | "Aplicação" | "Analista";
  scope: string;
  permission: Permission;
  lastUsed: string;
  status: Status;
}

export interface AzureConnection {
  id: string;
  name: string;
  environment: "Produção" | "Homologação" | "Desenvolvimento";
  server: string;
  database: string;
  username: string;
  status: Status;
  latency: number | null;
  lastChecked: string;
}
