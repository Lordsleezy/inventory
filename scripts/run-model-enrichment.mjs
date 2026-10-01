// One-off catch-up. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE in the process environment.
import handler from "../netlify/functions/enrich-models.mjs";

for (let batch = 0; batch < 100; batch += 1) {
  const response = await handler();
  const { results } = await response.json();
  if (!results?.length) break;
  for (const result of results) console.log(`${result.model}: ${result.status}`);
}
