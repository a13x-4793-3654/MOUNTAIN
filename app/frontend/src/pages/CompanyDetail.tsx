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
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
} from "@fluentui/react-components";
import {
  ArrowLeft20Regular,
  Edit20Regular,
  Delete20Regular,
  Add20Regular,
  Edit16Regular,
  Delete16Regular,
} from "@fluentui/react-icons";
import {
  fetchCompany,
  CompanyDetail as Detail,
  CompanyPhone,
  updateCompany,
  deleteCompany,
  createCompanyPhone,
  updateCompanyPhone,
  deleteCompanyPhone,
} from "../api/client";
import { companyStatusLabel, companyStatusAppearance, phoneTypeLabel } from "../util/format";
import LinkedContracts from "../components/LinkedContracts";
import FormDialog, { FormField } from "../components/FormDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import { COMPANY_FIELDS, toCompanyIn, companyToForm } from "../util/formSchemas";

const PHONE_FIELDS: FormField[] = [
  { key: "phone_number", label: "電話番号", required: true, placeholder: "03-1234-5678" },
  {
    key: "phone_type",
    label: "種別",
    type: "select",
    options: [
      { value: "main", label: "代表" },
      { value: "direct", label: "直通" },
      { value: "fax", label: "FAX" },
      { value: "mobile", label: "携帯" },
      { value: "other", label: "その他" },
    ],
  },
  { key: "is_primary", label: "代表番号にする", type: "switch" },
];

// 会社編集ダイアログでは電話番号は「電話番号」パネルで管理するため除外
const COMPANY_EDIT_FIELDS: FormField[] = COMPANY_FIELDS.filter((f) => f.key !== "phone");

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

export default function CompanyDetail() {
  const s = useStyles();
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [phoneDlg, setPhoneDlg] = useState<{ mode: "add" | "edit"; phone?: CompanyPhone } | null>(null);
  const [phoneDelCtx, setPhoneDelCtx] = useState<CompanyPhone | null>(null);

  function load() {
    if (!id) return;
    setLoading(true);
    fetchCompany(id)
      .then((d) => setData(d))
      .catch((e) => setError(e?.message ?? "読み込みに失敗しました"))
      .finally(() => setLoading(false));
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
        <MessageBarBody>{error ?? "会社が見つかりません"}</MessageBarBody>
      </MessageBar>
    );
  }

  const co = data.company;
  const addr =
    (co.prefecture ?? "") + (co.city ?? "") + (co.address1 ?? "") + (co.address2 ?? "");

  return (
    <div>
      <div className={s.topbar}>
        <Button
          appearance="subtle"
          icon={<ArrowLeft20Regular />}
          onClick={() => navigate("/companies")}
        >
          会社一覧へ戻る
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
          <Title3 className={s.name}>{co.company_name}</Title3>
          <Badge appearance="tint" color={companyStatusAppearance(co.status_flag)}>
            {companyStatusLabel(co.status_flag)}
          </Badge>
        </div>
        {co.company_name_kana && (
          <div className={s.label} style={{ marginTop: 4 }}>
            {co.company_name_kana}
          </div>
        )}
      </div>

      <div className={s.panel}>
        <Subtitle2 className={s.section}>基本情報</Subtitle2>
        <div className={s.grid}>
          <InfoRow label="法人番号">{co.corporate_number ?? "—"}</InfoRow>
          <InfoRow label="郵便番号">{co.postal_code ?? "—"}</InfoRow>
          <InfoRow label="所在地">{addr || "—"}</InfoRow>
          <InfoRow label="代表電話">
            {(() => {
              const primary = data.phones.find((p) => p.is_primary) ?? data.phones[0];
              return primary ? primary.phone_number : "—";
            })()}
          </InfoRow>
          <InfoRow label="取引状態">{companyStatusLabel(co.status_flag)}</InfoRow>
          {co.status_reason && <InfoRow label="状態理由">{co.status_reason}</InfoRow>}
        </div>
      </div>

      <div className={s.panel}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <Subtitle2 className={s.section}>電話番号</Subtitle2>
          <div style={{ flexGrow: 1 }} />
          <Button
            size="small"
            icon={<Add20Regular />}
            appearance="primary"
            onClick={() => setPhoneDlg({ mode: "add" })}
          >
            電話番号を追加
          </Button>
        </div>
        <Table aria-label="電話番号" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>電話番号</TableHeaderCell>
              <TableHeaderCell>種別</TableHeaderCell>
              <TableHeaderCell>代表</TableHeaderCell>
              <TableHeaderCell>操作</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.phones.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.phone_number}</TableCell>
                <TableCell>{phoneTypeLabel(p.phone_type)}</TableCell>
                <TableCell>
                  {p.is_primary ? <Badge appearance="tint" color="brand">代表</Badge> : "—"}
                </TableCell>
                <TableCell>
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<Edit16Regular />}
                    onClick={() => setPhoneDlg({ mode: "edit", phone: p })}
                  >
                    編集
                  </Button>
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<Delete16Regular />}
                    onClick={() => setPhoneDelCtx(p)}
                  >
                    削除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {data.phones.length === 0 && (
              <TableRow>
                <TableCell colSpan={4}>登録された電話番号はありません。</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className={s.panel}>
        <Subtitle2 className={s.section}>関連する契約</Subtitle2>
        <LinkedContracts contracts={data.contracts} />
      </div>

      <FormDialog
        open={editOpen}
        title="会社情報の編集"
        fields={COMPANY_EDIT_FIELDS}
        initial={companyToForm(
          co,
          data.phones.find((p) => p.is_primary)?.phone_number ??
            data.phones[0]?.phone_number ??
            null
        )}
        onSubmit={async (v) => {
          await updateCompany(co.id, toCompanyIn(v));
          setEditOpen(false);
          load();
        }}
        onClose={() => setEditOpen(false)}
      />
      {phoneDlg && (
        <FormDialog
          open={!!phoneDlg}
          title={phoneDlg.mode === "add" ? "電話番号を追加" : "電話番号を編集"}
          fields={PHONE_FIELDS}
          initial={
            phoneDlg.mode === "edit" && phoneDlg.phone
              ? {
                  phone_number: phoneDlg.phone.phone_number ?? "",
                  phone_type: phoneDlg.phone.phone_type ?? "main",
                  is_primary: phoneDlg.phone.is_primary === true,
                }
              : { phone_type: "main", is_primary: false }
          }
          submitLabel={phoneDlg.mode === "add" ? "追加する" : "保存する"}
          onSubmit={async (v) => {
            const body = {
              phone_number: String(v.phone_number ?? "").trim(),
              phone_type: String(v.phone_type ?? "").trim() || null,
              is_primary: v.is_primary === true,
            };
            if (phoneDlg.mode === "add") {
              await createCompanyPhone(co.id, body);
            } else if (phoneDlg.phone) {
              await updateCompanyPhone(phoneDlg.phone.id, body);
            }
            setPhoneDlg(null);
            load();
          }}
          onClose={() => setPhoneDlg(null)}
        />
      )}
      {phoneDelCtx && (
        <ConfirmDialog
          open={!!phoneDelCtx}
          title="電話番号の削除"
          message={`「${phoneDelCtx.phone_number}」を削除します。よろしいですか？`}
          confirmLabel="削除する"
          onConfirm={async () => {
            await deleteCompanyPhone(phoneDelCtx.id);
            setPhoneDelCtx(null);
            load();
          }}
          onClose={() => setPhoneDelCtx(null)}
        />
      )}
      <ConfirmDialog
        open={deleteOpen}
        title="会社の削除"
        message={`「${co.company_name}」を削除します。よろしいですか？（契約に紐づいている場合は削除できません）`}
        onConfirm={async () => {
          await deleteCompany(co.id);
          navigate("/companies");
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  );
}
