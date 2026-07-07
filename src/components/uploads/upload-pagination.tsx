"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

export function UploadPagination({ page, totalPages }: { page: number; totalPages: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const goTo = (p: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(p));
    router.push(`${pathname}?${params.toString()}`);
  };

  const pages = Array.from({ length: totalPages }, (_, i) => i + 1).filter(
    (p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2,
  );

  return (
    <div className="join">
      <button className="join-item btn btn-sm" disabled={page <= 1} onClick={() => goTo(page - 1)}>
        «
      </button>
      {pages.flatMap((p, i) => {
        const prev = pages[i - 1];
        const items = [];
        if (prev && p - prev > 1) {
          items.push(
            <button key={`ellipsis-${p}`} className="join-item btn btn-sm btn-disabled">…</button>,
          );
        }
        items.push(
          <button
            key={p}
            className={`join-item btn btn-sm ${p === page ? "btn-active" : ""}`}
            onClick={() => goTo(p)}
          >
            {p}
          </button>,
        );
        return items;
      })}
      <button className="join-item btn btn-sm" disabled={page >= totalPages} onClick={() => goTo(page + 1)}>
        »
      </button>
    </div>
  );
}
