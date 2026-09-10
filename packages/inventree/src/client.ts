import { TOKEN_PATH } from "./token.ts";
import { normalizeList, recordId, type Page } from "./list.ts";

export { TOKEN_PATH } from "./token.ts";
export { normalizeList, recordId } from "./list.ts";

export type InventreeClientOptions = {
  baseUrl: string;
  token?: string;
  basic?: { username: string; password: string };
};

export class InventreeError extends Error {
  status: number;
  path: string;
  body: unknown;

  constructor(method: string, path: string, status: number, body: unknown, message?: string) {
    super(message ?? `${method} ${path} → ${status}`);
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export class TokenPathError extends InventreeError {
  constructor(status: number, body: unknown) {
    super(
      "GET",
      TOKEN_PATH,
      status,
      body,
      `Token path ${TOKEN_PATH} returned ${status}. That path is hard-configured from the M1 live probe. Do not guess /api/user/token/. Confirm this InvenTree still serves ${TOKEN_PATH}.`,
    );
    this.name = "TokenPathError";
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class InventreeClient {
  private csrfToken: string | null = null;
  private options: InventreeClientOptions;

  constructor(options: InventreeClientOptions) {
    this.options = options;
  }

  private authHeaders(): Record<string, string> {
    if (this.options.token) return { Authorization: `Token ${this.options.token}` };
    if (this.options.basic) {
      const { username, password } = this.options.basic;
      return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
    }
    return {};
  }

  private captureCsrf(res: Response) {
    const headers = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const raw = headers.length ? headers : [res.headers.get("set-cookie")].filter(Boolean);
    for (const header of raw) {
      const match = String(header).match(/csrftoken=([^;]+)/);
      if (match) this.csrfToken = decodeURIComponent(match[1]);
    }
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Referer: `${this.options.baseUrl.replace(/\/$/, "")}/`,
      Origin: this.options.baseUrl.replace(/\/$/, ""),
      ...this.authHeaders(),
    };
    if (this.csrfToken) {
      headers["X-CSRFToken"] = this.csrfToken;
      headers.Cookie = `csrftoken=${this.csrfToken}`;
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      this.captureCsrf(res);
      const data = parseJson(await res.text());
      if (res.status === 429 && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new InventreeError(method, path, res.status, data);
      return data as T;
    }
    throw new InventreeError(method, path, 429, null);
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body);
  }

  patch<T>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body);
  }

  delete<T = unknown>(path: string) {
    return this.request<T>("DELETE", path);
  }

  async getRaw(path: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = path.startsWith("http") ? path : `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = {
      Referer: `${this.options.baseUrl.replace(/\/$/, "")}/`,
      Origin: this.options.baseUrl.replace(/\/$/, ""),
      ...this.authHeaders(),
    };
    if (this.csrfToken) {
      headers["X-CSRFToken"] = this.csrfToken;
      headers.Cookie = `csrftoken=${this.csrfToken}`;
    }
    const res = await fetch(url, { method: "GET", headers });
    this.captureCsrf(res);
    if (!res.ok) {
      throw new InventreeError("GET", path, res.status, await res.text());
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") || "application/octet-stream",
    };
  }

  async postForm<T>(path: string, form: FormData): Promise<T> {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = {
      Referer: `${this.options.baseUrl.replace(/\/$/, "")}/`,
      Origin: this.options.baseUrl.replace(/\/$/, ""),
      ...this.authHeaders(),
    };
    if (this.csrfToken) {
      headers["X-CSRFToken"] = this.csrfToken;
      headers.Cookie = `csrftoken=${this.csrfToken}`;
    }
    const res = await fetch(url, { method: "POST", headers, body: form });
    this.captureCsrf(res);
    const data = parseJson(await res.text());
    if (!res.ok) throw new InventreeError("POST", path, res.status, data);
    return data as T;
  }

  async listAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = path.includes("?") ? `${path}&limit=200` : `${path}?limit=200`;
    while (next !== null) {
      const page: Page<T> = normalizeList<T>(await this.get<unknown>(next));
      items.push(...page.items);
      let following: string | null = page.next;
      if (following !== null && following.startsWith("http")) {
        const url = new URL(following);
        following = url.pathname + url.search;
      }
      next = following;
    }
    return items;
  }
}

export async function fetchToken(baseUrl: string, username: string, password: string): Promise<string> {
  const client = new InventreeClient({ baseUrl, basic: { username, password } });
  try {
    const body = await client.get<{ token?: string }>(TOKEN_PATH);
    if (typeof body.token !== "string" || !body.token) {
      throw new Error(
        `Token path ${TOKEN_PATH} responded ${JSON.stringify(body)} without a token field. Do not guess another path.`,
      );
    }
    return body.token;
  } catch (err) {
    if (err instanceof TokenPathError) throw err;
    if (err instanceof InventreeError && err.status === 404) throw new TokenPathError(404, err.body);
    throw err;
  }
}
