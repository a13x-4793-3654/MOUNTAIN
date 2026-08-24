import { ReactNode, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  makeStyles,
  tokens,
  Title3,
  Subtitle2,
  Caption1,
  Badge,
  Button,
  Spinner,
  TabList,
  Tab,
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { ArrowLeft20Regular, Edit20Regular, Add20Regular, Delete20Regular, Money20Regular, Eye20Regular, ArrowDownload20Regular, ArrowUpload20Regular } from "@fluentui/react-icons";
import {
  fetchContract,
  ContractDetail as Detail,
  fetchMaster,
  MasterItem,
  fetchUsers,
  UserLite,
  updateContract,
  fetchCompanies,
  fetchPersons,
  fetchAccounts,
  CompanyListItem,
  PersonListItem,
  AccountListItem,
  LinkedCompany,
  LinkedPerson,
  LinkedAccount,
  ContractIdentifier,
  Communication,
  Claim,
  Payment,
  ContractFile,
  addCompanyLink,
  updateCompanyLink,
  deleteCompanyLink,
  addPersonLink,
  updatePersonLink,
  deletePersonLink,
  addAccountLink,
  updateAccountLink,
  deleteAccountLink,
  addIdentifier,
  updateIdentifier,
  deleteIdentifier,
  addCommunication,
  updateCommunication,
  deleteCommunication,
  createClaim,
  updateClaim,
  deleteClaim,
  createPayment,
  updatePayment,
  deletePayment,
  updateFile,
  deleteFile,
  downloadFileContent,
  deleteContract,
  createLawsuit,
} from "../api/client";import {
  statusAppearance,
  reviewAppearance,
  claimAppearance,
  claimStatusLabel,
  allocAppearance,
  fmtDate,
  fmtDateTime,
  fmtYen,
  fmtFileSize,
  fileTypeLabel,
  directionLabel,
  boolLabel,
} from "../util/format";
import FormDialog, { FormField, FormValues } from "../components/FormDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import FileUploadDialog from "../components/FileUploadDialog";
import FilePreviewDialog from "../components/FilePreviewDialog";

// 外部管理番号の種別。コードマスタ（category=identifier_type）と対応。マスタ取得前のフォールバック用。
const IDENT_TYPE_FALLBACK: { value: string; label: string }[] = [
  { value: "customer_no", label: "顧客番号" },
  { value: "case_no", label: "案件番号" },
  { value: "policy_no", label: "証券番号" },
  { value: "member_no", label: "会員番号" },
  { value: "legacy_no", label: "旧システム番号" },
  { value: "other", label: "その他" },
];
const CHANNELS = ["来店", "電話", "メール", "郵便", "FAX", "SMS", "書面", "訪問", "その他"];
const DIRECTIONS = [
  { value: "in", label: "受信" },
  { value: "out", label: "発信" },
];
const CLAIM_CATEGORIES = [
  { value: "monthly", label: "月次請求" },
  { value: "lump", label: "一括請求" },
  { value: "installment", label: "分割請求" },
  { value: "first", label: "初回請求" },
  { value: "dunning", label: "督促" },
];
const CLAIM_STATUSES = [
  { value: "open", label: "未入金" },
  { value: "paid", label: "入金済" },
  { value: "delinquent", label: "延滞" },
  { value: "partial", label: "一部入金" },
  { value: "canceled", label: "取消" },
];
const PAY_METHODS = ["口座振替", "カード", "コンビニ", "銀行振込", "現金", "その他"];
const FILE_KINDS = ["契約書", "本人確認", "督促", "裁判関連", "その他"];
const LAWSUIT_PROC = ["通常訴訟", "支払督促", "少額訴訟", "民事調停", "手形・小切手訴訟", "強制執行", "仮差押", "仮処分", "その他"];
const LAWSUIT_OUR_ROLES = ["被告（当方）", "原告（当方）", "債権者（当方）", "債務者（当方）", "申立人（当方）"];
const LAWSUIT_STATUSES = ["係争中", "和解", "判決", "取下げ", "確定", "終了"];

function toOpts(items: string[]) {
  return items.map((x) => ({ value: x, label: x }));
}

type DlgSpec = {
  title: string;
  fields: FormField[];
  initial?: FormValues;
  submitLabel?: string;
  onSubmit: (v: FormValues) => Promise<void>;
};
type ConfirmSpec = {
  title: string;
  message: string;
  onConfirm: () => Promise<void>;
};

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
  no: { fontVariantNumeric: "tabular-nums", fontWeight: 700 },
  badges: { display: "flex", columnGap: "6px", flexWrap: "wrap" },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "16px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "160px 1fr",
    rowGap: "10px",
    columnGap: "12px",
    maxWidth: "760px",
  },
  label: { color: tokens.colorNeutralForeground3 },
  section: { marginTop: "20px", marginBottom: "8px" },
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

export default function ContractDetail() {
  const s = useStyles();
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("basic");
  const [editOpen, setEditOpen] = useState(false);
  const [categoryMaster, setCategoryMaster] = useState<MasterItem[]>([]);
  const [statusMaster, setStatusMaster] = useState<MasterItem[]>([]);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [linkCats, setLinkCats] = useState<MasterItem[]>([]);
  const [identMaster, setIdentMaster] = useState<MasterItem[]>([]);
  const [companyOpts, setCompanyOpts] = useState<CompanyListItem[]>([]);
  const [personOpts, setPersonOpts] = useState<PersonListItem[]>([]);
  const [accountOpts, setAccountOpts] = useState<AccountListItem[]>([]);
  const [dlg, setDlg] = useState<DlgSpec | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [uploadFileOpen, setUploadFileOpen] = useState(false);
  const [attachFileCtx, setAttachFileCtx] = useState<ContractFile | null>(null);
  const [previewFileCtx, setPreviewFileCtx] = useState<ContractFile | null>(null);

  const roleOpts = linkCats.map((m) => ({ value: m.code, label: m.label }));
  const identOpts = identMaster.length
    ? identMaster.map((m) => ({ value: m.code, label: m.label }))
    : IDENT_TYPE_FALLBACK;
  function identLabel(code: string): string {
    return identOpts.find((o) => o.value === code)?.label ?? code;
  }

  function load() {
    if (!id) return;
    setLoading(true);
    fetchContract(id)
      .then((d) => setData(d))
      .catch((e) => setError(e?.message ?? "読み込みに失敗しました"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    fetchMaster("contract_category").then(setCategoryMaster).catch(() => {});
    fetchMaster("contract_status").then(setStatusMaster).catch(() => {});
    fetchMaster("link_category").then(setLinkCats).catch(() => {});
    fetchMaster("identifier_type").then(setIdentMaster).catch(() => {});
    fetchUsers().then(setUsers).catch(() => {});
    fetchCompanies({}).then((r) => setCompanyOpts(r.items)).catch(() => {});
    fetchPersons({}).then((r) => setPersonOpts(r.items)).catch(() => {});
    fetchAccounts({}).then((r) => setAccountOpts(r.items)).catch(() => {});
  }, []);

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
        <MessageBarBody>{error ?? "契約が見つかりません"}</MessageBarBody>
      </MessageBar>
    );
  }

  const c = data.contract;

  // 会社リンク
  function openAddCompany() {
    setDlg({
      title: "会社を紐付け",
      submitLabel: "紐付ける",
      fields: [
        { key: "entity_id", label: "会社", type: "select", required: true, options: companyOpts.map((x) => ({ value: x.id, label: x.company_name })) },
        { key: "link_category", label: "この契約での立場", type: "select", required: true, options: roleOpts },
      ],
      initial: { entity_id: "", link_category: "" },
      onSubmit: async (v) => {
        await addCompanyLink(c.id, { entity_id: String(v.entity_id), link_category: String(v.link_category) });
        load();
      },
    });
  }
  function openEditCompany(co: LinkedCompany) {
    setDlg({
      title: `会社の立場を変更（${co.company_name}）`,
      fields: [{ key: "link_category", label: "この契約での立場", type: "select", required: true, options: roleOpts }],
      initial: { link_category: co.link_category ?? "" },
      onSubmit: async (v) => {
        await updateCompanyLink(co.link_id!, { link_category: String(v.link_category) });
        load();
      },
    });
  }
  function delCompany(co: LinkedCompany) {
    setConfirm({
      title: "紐付けの解除",
      message: `会社「${co.company_name}」の紐付けを解除します。よろしいですか？`,
      onConfirm: async () => {
        await deleteCompanyLink(co.link_id!);
        load();
      },
    });
  }

  // 名義リンク
  function openAddPerson() {
    setDlg({
      title: "名義を紐付け",
      submitLabel: "紐付ける",
      fields: [
        { key: "entity_id", label: "名義（個人）", type: "select", required: true, options: personOpts.map((x) => ({ value: x.id, label: x.full_name })) },
        { key: "link_category", label: "この契約での立場", type: "select", required: true, options: roleOpts },
      ],
      initial: { entity_id: "", link_category: "" },
      onSubmit: async (v) => {
        await addPersonLink(c.id, { entity_id: String(v.entity_id), link_category: String(v.link_category) });
        load();
      },
    });
  }
  function openEditPerson(pe: LinkedPerson) {
    setDlg({
      title: `名義の立場を変更（${pe.full_name}）`,
      fields: [{ key: "link_category", label: "この契約での立場", type: "select", required: true, options: roleOpts }],
      initial: { link_category: pe.link_category ?? "" },
      onSubmit: async (v) => {
        await updatePersonLink(pe.link_id!, { link_category: String(v.link_category) });
        load();
      },
    });
  }
  function delPerson(pe: LinkedPerson) {
    setConfirm({
      title: "紐付けの解除",
      message: `名義「${pe.full_name}」の紐付けを解除します。よろしいですか？`,
      onConfirm: async () => {
        await deletePersonLink(pe.link_id!);
        load();
      },
    });
  }

  // 口座・カードリンク
  function acctLabel(a: AccountListItem) {
    return `${a.account_category === "credit" ? "カード" : "口座"}｜${[a.bank_name, a.branch_name].filter(Boolean).join(" ") || "—"}｜${a.account_no_masked ?? ""}`;
  }
  function openAddAccount() {
    setDlg({
      title: "口座・カードを紐付け",
      submitLabel: "紐付ける",
      fields: [
        { key: "entity_id", label: "口座・カード", type: "select", required: true, options: accountOpts.map((x) => ({ value: x.id, label: acctLabel(x) })) },
        { key: "link_category", label: "紐づけ種別", type: "select", required: true, options: roleOpts },
        { key: "is_default", label: "既定にする", type: "switch" },
      ],
      initial: { entity_id: "", link_category: "", is_default: false },
      onSubmit: async (v) => {
        await addAccountLink(c.id, { entity_id: String(v.entity_id), link_category: String(v.link_category), is_default: Boolean(v.is_default) });
        load();
      },
    });
  }
  function openEditAccount(a: LinkedAccount) {
    setDlg({
      title: "口座・カードの紐づけを変更",
      fields: [
        { key: "link_category", label: "紐づけ種別", type: "select", required: true, options: roleOpts },
        { key: "is_default", label: "既定にする", type: "switch" },
      ],
      initial: { link_category: a.link_category ?? "", is_default: Boolean(a.is_default) },
      onSubmit: async (v) => {
        await updateAccountLink(a.link_id!, { link_category: String(v.link_category), is_default: Boolean(v.is_default) });
        load();
      },
    });
  }
  function delAccount(a: LinkedAccount) {
    setConfirm({
      title: "紐付けの解除",
      message: "この口座・カードの紐付けを解除します。よろしいですか？",
      onConfirm: async () => {
        await deleteAccountLink(a.link_id!);
        load();
      },
    });
  }

  // 外部管理番号（識別子）
  const identFields: FormField[] = [
    { key: "identifier_type", label: "種別", type: "select", required: true, options: identOpts },
    { key: "identifier_value", label: "番号", type: "text", required: true },
    { key: "is_primary", label: "主番号にする", type: "switch" },
  ];
  function openAddIdent() {
    setDlg({
      title: "外部管理番号を追加",
      submitLabel: "追加する",
      fields: identFields,
      initial: { identifier_type: "", identifier_value: "", is_primary: false },
      onSubmit: async (v) => {
        await addIdentifier(c.id, { identifier_type: String(v.identifier_type), identifier_value: String(v.identifier_value).trim(), is_primary: Boolean(v.is_primary) });
        load();
      },
    });
  }
  function openEditIdent(it: ContractIdentifier) {
    setDlg({
      title: "外部管理番号を編集",
      fields: identFields,
      initial: { identifier_type: it.identifier_type, identifier_value: it.identifier_value, is_primary: Boolean(it.is_primary) },
      onSubmit: async (v) => {
        await updateIdentifier(it.id!, { identifier_type: String(v.identifier_type), identifier_value: String(v.identifier_value).trim(), is_primary: Boolean(v.is_primary) });
        load();
      },
    });
  }
  function delIdent(it: ContractIdentifier) {
    setConfirm({
      title: "外部管理番号の削除",
      message: `「${it.identifier_value}」を削除します。よろしいですか？`,
      onConfirm: async () => {
        await deleteIdentifier(it.id!);
        load();
      },
    });
  }

  // やり取り履歴
  const commFields: FormField[] = [
    { key: "occurred_at", label: "日時", type: "date" },
    { key: "direction", label: "区分", type: "select", options: DIRECTIONS },
    { key: "channel", label: "手段", type: "select", options: toOpts(CHANNELS) },
    { key: "summary", label: "概要（結果・要点）", type: "text", required: true },
    { key: "details", label: "詳細メモ", type: "textarea" },
  ];
  function commBody(v: FormValues) {
    return {
      occurred_at: String(v.occurred_at ?? "").trim() || null,
      direction: String(v.direction ?? "").trim() || null,
      channel: String(v.channel ?? "").trim() || null,
      summary: String(v.summary ?? "").trim(),
      details: String(v.details ?? "").trim() || null,
    };
  }
  function openAddComm() {
    setDlg({
      title: "やり取りを記録",
      submitLabel: "記録する",
      fields: commFields,
      initial: { occurred_at: "", direction: "in", channel: "", summary: "", details: "" },
      onSubmit: async (v) => {
        await addCommunication(c.id, commBody(v));
        load();
      },
    });
  }
  function openEditComm(m: Communication) {
    setDlg({
      title: "やり取りを編集",
      fields: commFields,
      initial: { occurred_at: (m.occurred_at ?? "").slice(0, 10), direction: m.direction ?? "in", channel: m.channel ?? "", summary: m.summary ?? "", details: m.details ?? "" },
      onSubmit: async (v) => {
        await updateCommunication(m.id, commBody(v));
        load();
      },
    });
  }
  function delComm(m: Communication) {
    setConfirm({
      title: "やり取りの削除",
      message: "この履歴を削除します。よろしいですか？",
      onConfirm: async () => {
        await deleteCommunication(m.id);
        load();
      },
    });
  }

  // 請求
  const claimFields: FormField[] = [
    { key: "claim_category", label: "請求区分", type: "select", required: true, options: CLAIM_CATEGORIES },
    { key: "occurred_on", label: "計上日", type: "date", required: true },
    { key: "due_at", label: "支払期限", type: "date" },
    { key: "new_amount", label: "新規請求額", type: "number" },
    { key: "carry_over_amount", label: "繰越額", type: "number" },
    { key: "status", label: "状態", type: "select", required: true, options: CLAIM_STATUSES },
    { key: "status", label: "状態", type: "select", required: true, options: CLAIM_STATUSES },
    { key: "methods", label: "支払方法（複数選択可）", type: "multiselect", required: true, options: toOpts(PAY_METHODS), hint: "この請求をどの方法で支払えるかを選びます（複数選べます）" },
    { key: "memo", label: "メモ", type: "textarea" },
  ];
  function claimBody(v: FormValues) {
    return {
      claim_category: String(v.claim_category),
      occurred_on: String(v.occurred_on ?? "").trim(),
      due_at: String(v.due_at ?? "").trim() || null,
      new_amount: Number(String(v.new_amount ?? "0") || 0),
      carry_over_amount: Number(String(v.carry_over_amount ?? "0") || 0),
      status: String(v.status),
      methods: String(v.methods ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      memo: String(v.memo ?? "").trim() || null,
    };
  }
  function openAddClaim() {
    setDlg({
      title: "請求を発行",
      submitLabel: "発行する",
      fields: claimFields,
      initial: { claim_category: "monthly", occurred_on: "", due_at: "", new_amount: "", carry_over_amount: "0", status: "open", methods: "", memo: "" },
      onSubmit: async (v) => {
        await createClaim(c.id, claimBody(v));
        load();
      },
    });
  }
  function openEditClaim(cl: Claim) {
    setDlg({
      title: "請求を編集",
      fields: claimFields,
      initial: {
        claim_category: cl.claim_category ?? "monthly",
        occurred_on: (cl.occurred_on ?? "").slice(0, 10),
        due_at: (cl.due_at ?? "").slice(0, 10),
        new_amount: String(cl.claim_total_amount ?? ""),
        carry_over_amount: "0",
        status: cl.status ?? "open",
        methods: (cl.methods ?? []).join(","),
        memo: "",
      },
      onSubmit: async (v) => {
        await updateClaim(cl.id, claimBody(v));
        load();
      },
    });
  }
  function delClaim(cl: Claim) {
    setConfirm({
      title: "請求の削除",
      message: "この請求を削除します。よろしいですか？",
      onConfirm: async () => {
        await deleteClaim(cl.id);
        load();
      },
    });
  }

  // 入金
  const paymentFields: FormField[] = [
    { key: "received_at", label: "入金日", type: "date", required: true },
    { key: "amount", label: "入金額（返金はマイナス）", type: "number", required: true },
    { key: "received_method", label: "入金方法", type: "select", options: toOpts(PAY_METHODS) },
    { key: "received_place", label: "入金場所", type: "text" },
    { key: "source_type", label: "入金区分", type: "select", options: toOpts(["通常", "返金", "その他"]) },
    { key: "receipt_type", label: "証票種別", type: "text" },
  ];
  function paymentBody(v: FormValues) {
    const receipt = String(v.receipt_type ?? "").trim();
    return {
      received_at: String(v.received_at ?? "").trim(),
      amount: Number(String(v.amount ?? "0") || 0),
      received_method: String(v.received_method ?? "").trim() || null,
      received_place: String(v.received_place ?? "").trim() || null,
      source_type: String(v.source_type ?? "通常").trim() || "通常",
      receipt_type: receipt || null,
      has_receipt: !!receipt,
    };
  }
  function openAddPayment(prefill?: { amount?: number | null; method?: string | null }) {
    const today = new Date().toISOString().slice(0, 10);
    const method = prefill?.method && PAY_METHODS.includes(prefill.method) ? prefill.method : "";
    const amount =
      prefill?.amount != null && Number(prefill.amount) > 0 ? String(Math.round(Number(prefill.amount))) : "";
    setDlg({
      title: "入金を登録",
      submitLabel: "登録する",
      fields: paymentFields,
      initial: { received_at: today, amount, received_method: method, received_place: "", source_type: "通常", receipt_type: "" },
      onSubmit: async (v) => {
        await createPayment({ contract_id: c.id, ...paymentBody(v) });
        load();
      },
    });
  }
  function openEditPayment(p: Payment) {
    setDlg({
      title: "入金を編集",
      fields: paymentFields,
      initial: {
        received_at: (p.received_at ?? "").slice(0, 10),
        amount: String(p.amount ?? ""),
        received_method: p.received_method ?? "",
        received_place: "",
        source_type: p.source_type ?? "通常",
        receipt_type: p.receipt_type ?? "",
      },
      onSubmit: async (v) => {
        await updatePayment(p.id, paymentBody(v));
        load();
      },
    });
  }
  function delPayment(p: Payment) {
    setConfirm({
      title: "入金の削除",
      message: "この入金を削除します。よろしいですか？",
      onConfirm: async () => {
        await deletePayment(p.id);
        load();
      },
    });
  }

  // ファイル
  const fileFields: FormField[] = [
    { key: "file_name", label: "ファイル名", type: "text", required: true },
    { key: "tag_text", label: "種別", type: "select", options: toOpts(FILE_KINDS) },
    { key: "is_password_protected", label: "パスワード保護（機微・要承認）", type: "switch" },
  ];
  function fileBody(v: FormValues) {
    return {
      file_name: String(v.file_name ?? "").trim(),
      tag_text: String(v.tag_text ?? "").trim() || null,
      is_password_protected: Boolean(v.is_password_protected),
    };
  }
  function openAddFile() {
    setUploadFileOpen(true);
  }
  async function onDownloadFile(f: ContractFile) {
    try {
      await downloadFileContent(f.id, f.file_name);
    } catch (e: any) {
      setError(e?.message ?? "ダウンロードに失敗しました");
    }
  }
  function openEditFile(f: ContractFile) {
    setDlg({
      title: "ファイルを編集",
      fields: fileFields,
      initial: { file_name: f.file_name, tag_text: f.tag_text ?? "", is_password_protected: Boolean(f.is_password_protected) },
      onSubmit: async (v) => {
        await updateFile(f.id, fileBody(v));
        load();
      },
    });
  }
  function delFile(f: ContractFile) {
    setConfirm({
      title: "ファイルの削除",
      message: `「${f.file_name}」を削除します。よろしいですか？`,
      onConfirm: async () => {
        await deleteFile(f.id);
        load();
      },
    });
  }

  // 訴訟（当契約に紐付けて新規作成 → 詳細へ）
  function openAddLawsuit() {
    setDlg({
      title: "訴訟を追加",
      submitLabel: "登録する",
      fields: [
        { key: "proc_type", label: "手続", type: "select", required: true, options: toOpts(LAWSUIT_PROC) },
        { key: "case_name", label: "事件名", type: "text" },
        { key: "case_number", label: "事件番号", type: "text", required: true },
        { key: "court_name", label: "裁判所", type: "text", required: true },
        { key: "our_side_role", label: "当方の立場", type: "select", options: toOpts(LAWSUIT_OUR_ROLES) },
        { key: "status", label: "状態", type: "select", required: true, options: toOpts(LAWSUIT_STATUSES) },
        { key: "claim_amount", label: "相手方の請求額（円）", type: "number" },
        { key: "filed_or_received_on", label: "提訴・受領日", type: "date" },
      ],
      initial: {
        proc_type: "通常訴訟",
        case_name: "",
        case_number: "",
        court_name: "",
        our_side_role: "被告（当方）",
        status: "係争中",
        claim_amount: "",
        filed_or_received_on: "",
      },
      onSubmit: async (v) => {
        const amt = String(v.claim_amount ?? "").trim();
        const res = await createLawsuit(c.id, {
          proc_type: String(v.proc_type),
          case_number: String(v.case_number).trim(),
          court_name: String(v.court_name).trim(),
          status: String(v.status),
          our_side_role: String(v.our_side_role ?? "").trim() || null,
          case_name: String(v.case_name ?? "").trim() || null,
          claim_amount: amt === "" ? null : Number(amt),
          filed_or_received_on: String(v.filed_or_received_on ?? "").trim() || null,
        });
        setDlg(null);
        navigate(`/litigation/${res.id}`);
      },
    });
  }

  // 契約の削除
  function delThisContract() {
    setConfirm({
      title: "契約の削除",
      message: `契約「${c.contract_no}」を削除します。関連する紐付・履歴・請求・入金・ファイルもすべて削除されます。よろしいですか？`,
      onConfirm: async () => {
        await deleteContract(c.id);
        navigate("/contracts");
      },
    });
  }

  return (
    <div>
      <div className={s.topbar}>
        <Button
          appearance="subtle"
          icon={<ArrowLeft20Regular />}
          onClick={() => navigate("/contracts")}
        >
          契約一覧へ戻る
        </Button>
        <div style={{ flexGrow: 1 }} />
        <Button
          appearance="primary"
          icon={<Edit20Regular />}
          onClick={() => setEditOpen(true)}
        >
          契約を編集
        </Button>
        <Button
          appearance="subtle"
          icon={<Delete20Regular />}
          onClick={delThisContract}
        >
          契約を削除
        </Button>
      </div>

      <div className={s.headCard}>
        <div className={s.headRow}>
          <span className={s.no}>
            <Title3>{c.contract_no}</Title3>
          </span>
          <div className={s.badges}>
            <Badge appearance="filled" color={statusAppearance(c.contract_status)}>
              {c.status_label ?? c.contract_status}
            </Badge>
            <Badge appearance="tint" color={reviewAppearance(c.review_status)}>
              審査: {c.review_label ?? c.review_status}
            </Badge>
            {data.flags.map((f) => (
              <Badge key={f.flag_code} appearance="outline" color="important">
                {f.label}
              </Badge>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 6 }}>
          <Subtitle2>{c.contract_summary}</Subtitle2>
        </div>
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
        <Tab value="basic">基本情報</Tab>
        <Tab value="links">紐付（会社・名義・口座）</Tab>
        <Tab value="history">やり取り履歴</Tab>
        <Tab value="billing">請求・入金</Tab>
        <Tab value="litigation">訴訟</Tab>
        <Tab value="files">ファイル</Tab>
      </TabList>

      <div style={{ marginTop: 12 }}>
        {tab === "basic" && (
          <div className={s.panel}>
            <div className={s.grid}>
              <InfoRow label="契約区分">{c.category_label ?? c.contract_category}</InfoRow>
              <InfoRow label="業務ステータス">
                <Badge appearance="filled" color={statusAppearance(c.contract_status)}>
                  {c.status_label ?? c.contract_status}
                </Badge>
              </InfoRow>
              <InfoRow label="審査状況">
                {c.review_label ?? c.review_status}
                {c.review_reason ? `（${c.review_reason}）` : ""}
              </InfoRow>
              <InfoRow label="契約日">{fmtDate(c.signed_at)}</InfoRow>
              <InfoRow label="取引開始日">{fmtDate(c.started_at)}</InfoRow>
              <InfoRow label="終了日">{fmtDate(c.ended_at)}</InfoRow>
              <InfoRow label="繰り返し請求">{boolLabel(c.has_recurring_billing)}</InfoRow>
              <InfoRow label="社内担当">{c.assignee_name ?? "—"}</InfoRow>
              <InfoRow label="登録者">{c.created_by_name ?? "—"}</InfoRow>
              <InfoRow label="備考">{c.review_memo ?? "—"}</InfoRow>
            </div>

            <div className={s.section} style={{ display: "flex", alignItems: "center" }}>
              <Subtitle2>外部管理番号</Subtitle2>
              <div style={{ flexGrow: 1 }} />
              <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={openAddIdent}>
                追加
              </Button>
            </div>
            {data.identifiers.length === 0 ? (
              <Caption1>登録なし</Caption1>
            ) : (
              <Table size="small" aria-label="外部管理番号">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>種別</TableHeaderCell>
                    <TableHeaderCell>番号</TableHeaderCell>
                    <TableHeaderCell>主番号</TableHeaderCell>
                    <TableHeaderCell>操作</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.identifiers.map((it, i) => (
                    <TableRow key={i}>
                      <TableCell>{it.identifier_type_label ?? identLabel(it.identifier_type)}</TableCell>
                      <TableCell>{it.identifier_value}</TableCell>
                      <TableCell>{it.is_primary ? "○" : ""}</TableCell>
                      <TableCell>
                        <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => openEditIdent(it)}>
                          編集
                        </Button>
                        <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delIdent(it)}>
                          削除
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}

        {tab === "links" && (
          <div className={s.panel}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <Subtitle2>会社</Subtitle2>
              <div style={{ flexGrow: 1 }} />
              <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={openAddCompany}>
                会社を紐付け
              </Button>
            </div>
            <Table size="small" aria-label="紐付会社" style={{ marginTop: 6 }}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>会社名</TableHeaderCell>
                  <TableHeaderCell>立場</TableHeaderCell>
                  <TableHeaderCell>所在地</TableHeaderCell>
                  <TableHeaderCell>電話</TableHeaderCell>
                  <TableHeaderCell>操作</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.companies.map((co) => (
                  <TableRow key={co.id}>
                    <TableCell>{co.company_name}</TableCell>
                    <TableCell>
                      {co.link_label && (
                        <Badge appearance="tint">{co.link_label}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {[co.prefecture, co.city, co.address1].filter(Boolean).join(" ") || "—"}
                    </TableCell>
                    <TableCell>{co.phone ?? "—"}</TableCell>
                    <TableCell>
                      <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => openEditCompany(co)}>
                        立場変更
                      </Button>
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delCompany(co)}>
                        解除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {data.companies.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5}>紐付なし</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

            <div className={s.section} style={{ display: "flex", alignItems: "center" }}>
              <Subtitle2>名義</Subtitle2>
              <div style={{ flexGrow: 1 }} />
              <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={openAddPerson}>
                名義を紐付け
              </Button>
            </div>
            <Table size="small" aria-label="紐付名義">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>氏名</TableHeaderCell>
                  <TableHeaderCell>立場</TableHeaderCell>
                  <TableHeaderCell>所在地</TableHeaderCell>
                  <TableHeaderCell>操作</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.persons.map((pe) => (
                  <TableRow key={pe.id}>
                    <TableCell>{pe.full_name}</TableCell>
                    <TableCell>
                      {pe.link_label && (
                        <Badge appearance="tint">{pe.link_label}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {[pe.prefecture, pe.city, pe.address1].filter(Boolean).join(" ") || "—"}
                    </TableCell>
                    <TableCell>
                      <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => openEditPerson(pe)}>
                        立場変更
                      </Button>
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delPerson(pe)}>
                        解除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {data.persons.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4}>紐付なし</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

            <div className={s.section} style={{ display: "flex", alignItems: "center" }}>
              <Subtitle2>口座・カード</Subtitle2>
              <div style={{ flexGrow: 1 }} />
              <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={openAddAccount}>
                口座・カードを紐付け
              </Button>
            </div>
            <Table size="small" aria-label="紐付口座">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>種別</TableHeaderCell>
                  <TableHeaderCell>金融機関</TableHeaderCell>
                  <TableHeaderCell>番号（マスク）</TableHeaderCell>
                  <TableHeaderCell>紐づけ種別</TableHeaderCell>
                  <TableHeaderCell>既定</TableHeaderCell>
                  <TableHeaderCell>操作</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{a.account_category === "credit" ? "カード" : "口座"}</TableCell>
                    <TableCell>
                      {[a.bank_name, a.branch_name].filter(Boolean).join(" ") || "—"}
                    </TableCell>
                    <TableCell>{a.account_no_masked ?? "—"}</TableCell>
                    <TableCell>
                      {a.link_label && <Badge appearance="tint">{a.link_label}</Badge>}
                    </TableCell>
                    <TableCell>{a.is_default ? "○" : ""}</TableCell>
                    <TableCell>
                      <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => openEditAccount(a)}>
                        変更
                      </Button>
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delAccount(a)}>
                        解除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {data.accounts.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6}>紐付なし</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {tab === "history" && (
          <div className={s.panel}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
              <Subtitle2>やり取り履歴</Subtitle2>
              <div style={{ flexGrow: 1 }} />
              <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={openAddComm}>
                記録
              </Button>
            </div>
            {data.communications.length === 0 ? (
              <Caption1>やり取り履歴はありません。</Caption1>
            ) : (
              <Table size="small" aria-label="やり取り履歴">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>日時</TableHeaderCell>
                    <TableHeaderCell>区分</TableHeaderCell>
                    <TableHeaderCell>手段</TableHeaderCell>
                    <TableHeaderCell>概要</TableHeaderCell>
                    <TableHeaderCell>詳細</TableHeaderCell>
                    <TableHeaderCell>操作</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.communications.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>{fmtDateTime(m.occurred_at)}</TableCell>
                      <TableCell>
                        <Badge
                          appearance="tint"
                          color={m.direction === "in" ? "informative" : "brand"}
                        >
                          {directionLabel(m.direction)}
                        </Badge>
                      </TableCell>
                      <TableCell>{m.channel ?? "—"}</TableCell>
                      <TableCell>{m.summary}</TableCell>
                      <TableCell>{m.details ?? "—"}</TableCell>
                      <TableCell>
                        <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => openEditComm(m)}>
                          編集
                        </Button>
                        <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delComm(m)}>
                          削除
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}

        {tab === "billing" && (
          <div className={s.panel}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <Subtitle2>請求</Subtitle2>
              <div style={{ flexGrow: 1 }} />
              <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={openAddClaim}>
                請求発行
              </Button>
            </div>
            <Table size="small" aria-label="請求" style={{ marginTop: 6 }}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>発生日</TableHeaderCell>
                  <TableHeaderCell>区分</TableHeaderCell>
                  <TableHeaderCell>支払方法</TableHeaderCell>
                  <TableHeaderCell>請求額</TableHeaderCell>
                  <TableHeaderCell>入金済</TableHeaderCell>
                  <TableHeaderCell>残</TableHeaderCell>
                  <TableHeaderCell>支払期限</TableHeaderCell>
                  <TableHeaderCell>状態</TableHeaderCell>
                  <TableHeaderCell>操作</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.claims.map((cl) => (
                  <TableRow key={cl.id}>
                    <TableCell>{fmtDate(cl.occurred_on)}</TableCell>
                    <TableCell>{cl.claim_category ?? "—"}</TableCell>
                    <TableCell>
                      {(cl.methods ?? []).length ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {(cl.methods ?? []).map((m) => (
                            <Badge key={m} appearance="outline" color="informative">{m}</Badge>
                          ))}
                        </div>
                      ) : (
                        <span style={{ opacity: 0.6 }}>未設定</span>
                      )}
                    </TableCell>
                    <TableCell>{fmtYen(cl.claim_total_amount)}</TableCell>
                    <TableCell>{fmtYen(cl.paid_amount as any)}</TableCell>
                    <TableCell>{fmtYen(cl.remaining_balance as any)}</TableCell>
                    <TableCell>{fmtDateTime(cl.due_at)}</TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={claimAppearance(cl.status)}>
                        {claimStatusLabel(cl.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<Money20Regular />}
                        onClick={() =>
                          openAddPayment({
                            amount: (cl.remaining_balance as any) ?? (cl.claim_total_amount as any),
                            method: (cl.methods ?? [])[0] ?? null,
                          })
                        }
                      >
                        入金
                      </Button>
                      <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => openEditClaim(cl)}>
                        編集
                      </Button>
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delClaim(cl)}>
                        削除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {data.claims.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9}>請求はありません。</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

            <div className={s.section} style={{ display: "flex", alignItems: "center" }}>
              <Subtitle2>入金</Subtitle2>
              <div style={{ flexGrow: 1 }} />
              <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={() => openAddPayment()}>
                入金登録
              </Button>
            </div>
            <Table size="small" aria-label="入金">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>入金日時</TableHeaderCell>
                  <TableHeaderCell>金額</TableHeaderCell>
                  <TableHeaderCell>方法</TableHeaderCell>
                  <TableHeaderCell>種別</TableHeaderCell>
                  <TableHeaderCell>領収書</TableHeaderCell>
                  <TableHeaderCell>消込状態</TableHeaderCell>
                  <TableHeaderCell>操作</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{fmtDateTime(p.received_at)}</TableCell>
                    <TableCell>{fmtYen(p.amount)}</TableCell>
                    <TableCell>{p.received_method ?? "—"}</TableCell>
                    <TableCell>{p.source_type ?? "—"}</TableCell>
                    <TableCell>{boolLabel(p.has_receipt)}</TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={allocAppearance(p.alloc_status)}>
                        {p.alloc_status ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => openEditPayment(p)}>
                        編集
                      </Button>
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delPayment(p)}>
                        削除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {data.payments.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7}>入金はありません。</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {tab === "litigation" && (
          <div className={s.panel}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
              <Subtitle2>訴訟</Subtitle2>
              <div style={{ flexGrow: 1 }} />
              <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={openAddLawsuit}>
                訴訟を追加
              </Button>
            </div>
            {data.lawsuits.length === 0 ? (
              <Caption1>訴訟情報はありません。</Caption1>
            ) : (
              data.lawsuits.map((lw) => (
                <div key={lw.id} className={s.grid} style={{ marginBottom: 16 }}>
                  <InfoRow label="手続種別">{lw.proc_type ?? "—"}</InfoRow>
                  <InfoRow label="事件名">{lw.case_name ?? "—"}</InfoRow>
                  <InfoRow label="事件番号">{lw.case_number ?? "—"}</InfoRow>
                  <InfoRow label="裁判所">{lw.court_name ?? "—"}</InfoRow>
                  <InfoRow label="当方の立場">{lw.our_side_role ?? "—"}</InfoRow>
                  <InfoRow label="状態">
                    <Badge appearance="filled" color="danger">
                      {lw.status ?? "—"}
                    </Badge>
                  </InfoRow>
                  <InfoRow label="相手方の請求額">{fmtYen(lw.claim_amount)}</InfoRow>
                  <InfoRow label="提訴・受領日">{fmtDate(lw.filed_or_received_on)}</InfoRow>
                  <InfoRow label="請求の要旨">{lw.demand ?? "—"}</InfoRow>
                  <InfoRow label="操作">
                    <Button
                      size="small"
                      appearance="secondary"
                      onClick={() => navigate(`/litigation/${lw.id}`)}
                    >
                      詳細を開く
                    </Button>
                  </InfoRow>
                </div>
              ))
            )}
          </div>
        )}

        {tab === "files" && (
          <div className={s.panel}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
              <Subtitle2>ファイル</Subtitle2>
              <div style={{ flexGrow: 1 }} />
              <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={openAddFile}>
                ファイルを登録
              </Button>
            </div>
            {data.files.length === 0 ? (
              <Caption1>ファイルはありません。</Caption1>
            ) : (
              <Table size="small" aria-label="ファイル">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>ファイル名</TableHeaderCell>
                    <TableHeaderCell>種類</TableHeaderCell>
                    <TableHeaderCell>サイズ</TableHeaderCell>
                    <TableHeaderCell>タグ</TableHeaderCell>
                    <TableHeaderCell>パスワード保護</TableHeaderCell>
                    <TableHeaderCell>登録日時</TableHeaderCell>
                    <TableHeaderCell>操作</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.files.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell>{f.file_name}</TableCell>
                      <TableCell title={f.content_type ?? undefined}>
                        {fileTypeLabel(f.content_type)}
                      </TableCell>
                      <TableCell>{fmtFileSize(f.file_size_bytes)}</TableCell>
                      <TableCell>{f.tag_text ?? "—"}</TableCell>
                      <TableCell>{boolLabel(f.is_password_protected)}</TableCell>
                      <TableCell>{fmtDateTime(f.created_at)}</TableCell>
                      <TableCell>
                        {f.has_content ? (
                          <>
                            <Button size="small" appearance="subtle" icon={<Eye20Regular />} onClick={() => setPreviewFileCtx(f)}>
                              プレビュー
                            </Button>
                            <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />} onClick={() => onDownloadFile(f)}>
                              保存
                            </Button>
                          </>
                        ) : (
                          <Button size="small" appearance="subtle" icon={<ArrowUpload20Regular />} onClick={() => setAttachFileCtx(f)}>
                            実ファイル追加
                          </Button>
                        )}
                        <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => openEditFile(f)}>
                          編集
                        </Button>
                        <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delFile(f)}>
                          削除
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </div>

      <FormDialog
        open={editOpen}
        title="契約の編集"
        fields={[
          { key: "contract_category", label: "契約区分", type: "select", required: true, options: categoryMaster.map((m) => ({ value: m.code, label: m.label })) },
          { key: "contract_summary", label: "概要", type: "text", required: true },
          { key: "contract_status", label: "業務ステータス", type: "select", required: true, options: statusMaster.map((m) => ({ value: m.code, label: m.label })) },
          { key: "signed_at", label: "契約日", type: "date" },
          { key: "started_at", label: "取引開始日", type: "date" },
          { key: "ended_at", label: "終了日", type: "date" },
          { key: "has_recurring_billing", label: "繰り返し請求あり", type: "switch" },
          { key: "assignee_user_id", label: "社内担当", type: "select", options: [{ value: "", label: "（未定）" }, ...users.map((u) => ({ value: u.id, label: u.display_name }))] },
          { key: "review_memo", label: "審査メモ", type: "textarea" },
        ]}
        initial={{
          contract_category: c.contract_category,
          contract_summary: c.contract_summary ?? "",
          contract_status: c.contract_status,
          signed_at: (c.signed_at ?? "").slice(0, 10),
          started_at: (c.started_at ?? "").slice(0, 10),
          ended_at: (c.ended_at ?? "").slice(0, 10),
          has_recurring_billing: Boolean(c.has_recurring_billing),
          assignee_user_id: c.assignee_user_id ?? "",
          review_memo: c.review_memo ?? "",
        }}
        submitLabel="保存する"
        onSubmit={async (v) => {
          await updateContract(c.id, {
            contract_category: String(v.contract_category),
            contract_summary: String(v.contract_summary ?? "").trim(),
            contract_status: String(v.contract_status),
            signed_at: String(v.signed_at ?? "").trim() || null,
            started_at: String(v.started_at ?? "").trim() || null,
            ended_at: String(v.ended_at ?? "").trim() || null,
            has_recurring_billing: Boolean(v.has_recurring_billing),
            assignee_user_id: String(v.assignee_user_id ?? "").trim() || null,
            review_memo: String(v.review_memo ?? "").trim() || null,
          });
          setEditOpen(false);
          load();
        }}
        onClose={() => setEditOpen(false)}
      />

      {dlg && (
        <FormDialog
          open
          title={dlg.title}
          fields={dlg.fields}
          initial={dlg.initial}
          submitLabel={dlg.submitLabel}
          onSubmit={dlg.onSubmit}
          onClose={() => setDlg(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          open
          title={confirm.title}
          message={confirm.message}
          confirmLabel="実行する"
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}

      <FileUploadDialog
        open={uploadFileOpen}
        onClose={() => setUploadFileOpen(false)}
        onDone={load}
        contractId={c.id}
        tagOptions={toOpts(FILE_KINDS)}
      />

      {attachFileCtx && (
        <FileUploadDialog
          open={!!attachFileCtx}
          onClose={() => setAttachFileCtx(null)}
          onDone={load}
          attachFileId={attachFileCtx.id}
          attachFileName={attachFileCtx.file_name}
        />
      )}

      {previewFileCtx && (
        <FilePreviewDialog
          open={!!previewFileCtx}
          fileId={previewFileCtx.id}
          fileName={previewFileCtx.file_name}
          contentType={previewFileCtx.content_type}
          onClose={() => setPreviewFileCtx(null)}
        />
      )}
    </div>
  );
}
