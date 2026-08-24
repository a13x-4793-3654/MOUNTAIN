// ログイン中のユーザー情報（/api/auth/me）を全画面へ供給する。
// CTI 内線番号/パスワードもここで受け取り、後段のソフトフォン自動登録に使う。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Spinner,
} from "@fluentui/react-components";
import { ArrowClockwise24Regular } from "@fluentui/react-icons";
import { getJson, sendJson } from "../api/client";

export interface Me {
  id: string;
  display_name: string;
  user_principal_name: string;
  mail: string | null;
  status: number;
  is_admin: boolean;
  roles?: string[];
  permissions?: string[];
  cti_ext_num: string | null;
  cti_password: string | null;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** 画面アクセス権/操作権を持つか（管理者は常に true）。 */
  can: (perm: string) => boolean;
}

const useStyles = makeStyles({
  wrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "14px",
    minHeight: "100vh",
    padding: "32px",
    textAlign: "center",
    color: tokens.colorNeutralForeground2,
  },
  actions: { display: "flex", gap: "10px", marginTop: "6px" },
});

const Ctx = createContext<AuthState>({
  me: null,
  loading: true,
  error: null,
  reload: async () => {},
  can: () => false,
});

// サインイン情報の取得に失敗したときの案内画面。
// 「権限がありません」と誤解させず、その場で復帰（再読み込み）できるようにする。
function AuthErrorScreen({ onRetry }: { onRetry: () => void }) {
  const s = useStyles();
  return (
    <div className={s.wrap}>
      <Text as="h2" size={600} weight="semibold">
        サインイン情報を確認できませんでした
      </Text>
      <Text>
        通信が一時的に不安定だった可能性があります。下のボタンで再読み込みしてください。
        それでも改善しない場合は、一度サインアウトしてから、もう一度サインインしてください。
      </Text>
      <div className={s.actions}>
        <Button appearance="primary" icon={<ArrowClockwise24Regular />} onClick={onRetry}>
          再読み込み
        </Button>
        <Button appearance="secondary" onClick={() => window.location.reload()}>
          画面を再読み込み
        </Button>
      </div>
    </div>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const s = useStyles();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    // サインイン直後や更新（再起動）直後は、ブラウザ側のトークン準備が
    // 一瞬間に合わず /auth/me が 401 になることがある。1回きりの取得だと
    // その瞬間に当たった利用者が「権限なし」で固まってしまうため、
    // 短い間隔で数回だけ自動的に取得し直す（大半はここで復帰する）。
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const m = await getJson<Me>("/api/auth/me");
        setMe(m);
        setError(null);
        // 初回サインインの記録（失敗しても致命的ではない）
        try {
          await sendJson("POST", "/api/auth/login");
        } catch {
          /* ignore */
        }
        setLoading(false);
        return;
      } catch (e) {
        if (attempt === maxAttempts) {
          setError((e as Error).message);
        } else {
          await new Promise((r) => setTimeout(r, attempt * 800));
        }
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const can = useCallback(
    (perm: string) =>
      !!me && (me.is_admin || (me.permissions?.includes(perm) ?? false)),
    [me],
  );

  return (
    <Ctx.Provider value={{ me, loading, error, reload, can }}>
      {error && !me ? (
        loading ? (
          <div className={s.wrap}>
            <Spinner label="読み込み中…" />
          </div>
        ) : (
          <AuthErrorScreen onRetry={() => void reload()} />
        )
      ) : (
        children
      )}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(Ctx);
}
