// フロントが起動時にバックエンド /api/config から読む公開設定。
// 同一の web イメージを DF/本番で使い回し、差異はサーバの環境変数だけにする。

export interface RuntimeConfig {
  auth_enabled: boolean;
  entra: { tenant_id: string; client_id: string; api_scope: string };
  sip: { wss_url: string; realm: string; stun: string; prefixes: string };
  cti_provider: string;
}

const FALLBACK: RuntimeConfig = {
  auth_enabled: false,
  entra: { tenant_id: "", client_id: "", api_scope: "" },
  sip: { wss_url: "", realm: "", stun: "", prefixes: "" },
  cti_provider: "simulator",
};

let _cfg: RuntimeConfig | null = null;

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (_cfg) return _cfg;
  try {
    const res = await fetch("/api/config", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`config ${res.status}`);
    _cfg = (await res.json()) as RuntimeConfig;
  } catch {
    // 設定が取れない場合は認証なし（DF既定）で起動する。
    _cfg = FALLBACK;
  }
  return _cfg;
}

export function getRuntimeConfig(): RuntimeConfig {
  return _cfg ?? FALLBACK;
}
