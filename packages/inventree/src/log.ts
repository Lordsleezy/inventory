export function floorLog(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), src: "floor", event, ...fields }));
}
