import { isGuid, type ContractSearchConfig } from "./config.js";

export const CONTRACT_RESULT_LIMIT = 5;
export const CONTRACT_QUERY_LIMIT = 200;
const RESPONSE_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT = 10_000;

export type MountainErrorCode =
  | "unauthorized" | "forbidden" | "timeout" | "unavailable"
  | "invalid_response" | "unsafe_configuration";

export class MountainApiError extends Error {
  constructor(readonly code: MountainErrorCode) {
    super(`MOUNTAIN API request failed: ${code}`);
    this.name = "MountainApiError";
  }
}

export interface ContractSummary {
  id: string;
  contractNo: string;
  summary: string | null;
  companyName: string | null;
  personName: string | null;
  status: string;
}

export interface ContractSearchResult {
  total: number;
  items: ContractSummary[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function validateContractQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed || Array.from(trimmed).length > CONTRACT_QUERY_LIMIT) {
    throw new RangeError(`Contract search requires 1-${CONTRACT_QUERY_LIMIT} characters.`);
  }
  return trimmed;
}

function assertTokenIdentity(token: string, tenantId: string, userObjectId: string): void {
  if (!isGuid(userObjectId)) {
    throw new MountainApiError("unauthorized");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new MountainApiError("unauthorized");
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new MountainApiError("unauthorized");
  }
  // This only restricts identity; the MOUNTAIN API verifies the signature and RBAC.
  if (!record(claims) || !isGuid(claims.oid) || !isGuid(claims.tid) ||
      claims.oid.toLowerCase() !== userObjectId.toLowerCase() ||
      claims.tid.toLowerCase() !== tenantId.toLowerCase() ||
      typeof claims.scp !== "string" || !claims.scp.trim()) {
    throw new MountainApiError("unauthorized");
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
      !response.body) {
    throw new MountainApiError("invalid_response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new MountainApiError("invalid_response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new MountainApiError("invalid_response");
  }
}

export class MountainContractsClient {
  constructor(
    private readonly config: ContractSearchConfig,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  async search(query: string, userToken: string, userObjectId: string): Promise<ContractSearchResult> {
    const term = validateContractQuery(query);
    assertTokenIdentity(userToken, this.config.tenantId, userObjectId);
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT);
    const get = async (path: string, token?: string): Promise<unknown> => {
      const url = new URL(path, this.config.apiBaseUrl);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: "GET",
          redirect: "error",
          signal,
          headers: {
            Accept: "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
      } catch (error) {
        if (signal.aborted) throw new MountainApiError("timeout");
        if (error instanceof TypeError) throw new MountainApiError("unavailable");
        throw error;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (token && response.status === 401) throw new MountainApiError("unauthorized");
        if (token && response.status === 403) throw new MountainApiError("forbidden");
        throw new MountainApiError("unavailable");
      }
      try {
        return await readJson(response);
      } catch (error) {
        if (signal.aborted) throw new MountainApiError("timeout");
        if (error instanceof TypeError) throw new MountainApiError("unavailable");
        throw error;
      }
    };

    const publicConfig = await get("/api/config");
    if (!record(publicConfig) || publicConfig.auth_enabled !== true ||
        !record(publicConfig.entra) || !isGuid(publicConfig.entra.tenant_id) ||
        publicConfig.entra.tenant_id.toLowerCase() !== this.config.tenantId.toLowerCase()) {
      throw new MountainApiError("unsafe_configuration");
    }
    const params = new URLSearchParams({ q: term, limit: String(CONTRACT_RESULT_LIMIT), offset: "0" });
    const result = await get(`/api/contracts?${params}`, userToken);
    if (!record(result) || typeof result.total !== "number" ||
        !Number.isSafeInteger(result.total) || result.total < 0 ||
        !Array.isArray(result.items) || result.items.length > CONTRACT_RESULT_LIMIT ||
        result.items.length > result.total || (result.total > 0 && result.items.length === 0)) {
      throw new MountainApiError("invalid_response");
    }
    const items: ContractSummary[] = result.items.map((item: unknown) => {
      if (!record(item) || !isGuid(item.id) || typeof item.contract_no !== "string" ||
          !nullableText(item.contract_summary) || !nullableText(item.company_name) ||
          !nullableText(item.person_name) || typeof item.contract_status !== "string" ||
          !nullableText(item.status_label)) {
        throw new MountainApiError("invalid_response");
      }
      return {
        id: item.id,
        contractNo: item.contract_no,
        summary: item.contract_summary,
        companyName: item.company_name,
        personName: item.person_name,
        status: item.status_label || item.contract_status,
      };
    });
    return { total: result.total, items };
  }

  format(result: ContractSearchResult): string {
    if (result.total === 0) return "該当する契約はありませんでした。";
    const text = (value: string | null, limit = 100): string =>
      Array.from((value ?? "—").replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, limit).join("");
    const lines = [`契約検索: ${result.total} 件中 ${result.items.length} 件を表示`];
    for (const [index, item] of result.items.entries()) {
      lines.push(
        "",
        `${index + 1}. ${text(item.contractNo, 64)} / ${text(item.summary, 120)}`,
        `会社: ${text(item.companyName)} / 契約者: ${text(item.personName)}`,
        `状態: ${text(item.status, 50)}`,
        new URL(`/contracts/${encodeURIComponent(item.id)}`, this.config.apiBaseUrl).href,
      );
    }
    if (result.total > result.items.length) {
      lines.push("", "残りの契約は MOUNTAIN の契約一覧で検索してください。",
        new URL("/contracts", this.config.apiBaseUrl).href);
    }
    return lines.join("\n");
  }
}
