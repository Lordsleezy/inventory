/** Netlify CLI transport errors may serialize request authorization headers. */
export function safeNetlifyOutput(value) {
  return String(value || '')
    .replace(/nfp_[A-Za-z0-9_-]+/g, '[REDACTED_NETLIFY_TOKEN]')
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/("(?:access_token|refresh_token|authorization)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2');
}
