"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

interface Dataset { id: string; name: string }

interface Props {
  datasets: Dataset[];
  currentStatus: string;
  currentDatasetId: string;
  statusLabels: Record<string, string>;
}

export function UploadFilters({ datasets, currentStatus, currentDatasetId, statusLabels }: Props) {
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
        value={currentDatasetId}
        onChange={(e) => update("datasetId", e.target.value)}
      >
        <option value="">Todos os datasets</option>
        {datasets.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>

      {(currentStatus || currentDatasetId) && (
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            const params = new URLSearchParams();
            router.push(pathname + (params.toString() ? `?${params}` : ""));
          }}
        >
          Limpar filtros
        </button>
      )}
    </div>
  );
}
