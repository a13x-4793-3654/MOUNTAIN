// フロントが起動時にバックエンド /api/config から読む公開設定。
// 同一の web イメージを DF/本番で使い回し、差異はサーバの環境変数だけにする。

export interface RuntimeConfig {
  auth_enabled: boolean;
  entra: { tenant_id: string; client_id: string; api_scope: string };
  sip: { wss_url: string; realm: string; stun: string; prefixes: string };
  cti_provider: string;
  calendar: { enabled: boolean; name: string; unavailable_reason: string | null };
}

const FALLBACK: RuntimeConfig = {
  auth_enabled: false,
  entra: { tenant_id: "", client_id: "", api_scope: "" },
  sip: { wss_url: "", realm: "", stun: "", prefixes: "" },
  cti_provider: "simulator",
  calendar: {
    enabled: false,
    name: "",
    unavailable_reason: "予定登録は利用できません。管理者による Microsoft 365 グループの予定表設定と Microsoft 365 認証が必要です。",
  },
};

let _cfg: RuntimeConfig | null = null;

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (_cfg) return _cfg;
  try {
    const res = await fetch("/api/config", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`config ${res.status}`);
    const config = (await res.json()) as RuntimeConfig;
    const calendar = config.calendar;
    const enabled = config.auth_enabled === true && calendar?.enabled === true;
    _cfg = {
      ...config,
      calendar: {
        enabled,
        name: typeof calendar?.name === "string" ? calendar.name : "",
        unavailable_reason: enabled ? null
          : (typeof calendar?.unavailable_reason === "string" && calendar.unavailable_reason.trim())
            || FALLBACK.calendar.unavailable_reason,
      },
    };
  } catch {
    // 設定が取れない場合は認証なし（DF既定）で起動する。
    _cfg = FALLBACK;
  }
  return _cfg;
}

export function getRuntimeConfig(): RuntimeConfig {
  return _cfg ?? FALLBACK;
}
