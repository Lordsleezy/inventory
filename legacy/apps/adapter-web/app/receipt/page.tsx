"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function RedirectToReports() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const sale = params.get("sale");
    router.replace(sale ? `/reports` : "/reports");
  }, [params, router]);
  return <p className="p-6 text-body text-floor-mute">Receipts are on Reports.</p>;
}

export default function ReceiptPage() {
  return (
    <Suspense>
      <RedirectToReports />
    </Suspense>
  );
}
