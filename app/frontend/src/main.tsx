import React from "react";
import ReactDOM from "react-dom/client";
import {
  FluentProvider,
  webLightTheme,
  Spinner,
} from "@fluentui/react-components";
import { BrowserRouter } from "react-router-dom";
import { MsalProvider } from "@azure/msal-react";
import App from "./App";
import { loadRuntimeConfig, getRuntimeConfig } from "./auth/runtimeConfig";
import { initMsal } from "./auth/msal";
import "./index.css";

// ブラウザの Web Crypto（crypto.subtle）は「安全なコンテキスト」= HTTPS か
// localhost でのみ使えます。Microsoft 365 ログイン（MSAL）はこれを必須とするため、
// 平文 http:// のホスト名アクセスでは初期化に失敗します。
function isSecureCtx(): boolean {
  try {
    return (
      (typeof window.isSecureContext === "boolean" ? window.isSecureContext : true) &&
      !!(window.crypto && window.crypto.subtle)
    );
  } catch {
    return false;
  }
}

function isLocalHost(): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
}

function renderMessage(root: ReactDOM.Root, title: string, detail: string, httpsUrl?: string) {
  root.render(
    <React.StrictMode>
      <FluentProvider theme={webLightTheme}>
        <div
          style={{
            display: "flex",
            height: "100vh",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <div style={{ maxWidth: 520 }}>
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>{title}</div>
            <div style={{ fontSize: 14, lineHeight: 1.7, color: "#444" }}>{detail}</div>
            {httpsUrl && (
              <div style={{ marginTop: 20 }}>
                <a
                  href={httpsUrl}
                  style={{
                    display: "inline-block",
                    padding: "10px 20px",
                    background: "#0f6cbd",
                    color: "#fff",
                    borderRadius: 6,
                    textDecoration: "none",
                    fontWeight: 600,
                  }}
                >
                  安全な接続（https）で開き直す
                </a>
              </div>
            )}
          </div>
        </div>
      </FluentProvider>
    </React.StrictMode>
  );
}

async function bootstrap() {
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  root.render(
    <React.StrictMode>
      <FluentProvider theme={webLightTheme}>
        <div
          style={{
            display: "flex",
            height: "100vh",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Spinner label="読み込み中…" />
        </div>
      </FluentProvider>
    </React.StrictMode>
  );

  await loadRuntimeConfig();

  // 平文 http:// のホスト名アクセスは Web Crypto が無く MSAL が動かないため、
  // 同一ホストの https:// へ自動的に開き直す（ポート番号は付けない＝標準 443）。
  const httpsUrl =
    "https://" +
    window.location.hostname +
    window.location.pathname +
    window.location.search +
    window.location.hash;
  if (!isSecureCtx() && !isLocalHost() && window.location.protocol === "http:") {
    window.location.replace(httpsUrl);
    return;
  }

  // MSAL は安全なコンテキストでのみ初期化する。失敗しても画面を固めない。
  let msal: Awaited<ReturnType<typeof initMsal>> | null = null;
  if (isSecureCtx()) {
    try {
      msal = await initMsal();
    } catch (e) {
      console.error("MSAL initialization failed:", e);
    }
  }

  const cfg = getRuntimeConfig();
  // 認証が必要なのに初期化できなかった場合は、原因（安全な接続が必要）を案内する。
  if (cfg.auth_enabled && !msal) {
    renderMessage(
      root,
      "安全な接続でアクセスしてください",
      "このシステムのログインには「https（安全な接続）」が必要です。お手数ですが、下のボタンから開き直してください。",
      httpsUrl
    );
    return;
  }

  root.render(
    <React.StrictMode>
      <FluentProvider theme={webLightTheme}>
        {msal ? (
          <MsalProvider instance={msal}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </MsalProvider>
        ) : (
          <BrowserRouter>
            <App />
          </BrowserRouter>
        )}
      </FluentProvider>
    </React.StrictMode>
  );
}

void bootstrap();
