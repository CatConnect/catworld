"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

interface Project { id: string; name: string }

interface Props {
  projects: Project[];
  currentStatus: string;
  currentProjectId: string;
  statusLabels: Record<string, string>;
}

export function UploadFilters({ projects, currentStatus, currentProjectId, statusLabels }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const update = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      params.delete("page");
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams],
  );

  const hasFilter = currentStatus || currentProjectId;

  return (
    <div className="flex flex-wrap gap-2">
      <select
        className="select select-sm select-bordered w-auto"
        value={currentStatus}
        onChange={(e) => update("status", e.target.value)}
      >
        <option value="">Todos os status</option>
        {Object.entries(statusLabels).map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>

      <select
        className="select select-sm select-bordered w-auto"
        value={currentProjectId}
        onChange={(e) => update("projectId", e.target.value)}
      >
        <option value="">Todos os projetos</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>

      {hasFilter && (
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => router.push(pathname)}
        >
          Limpar filtros
        </button>
      )}
    </div>
  );
}
