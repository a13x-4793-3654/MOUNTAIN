// MSAL（Microsoft 365 ログイン）の初期化とスコープ定義。
// 設定は起動時に /api/config から取得（runtimeConfig）。未設定なら
// ダミー値で初期化だけ行い、ログイン要求は AuthGate 側で auth_enabled により制御する。
import {
  Configuration,
  PublicClientApplication,
  RedirectRequest,
  SilentRequest,
} from "@azure/msal-browser";
import { getRuntimeConfig } from "./runtimeConfig";

const FALLBACK_GUID = "00000000-0000-0000-0000-000000000000";

let _msal: PublicClientApplication | null = null;

function origin(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

export async function initMsal(): Promise<PublicClientApplication> {
  if (_msal) return _msal;
  const cfg = getRuntimeConfig();
  const clientId = cfg.entra.client_id || FALLBACK_GUID;
  const tenantId = cfg.entra.tenant_id || FALLBACK_GUID;
  const msalConfig: Configuration = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      redirectUri: origin(),
      postLogoutRedirectUri: origin(),
      navigateToLoginRequestUrl: false,
    },
    cache: {
      cacheLocation: "sessionStorage",
      storeAuthStateInCookie: false,
    },
  };
  _msal = new PublicClientApplication(msalConfig);
  await _msal.initialize();
  const accounts = _msal.getAllAccounts();
  if (accounts.length > 0 && !_msal.getActiveAccount()) {
    _msal.setActiveAccount(accounts[0]);
  }
  return _msal;
}

export function getMsal(): PublicClientApplication | null {
  return _msal;
}

export function loginRequest(): RedirectRequest {
  const cfg = getRuntimeConfig();
  const scopes = ["openid", "profile", "offline_access"];
  if (cfg.entra.api_scope) scopes.push(cfg.entra.api_scope);
  return { scopes };
}

export function apiTokenRequest(): SilentRequest {
  const cfg = getRuntimeConfig();
  return { scopes: cfg.entra.api_scope ? [cfg.entra.api_scope] : [] };
}
