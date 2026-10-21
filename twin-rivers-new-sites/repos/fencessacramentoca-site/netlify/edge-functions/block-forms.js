export default async (request) => {
  if (request.method !== "POST") return;
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/.netlify/") || pathname.startsWith("/admin/")) return;
  const lead = request.headers.get("x-fence-lead") || "";
  const city = request.headers.get("x-fence-city") || "";
  if (lead === "1" || city) return;
  return new Response("Verification failed.", {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
};
