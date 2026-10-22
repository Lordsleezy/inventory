import { authErrorMessage } from '@floor/cloud';

/** Never returns "[object Object]". Prefer this over String(e) / e.message alone. */
export function errText(err: unknown): string {
  return authErrorMessage(err);
}
