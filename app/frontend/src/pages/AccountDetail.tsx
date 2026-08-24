import { ReactNode, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  makeStyles,
  tokens,
  Title3,
  Subtitle2,
  Badge,
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { ArrowLeft20Regular, Edit20Regular, Delete20Regular, Eye16Regular, EyeOff16Regular } from "@fluentui/react-icons";
import {
  fetchAccount,
  AccountDetail as Detail,
  updateAccount,
  deleteAccount,
  revealAccountNo,
  RevealResult,
} from "../api/client";
import { accountCategoryLabel, accountTypeLabel, boolLabel } from "../util/format";
import { useAuth } from "../auth/AuthContext";
import LinkedContracts from "../components/LinkedContracts";
import FormDialog from "../components/FormDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import { ACCOUNT_FIELDS, toAccountIn, accountToForm } from "../util/formSchemas";

const useStyles = makeStyles({
  topbar: { display: "flex", alignItems: "center", columnGap: "8px", marginBottom: "12px" },
  headCard: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "16px",
    marginBottom: "12px",
  },
  headRow: { display: "flex", alignItems: "center", columnGap: "12px", flexWrap: "wrap" },
  name: { fontWeight: 700 },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "16px",
    marginBottom: "12px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "160px 1fr",
    rowGap: "10px",
    columnGap: "12px",
    maxWidth: "760px",
  },
  label: { color: tokens.colorNeutralForeground3 },
  mono: { fontVariantNumeric: "tabular-nums" },
  section: { marginTop: "4px", marginBottom: "8px" },
});

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  const s = useStyles();
  return (
    <>
      <div className={s.label}>{label}</div>
      <div>{children}</div>
    </>
  );
}

export default function AccountDetail() {
  const s = useStyles();
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { can } = useAuth();
  const canReveal = can("action.sensitive.reveal");
  const [revealed, setRevealed] = useState<RevealResult | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealErr, setRevealErr] = useState<string | null>(null);

  function load() {
    if (!id) return;
    setLoading(true);
    setRevealed(null);
    setRevealErr(null);
    fetchAccount(id)
      .then((d) => setData(d))
      .catch((e) => setError(e?.message ?? "読み込みに失敗しました"))
      .finally(() => setLoading(false));
  }

  async function doReveal() {
    if (!id) return;
    setRevealing(true);
    setRevealErr(null);
    try {
      const r = await revealAccountNo(id);
      setRevealed(r);
    } catch (e) {
      setRevealErr((e as Error).message || "表示に失敗しました");
    } finally {
      setRevealing(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <Spinner label="読み込み中…" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>{error ?? "口座・カードが見つかりません"}</MessageBarBody>
      </MessageBar>
    );
  }

  const a = data.account;
  const isCredit = a.account_category === "credit";

  return (
    <div>
      <div className={s.topbar}>
        <Button
          appearance="subtle"
          icon={<ArrowLeft20Regular />}
          onClick={() => navigate("/accounts")}
        >
          口座・カード一覧へ戻る
        </Button>
        <div style={{ flexGrow: 1 }} />
        <Button icon={<Edit20Regular />} onClick={() => setEditOpen(true)}>
          編集
        </Button>
        <Button
          icon={<Delete20Regular />}
          appearance="subtle"
          onClick={() => setDeleteOpen(true)}
        >
          削除
        </Button>
      </div>

      <div className={s.headCard}>
        <div className={s.headRow}>
          <Title3 className={s.name}>
            {isCredit ? accountTypeLabel(a.account_type) : (a.bank_name ?? "（名称なし）")}
          </Title3>
          <Badge appearance="tint" color={isCredit ? "brand" : "informative"}>
            {accountCategoryLabel(a.account_category)}
          </Badge>
          <Badge appearance="outline" color={a.is_active ? "success" : "subtle"}>
            {a.is_active ? "有効" : "無効"}
          </Badge>
        </div>
        <div className={s.mono} style={{ marginTop: 6 }}>
          {a.account_no_masked ?? "—"}
        </div>
      </div>

      <div className={s.panel}>
        <Subtitle2 className={s.section}>基本情報</Subtitle2>
        <div className={s.grid}>
          <InfoRow label="区分">{accountCategoryLabel(a.account_category)}</InfoRow>
          <InfoRow label="種別">{accountTypeLabel(a.account_type)}</InfoRow>
          {!isCredit && <InfoRow label="銀行コード">{a.bank_code ?? "—"}</InfoRow>}
          {!isCredit && <InfoRow label="支店">{a.branch_name ?? "—"}</InfoRow>}
          {!isCredit && <InfoRow label="支店コード">{a.branch_code ?? "—"}</InfoRow>}
          <InfoRow label="番号">
            <div style={{ display: "flex", alignItems: "center", columnGap: 8, flexWrap: "wrap" }}>
              <span className={s.mono}>
                {revealed ? revealed.account_no : (a.account_no_masked ?? "—")}
              </span>
              {canReveal && !revealed && (
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Eye16Regular />}
                  disabled={revealing}
                  onClick={doReveal}
                >
                  {revealing ? "表示中…" : "実番号を表示"}
                </Button>
              )}
              {revealed && (
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<EyeOff16Regular />}
                  onClick={() => setRevealed(null)}
                >
                  隠す
                </Button>
              )}
            </div>
            {revealErr && (
              <div style={{ color: tokens.colorPaletteRedForeground1, fontSize: 12, marginTop: 4 }}>
                {revealErr}
              </div>
            )}
            {revealed && isCredit && (
              <div style={{ marginTop: 4, fontSize: 12, color: tokens.colorNeutralForeground3 }}>
                セキュリティコード：
                <span className={s.mono}>{revealed.cvv2 ?? "—"}</span>
              </div>
            )}
            {canReveal && (
              <div style={{ marginTop: 4, fontSize: 12, color: tokens.colorNeutralForeground3 }}>
                ※実番号の表示は監査ログに記録されます。
              </div>
            )}
          </InfoRow>
          <InfoRow label="名義（カナ）">{a.account_holder_kana ?? "—"}</InfoRow>
          {isCredit && (
            <InfoRow label="有効期限">
              <span className={s.mono}>{a.expiry_mm_yy ?? "—"}</span>
            </InfoRow>
          )}
          <InfoRow label="有効">{boolLabel(a.is_active)}</InfoRow>
        </div>
      </div>

      <div className={s.panel}>
        <Subtitle2 className={s.section}>関連する契約</Subtitle2>
        <LinkedContracts contracts={data.contracts} />
      </div>

      <FormDialog
        open={editOpen}
        title="口座・カードの編集"
        fields={ACCOUNT_FIELDS}
        initial={accountToForm(a)}
        onSubmit={async (v) => {
          await updateAccount(a.id, toAccountIn(v));
          load();
        }}
        onClose={() => setEditOpen(false)}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="口座・カードの削除"
        message={`「${a.bank_name ?? "この口座・カード"}」を削除します。よろしいですか？（契約に紐づいている場合は削除できません）`}
        onConfirm={async () => {
          await deleteAccount(a.id);
          navigate("/accounts");
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  );
}
