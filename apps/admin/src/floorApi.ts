/** Base URL for inventoryobi Netlify functions (laptop / direct). */
const REMOTE = (import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');

/**
 * Resolve a Floor function URL.
 * On the admin portal host, use the same-origin `/api/floor/*` proxy so the
 * store phone lockdown (admin.openboxindustries.com only) can still look up UPCs.
 */
export function floorFunctionUrl(name: string): string {
  const path = name.replace(/^\//, '').replace(/^\/?\.netlify\/functions\//, '');
  if (typeof location !== 'undefined' && /(^|\.)admin\.openboxindustries\.com$/i.test(location.hostname)) {
    return `/api/floor/${path}`;
  }
  return `${REMOTE}/.netlify/functions/${path}`;
}

export function floorFunctionsBase(): string {
  if (typeof location !== 'undefined' && /(^|\.)admin\.openboxindustries\.com$/i.test(location.hostname)) {
    return `${location.origin}/api/floor`;
  }
  return `${REMOTE}/.netlify/functions`;
}
