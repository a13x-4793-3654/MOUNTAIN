// Microsoft 365 サインイン画面（認証が有効な場合のみ表示）。
import { useState } from "react";
import {
  Button,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useMsal } from "@azure/msal-react";
import Logo from "../components/Logo";
import { loginRequest } from "../auth/msal";

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    rowGap: "16px",
    padding: "40px 48px",
    borderRadius: "12px",
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
    minWidth: "320px",
  },
  brand: { fontWeight: 700, fontSize: "22px", letterSpacing: "0.5px" },
  sub: { color: tokens.colorNeutralForeground3, fontSize: "13px" },
  err: { color: tokens.colorPaletteRedForeground1, fontSize: "12px" },
});

export default function LoginPage() {
  const s = useStyles();
  const { instance } = useMsal();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const signIn = async () => {
    setBusy(true);
    setErr(null);
    try {
      await instance.loginPopup(loginRequest());
    } catch (e) {
      setErr("サインインに失敗しました。もう一度お試しください。");
      void e;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.root}>
      <div className={s.card}>
        <Logo size={48} />
        <span className={s.brand}>MOUNTAIN</span>
        <Text className={s.sub}>債権・家計管理システム</Text>
        {busy ? (
          <Spinner label="サインインしています…" />
        ) : (
          <Button appearance="primary" size="large" onClick={signIn}>
            Microsoft 365 でサインイン
          </Button>
        )}
        {err && <Text className={s.err}>{err}</Text>}
        <Text className={s.sub}>会社のアカウントでログインしてください</Text>
      </div>
    </div>
  );
}
