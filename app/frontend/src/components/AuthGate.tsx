// 認証が有効なときだけログインを要求する門番。
// 未サインインなら LoginPage、サインイン済みなら本体（AuthProvider配下）を表示。
import { ReactNode } from "react";
import { useIsAuthenticated } from "@azure/msal-react";
import { getRuntimeConfig } from "../auth/runtimeConfig";
import { AuthProvider } from "../auth/AuthContext";
import LoginPage from "../pages/LoginPage";

export default function AuthGate({ children }: { children: ReactNode }) {
  const cfg = getRuntimeConfig();
  const isAuthenticated = useIsAuthenticated();

  // 認証無効（DF既定）：ログイン不要でそのまま表示。既定ユーザーで /me が返る。
  if (!cfg.auth_enabled) {
    return <AuthProvider>{children}</AuthProvider>;
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }
  return <AuthProvider>{children}</AuthProvider>;
}
