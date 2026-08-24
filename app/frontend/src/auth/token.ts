// API 呼び出し用のアクセストークンを取得する。
// 認証が無効（DF既定）の場合は null を返し、Authorization ヘッダを付けない。
import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { getRuntimeConfig } from "./runtimeConfig";
import { getMsal, apiTokenRequest } from "./msal";

export async function acquireApiToken(): Promise<string | null> {
  const cfg = getRuntimeConfig();
  if (!cfg.auth_enabled || !cfg.entra.api_scope) return null;
  const msal = getMsal();
  if (!msal) return null;
  const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0];
  if (!account) return null;
  try {
    const r = await msal.acquireTokenSilent({ ...apiTokenRequest(), account });
    return r.accessToken;
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) {
      try {
        const r = await msal.acquireTokenPopup(apiTokenRequest());
        return r.accessToken;
      } catch {
        return null;
      }
    }
    return null;
  }
}
