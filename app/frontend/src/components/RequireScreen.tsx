// 画面アクセス権（RBAC）による表示ガード。
// 権限が無い利用者には、クラッシュさせずに分かりやすい日本語の案内を表示する。
import { ReactNode } from "react";
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import { LockClosed24Regular } from "@fluentui/react-icons";
import { useAuth } from "../auth/AuthContext";

const useStyles = makeStyles({
  wrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "12px",
    maxWidth: "560px",
    margin: "64px auto",
    padding: "32px",
    textAlign: "center",
    color: tokens.colorNeutralForeground2,
  },
  icon: { color: tokens.colorNeutralForeground3 },
});

export default function RequireScreen({
  perm,
  adminOnly,
  children,
}: {
  perm?: string | string[];
  adminOnly?: boolean;
  children: ReactNode;
}) {
  const s = useStyles();
  const { me, can, loading } = useAuth();

  if (loading) return null;

  const allowed = adminOnly
    ? !!me?.is_admin
    : !perm
      ? true
      : (Array.isArray(perm) ? perm : [perm]).some((p) => can(p));

  if (allowed) return <>{children}</>;

  return (
    <div className={s.wrap}>
      <LockClosed24Regular className={s.icon} />
      <Text as="h2" size={600} weight="semibold">
        この画面を表示する権限がありません
      </Text>
      <Text>
        表示に必要な権限が割り当てられていません。ご利用が必要な場合は、システム管理者にロール（権限）の割り当てをご依頼ください。
      </Text>
    </div>
  );
}
