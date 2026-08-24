import { Fragment, ReactNode, useEffect, useState } from "react";
import {
  makeStyles,
  tokens,
  Title3,
  Subtitle2,
  Caption1,
  Body1,
  Button,
  Badge,
  Spinner,
  Input,
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
import {
  ArrowClockwise20Regular,
  Add20Regular,
  Edit16Regular,
  Delete16Regular,
  Checkmark16Regular,
  Dismiss16Regular,
  Search16Regular,
} from "@fluentui/react-icons";
import {
  fetchAdmin,
  AdminData,
  AdminUser,
  CodeMaster,
  DenyItem,
  fetchCompanies,
  CompanyListItem,
  createDeny,
  updateDeny,
  approveDeny,
  rejectDeny,
  liftDeny,
  deleteDeny,
  createUser,
  updateUser,
  deleteUser,
  createMaster,
  updateMaster,
  deleteMaster,
  GroupRoleMap,
  createGroupRoleMap,
  renameGroupRoleMap,
  deleteGroupRoleMap,
  RoleItem,
  createRole,
  updateRole,
  deleteRole,
  runMockReset,
} from "../api/client";
import {
  fmtDate,
  fmtDateTime,
  userStatusLabel,
  userStatusAppearance,
  notifyChannelLabel,
  denyReasonLabel,
  denyApprovalLabel,
  denyApprovalAppearance,
  boolLabel,
} from "../util/format";
import FormDialog, { FormField, FormValues } from "../components/FormDialog";
import ConfirmDialog from "../components/ConfirmDialog";

const DENY_REASON_OPTIONS = [
  { value: "1", label: "総合的判断" },
  { value: "2", label: "複数回の間違い電話" },
  { value: "3", label: "一時的" },
];

const USER_STATUS_OPTIONS = [
  { value: "0", label: "有効" },
  { value: "1", label: "停止（一時的に利用不可）" },
  { value: "2", label: "退職（利用終了）" },
];

// コードマスタ（分類・区分）の種別。アプリ内の各プルダウンの中身になる。
const CATEGORY_OPTIONS = [
  { value: "contract_category", label: "契約の分類" },
  { value: "contract_status", label: "契約の状態" },
  { value: "review_status", label: "審査の状態" },
  { value: "link_category", label: "紐づけ種別（債権者・債務者・引落口座 など）" },
  { value: "identifier_type", label: "外部管理番号の種別（顧客番号・案件番号 など）" },
  { value: "contract_flag", label: "契約の目印（フラグ）" },
];

function categoryLabel(cat: string): string {
  return CATEGORY_OPTIONS.find((o) => o.value === cat)?.label ?? cat;
}

// ロール・権限の早見表（サインインと権限は Entra ID 連携で決まる）
const ROLE_ROWS = [
  { key: "admin", name: "管理者", desc: "すべての操作／ユーザー・区分・監査ログの管理" },
  { key: "contract_operator", name: "契約担当", desc: "契約の登録・編集・入金消込（機微情報は要承認）" },
  { key: "approver", name: "承認者", desc: "新規登録の審査／機微情報の開示承認" },
  { key: "reviewer", name: "審査担当", desc: "登録内容のチェック（審査）" },
  { key: "viewer", name: "閲覧のみ", desc: "閲覧のみ（機微情報はマスク表示）" },
];

// DB にロール説明が未登録のときの、やさしい日本語の補足
const ROLE_DESC: Record<string, string> = Object.fromEntries(
  ROLE_ROWS.map((r) => [r.key, r.desc]),
);

// 操作権限（action.*）を分野ごとに並べるためのグループ定義。
// perm_key は「action.<token>.<種類>」の形。token でグループを判定する。
const ACTION_GROUPS: { token: string; label: string }[] = [
  { token: "contract", label: "契約" },
  { token: "company", label: "会社" },
  { token: "person", label: "名義" },
  { token: "account", label: "口座・カード" },
  { token: "billing", label: "請求・入金" },
  { token: "review", label: "審査" },
  { token: "litigation", label: "訴訟" },
  { token: "file", label: "ファイル" },
  { token: "original", label: "原本管理" },
  { token: "document", label: "差し込み印刷" },
  { token: "household", label: "家計簿" },
  { token: "sensitive", label: "機微情報" },
];
const actionToken = (permKey: string): string => permKey.split(".")[1] ?? "";
// 各グループ内では「分野：〜」の接頭辞を外して短く表示する
const shortActionLabel = (permName: string): string => {
  const i = permName.indexOf("：");
  return i >= 0 ? permName.slice(i + 1) : permName;
};

// 監査ログの「変更前／変更後」を読みやすく整形する
function fmtJson(v: any): string {
  if (v == null) return "（なし）";
  try {
    const obj = typeof v === "string" ? JSON.parse(v) : v;
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(v);
  }
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
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
};

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: "4px",
  },
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "12px" },
  toolbar: { display: "flex", columnGap: "8px", marginBottom: "12px", alignItems: "center" },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "4px 8px",
  },
  mono: { fontVariantNumeric: "tabular-nums" },
  wrap: { maxWidth: "320px", whiteSpace: "normal", wordBreak: "break-all" },
  ops: { display: "flex", columnGap: "4px", flexWrap: "wrap" },
  note: { color: tokens.colorNeutralForeground3, fontSize: "12px", padding: "8px 4px 4px" },
  masterSection: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "8px 12px 12px",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  masterHead: { display: "flex", alignItems: "baseline", columnGap: "10px", marginBottom: "4px" },
  diffWrap: { display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: "12px", padding: "4px 0" },
  diffCol: { minWidth: 0 },
  diffLabel: { fontSize: "12px", color: tokens.colorNeutralForeground3, marginBottom: "4px" },
  pre: {
    margin: 0,
    padding: "8px",
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall,
    fontSize: "12px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    maxHeight: "220px",
    overflowY: "auto",
  },
});

export default function Admin() {
  const s = useStyles();
  const [tab, setTab] = useState("users");
  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companies, setCompanies] = useState<CompanyListItem[]>([]);
  const [dlg, setDlg] = useState<DlgSpec | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [auditQ, setAuditQ] = useState("");
  const [auditOpen, setAuditOpen] = useState<Set<string>>(new Set());
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  function toggleAudit(id: string) {
    setAuditOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchAdmin());
    } catch (e: any) {
      setError(e?.message ?? "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    fetchCompanies({}).then((r) => setCompanies(r.items)).catch(() => {});
  }, []);

  const companyOptions = [
    { value: "", label: "（会社に紐づけない）" },
    ...companies.map((c) => ({ value: c.id, label: c.company_name })),
  ];

  // ---------- ユーザー ----------
  function userFields(): FormField[] {
    return [
      { key: "display_name", label: "氏名", type: "text", required: true, placeholder: "例）田中 太郎" },
      {
        key: "user_principal_name",
        label: "ユーザー名（サインインID・メール形式）",
        type: "text",
        required: true,
        placeholder: "例）tanaka@example.com",
      },
      { key: "mail", label: "メール（任意）", type: "text", placeholder: "連絡用メール" },
      { key: "status", label: "状態", type: "select", required: true, options: USER_STATUS_OPTIONS },
      {
        key: "cti_ext_num",
        label: "内線番号（電話・任意）",
        type: "text",
        placeholder: "例）1001（電話サーバーで発行した内線）",
      },
      {
        key: "cti_password",
        label: "内線パスワード（任意・空欄なら現状のまま）",
        type: "text",
        placeholder: "電話サーバーの内線パスワード",
      },
    ];
  }

  function openAddUser() {
    setDlg({
      title: "ユーザーを追加",
      fields: userFields(),
      initial: { status: "0" },
      submitLabel: "登録する",
      onSubmit: async (v) => {
        await createUser({
          display_name: String(v.display_name ?? "").trim(),
          user_principal_name: String(v.user_principal_name ?? "").trim(),
          mail: String(v.mail ?? "").trim() || null,
          status: Number(v.status ?? 0),
          cti_ext_num: String(v.cti_ext_num ?? "").trim() || null,
          cti_password: String(v.cti_password ?? "").trim() || null,
        });
        setDlg(null);
        await load();
      },
    });
  }

  function openEditUser(u: AdminUser) {
    setDlg({
      title: "ユーザーを編集",
      fields: userFields(),
      initial: {
        display_name: u.display_name,
        user_principal_name: u.user_principal_name,
        mail: u.mail ?? "",
        status: String(u.status),
        cti_ext_num: u.cti_ext_num ?? "",
        cti_password: "",
      },
      submitLabel: "保存する",
      onSubmit: async (v) => {
        await updateUser(u.id, {
          display_name: String(v.display_name ?? "").trim(),
          user_principal_name: String(v.user_principal_name ?? "").trim(),
          mail: String(v.mail ?? "").trim() || null,
          status: Number(v.status ?? 0),
          cti_ext_num: String(v.cti_ext_num ?? "").trim() || null,
          cti_password: String(v.cti_password ?? "").trim() || null,
        });
        setDlg(null);
        await load();
      },
    });
  }

  function openDelUser(u: AdminUser) {
    setConfirm({
      title: "ユーザーの削除",
      message: `「${u.display_name}」を削除します。契約や履歴に紐づいている場合は削除できません（その場合は状態を「退職」にしてください）。よろしいですか？`,
      confirmLabel: "削除する",
      onConfirm: async () => {
        await deleteUser(u.id);
        setConfirm(null);
        await load();
      },
    });
  }

  // ---------- コードマスタ（分類・区分） ----------
  function masterFields(): FormField[] {
    return [
      { key: "category", label: "分類の種別", type: "select", required: true, options: CATEGORY_OPTIONS },
      {
        key: "code",
        label: "コード（英数字の識別子）",
        type: "text",
        required: true,
        placeholder: "例）loan",
        hint: "システム内部で使う値。半角の英数字で入力してください。",
      },
      { key: "label", label: "表示名（画面に出る名前）", type: "text", required: true, placeholder: "例）融資契約" },
      { key: "sort_order", label: "並び順（数字が小さいほど上に表示）", type: "number", placeholder: "0" },
      { key: "is_active", label: "有効（オフにすると選択肢に出なくなります）", type: "switch" },
    ];
  }

  function openAddMaster(defaultCategory?: string) {
    setDlg({
      title: defaultCategory ? `「${categoryLabel(defaultCategory)}」に区分を追加` : "分類・区分を追加",
      fields: masterFields(),
      initial: { category: defaultCategory ?? "", sort_order: "0", is_active: true },
      submitLabel: "登録する",
      onSubmit: async (v) => {
        await createMaster({
          category: String(v.category ?? "").trim(),
          code: String(v.code ?? "").trim(),
          label: String(v.label ?? "").trim(),
          sort_order: Number(v.sort_order ?? 0) || 0,
          is_active: Boolean(v.is_active),
        });
        setDlg(null);
        await load();
      },
    });
  }

  function openEditMaster(m: CodeMaster) {
    setDlg({
      title: "分類・区分を編集",
      fields: masterFields(),
      initial: {
        category: m.category,
        code: m.code,
        label: m.label,
        sort_order: String(m.sort_order ?? 0),
        is_active: m.is_active,
      },
      submitLabel: "保存する",
      onSubmit: async (v) => {
        await updateMaster(m.id, {
          category: String(v.category ?? "").trim(),
          code: String(v.code ?? "").trim(),
          label: String(v.label ?? "").trim(),
          sort_order: Number(v.sort_order ?? 0) || 0,
          is_active: Boolean(v.is_active),
        });
        setDlg(null);
        await load();
      },
    });
  }

  function openDelMaster(m: CodeMaster) {
    setConfirm({
      title: "分類・区分の削除",
      message: `「${m.label}」（${categoryLabel(m.category)}）を削除します。すでにこの区分が設定されている契約などのデータには影響しません。使わなくなっただけであれば、削除せず「編集」で"有効"をオフにする方法もおすすめです。削除してよろしいですか？`,
      confirmLabel: "削除する",
      onConfirm: async () => {
        await deleteMaster(m.id);
        setConfirm(null);
        await load();
      },
    });
  }

  // ---------- ロール ⇔ Entra セキュリティグループの対応（RBAC） ----------
  function roleSelectOptions() {
    return (data?.roles ?? []).map((r) => ({ value: String(r.id), label: r.role_name }));
  }

  function openAddGroupMap() {
    const roles = data?.roles ?? [];
    if (roles.length === 0) return;
    setDlg({
      title: "グループとロールの対応を追加",
      fields: [
        {
          key: "entra_group_name",
          label: "グループの分かりやすい名前（任意）",
          type: "text",
          placeholder: "例）債権管理チーム",
          hint: "画面に表示するための名前です。後からでも変更できます。",
        },
        {
          key: "entra_group_id",
          label: "セキュリティグループの ID（GUID）",
          type: "text",
          required: true,
          placeholder: "例）00000000-0000-0000-0000-000000000000",
          hint: "Microsoft Entra 管理センターの、対象グループの「オブジェクト ID」を貼り付けてください。",
        },
        {
          key: "role_id",
          label: "割り当てるロール",
          type: "select",
          required: true,
          options: roleSelectOptions(),
        },
      ],
      initial: { role_id: String(roles[0].id) },
      submitLabel: "追加する",
      onSubmit: async (v) => {
        await createGroupRoleMap({
          entra_group_id: String(v.entra_group_id ?? "").trim(),
          entra_group_name: String(v.entra_group_name ?? "").trim() || null,
          role_id: Number(v.role_id ?? 0),
        });
        setDlg(null);
        await load();
      },
    });
  }

  function openRenameGroupMap(m: GroupRoleMap) {
    setDlg({
      title: "グループの表示名を変更",
      fields: [
        {
          key: "entra_group_name",
          label: "グループの分かりやすい名前",
          type: "text",
          placeholder: "例）債権管理チーム",
          hint: "このグループのすべての対応にまとめて反映されます。",
        },
      ],
      initial: { entra_group_name: m.entra_group_name ?? "" },
      submitLabel: "保存する",
      onSubmit: async (v) => {
        await renameGroupRoleMap(
          m.entra_group_id,
          String(v.entra_group_name ?? "").trim() || null,
        );
        setDlg(null);
        await load();
      },
    });
  }

  function openDelGroupMap(m: GroupRoleMap) {
    setConfirm({
      title: "対応の解除",
      message: `グループ「${m.entra_group_name || m.entra_group_id}」からロール「${m.role_name}」を解除します。次回サインインから、このグループの利用者にこのロールは付与されなくなります。よろしいですか？`,
      confirmLabel: "解除する",
      onConfirm: async () => {
        await deleteGroupRoleMap(m.entra_group_id, m.role_id);
        setConfirm(null);
        await load();
      },
    });
  }

  // ---------- ロール（カスタムロール・画面／操作の権限）----------
  function permOptions(cat: "screen" | "action") {
    return (data?.permissions ?? [])
      .filter((p) => p.category === cat)
      .map((p) => ({ value: p.perm_key, label: p.perm_name }));
  }

  // 指定分野（token）の操作権限の選択肢（分野が空なら null）
  function actionOptions(token: string) {
    const opts = (data?.permissions ?? [])
      .filter((p) => p.category === "action" && actionToken(p.perm_key) === token)
      .map((p) => ({ value: p.perm_key, label: shortActionLabel(p.perm_name) }));
    return opts.length ? opts : null;
  }

  // 操作権限グループごとのフォーム項目キー（act_contract など）
  const actionFieldKey = (token: string) => `act_${token}`;

  function roleFields(includeKey: boolean): FormField[] {
    const fs: FormField[] = [];
    if (includeKey) {
      fs.push({
        key: "role_key",
        label: "ロールID（英字の識別子・あとから変更できません）",
        type: "text",
        required: true,
        placeholder: "例）branch_operator",
        hint: "英小文字ではじめ、英小文字・数字・_ . - が使えます（2〜50文字）。",
      });
    }
    fs.push(
      {
        key: "role_name",
        label: "ロール名（画面に表示する名前）",
        type: "text",
        required: true,
        placeholder: "例）支店オペレーター",
      },
      {
        key: "description",
        label: "説明（任意）",
        type: "textarea",
        placeholder: "このロールでできることのメモ",
      },
      {
        key: "screens",
        label: "見られる画面",
        type: "multiselect",
        options: permOptions("screen"),
        hint: "このロールの人に表示する画面を選びます（複数選べます）。",
      },
    );
    // できる操作は分野ごとに分けて選べるようにする（例：契約／会社／請求・入金…）
    let first = true;
    for (const g of ACTION_GROUPS) {
      const opts = actionOptions(g.token);
      if (!opts) continue;
      fs.push({
        key: actionFieldKey(g.token),
        label: `できる操作：${g.label}`,
        type: "multiselect",
        options: opts,
        hint: first
          ? "分野ごとに、許可する操作だけを選びます（何も選ばなければ、その分野の操作はできません）。"
          : undefined,
      });
      first = false;
    }
    return fs;
  }

  function permsFromValues(v: FormValues): string[] {
    const s = String(v.screens ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const acts: string[] = [];
    for (const g of ACTION_GROUPS) {
      const raw = String(v[actionFieldKey(g.token)] ?? "");
      for (const x of raw.split(",").map((t) => t.trim()).filter(Boolean)) acts.push(x);
    }
    return [...s, ...acts];
  }

  // 保存済みの権限リストから、フォーム初期値（分野ごとの操作キー）を組み立てる
  function actionInitials(perms: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const g of ACTION_GROUPS) {
      const keys = perms.filter(
        (k) => k.startsWith("action.") && actionToken(k) === g.token,
      );
      if (keys.length) out[actionFieldKey(g.token)] = keys.join(",");
    }
    return out;
  }

  function openAddRole() {
    setDlg({
      title: "ロールを追加（カスタムロール）",
      fields: roleFields(true),
      submitLabel: "追加する",
      onSubmit: async (v) => {
        await createRole({
          role_key: String(v.role_key ?? "").trim(),
          role_name: String(v.role_name ?? "").trim(),
          description: String(v.description ?? "").trim() || null,
          permissions: permsFromValues(v),
        });
        setDlg(null);
        await load();
      },
    });
  }

  function openEditRole(r: RoleItem) {
    const screens = r.permissions.filter((k) => k.startsWith("screen."));
    setDlg({
      title: `ロールを編集：${r.role_name}`,
      fields: roleFields(false),
      initial: {
        role_name: r.role_name,
        description: r.description ?? "",
        screens: screens.join(","),
        ...actionInitials(r.permissions),
      },
      submitLabel: "保存する",
      onSubmit: async (v) => {
        await updateRole(r.id, {
          role_name: String(v.role_name ?? "").trim(),
          description: String(v.description ?? "").trim() || null,
          permissions: permsFromValues(v),
        });
        setDlg(null);
        await load();
      },
    });
  }

  function openDelRole(r: RoleItem) {
    setConfirm({
      title: "ロールの削除",
      message: `ロール「${r.role_name}」を削除します。このロールが割り当てられている利用者（${r.user_count}人）や、グループとの対応も解除されます。よろしいですか？`,
      confirmLabel: "削除する",
      onConfirm: async () => {
        await deleteRole(r.id);
        setConfirm(null);
        await load();
      },
    });
  }

  // ---------- モックデータの初期化（DF専用） ----------
  function openMockReset() {
    setConfirm({
      title: "モックデータを初期化",
      message:
        "この環境に登録・編集・削除した内容をすべて消して、もともとのモックデータだけの状態に戻します。テスト用に追加したデータは失われ、元に戻せません。実行してよろしいですか？",
      confirmLabel: "初期化する",
      onConfirm: async () => {
        setResetMsg(null);
        try {
          const r = await runMockReset();
          setResetMsg(
            `初期化が完了しました（${r.tables}テーブル・${r.duration_ms}ミリ秒）。` +
              `契約 ${r.counts_after.contracts ?? "?"} 件・口座 ${r.counts_after.accounts ?? "?"} 件などの初期状態に戻しました。`,
          );
          setConfirm(null);
          await load();
        } catch (e: any) {
          setConfirm(null);
          setError(e?.message ?? "初期化に失敗しました");
        }
      },
    });
  }

  // ---------- 着信拒否 ----------
  function denyFields(): FormField[] {
    return [
      { key: "phone_number", label: "電話番号", type: "text", required: true, placeholder: "例）03-1234-5678" },
      { key: "reason_code", label: "理由", type: "select", required: true, options: DENY_REASON_OPTIONS },
      { key: "reason_note", label: "補足メモ", type: "textarea", placeholder: "任意で理由の詳細を記入できます" },
      { key: "company_id", label: "会社（任意）", type: "select", options: companyOptions },
    ];
  }

  function openApplyDeny() {
    setDlg({
      title: "着信拒否を申請",
      fields: denyFields(),
      initial: { reason_code: "1" },
      submitLabel: "申請する",
      onSubmit: async (v) => {
        await createDeny({
          phone_number: String(v.phone_number ?? "").trim(),
          reason_code: String(v.reason_code || "1"),
          reason_note: String(v.reason_note ?? "").trim() || null,
          company_id: String(v.company_id ?? "").trim() || null,
        });
        setDlg(null);
        await load();
      },
    });
  }

  function openEditDeny(d: DenyItem) {
    setDlg({
      title: "着信拒否の内容を編集",
      fields: denyFields(),
      initial: {
        phone_number: d.phone_number,
        reason_code: d.reason_code,
        reason_note: d.reason_note ?? "",
        company_id: d.company_id ?? "",
      },
      submitLabel: "保存する",
      onSubmit: async (v) => {
        await updateDeny(d.id, {
          phone_number: String(v.phone_number ?? "").trim(),
          reason_code: String(v.reason_code || "1"),
          reason_note: String(v.reason_note ?? "").trim() || null,
          company_id: String(v.company_id ?? "").trim() || null,
        });
        setDlg(null);
        await load();
      },
    });
  }

  function openApproveDeny(d: DenyItem) {
    setConfirm({
      title: "着信拒否を承認",
      message: `電話番号「${d.phone_number}」の着信拒否を承認し、有効にします。よろしいですか？`,
      confirmLabel: "承認する",
      onConfirm: async () => {
        await approveDeny(d.id);
        setConfirm(null);
        await load();
      },
    });
  }

  function openRejectDeny(d: DenyItem) {
    setDlg({
      title: "着信拒否を却下",
      fields: [
        { key: "note", label: "却下の理由（任意）", type: "textarea", placeholder: "却下の理由を記入できます" },
      ],
      submitLabel: "却下する",
      onSubmit: async (v) => {
        await rejectDeny(d.id, String(v.note ?? "").trim() || null);
        setDlg(null);
        await load();
      },
    });
  }

  function openLiftDeny(d: DenyItem) {
    setConfirm({
      title: "着信拒否の解除",
      message: `電話番号「${d.phone_number}」の着信拒否を解除します（記録は残ります）。よろしいですか？`,
      confirmLabel: "解除する",
      onConfirm: async () => {
        await liftDeny(d.id);
        setConfirm(null);
        await load();
      },
    });
  }

  function openDelDeny(d: DenyItem) {
    setConfirm({
      title: "着信拒否の削除",
      message: `電話番号「${d.phone_number}」の着信拒否の記録を削除します。よろしいですか？`,
      confirmLabel: "削除する",
      onConfirm: async () => {
        await deleteDeny(d.id);
        setConfirm(null);
        await load();
      },
    });
  }

  function denyOps(d: DenyItem): ReactNode {
    const ops: ReactNode[] = [];
    if (d.approval_status === "1") {
      ops.push(
        <Button key="ap" size="small" appearance="primary" icon={<Checkmark16Regular />} onClick={() => openApproveDeny(d)}>
          承認
        </Button>,
        <Button key="rj" size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => openRejectDeny(d)}>
          却下
        </Button>,
        <Button key="ed" size="small" appearance="subtle" icon={<Edit16Regular />} onClick={() => openEditDeny(d)}>
          編集
        </Button>
      );
    } else if (d.approval_status === "2" && d.is_active) {
      ops.push(
        <Button key="lf" size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => openLiftDeny(d)}>
          解除
        </Button>,
        <Button key="ed" size="small" appearance="subtle" icon={<Edit16Regular />} onClick={() => openEditDeny(d)}>
          編集
        </Button>
      );
    } else {
      ops.push(
        <Button key="dl" size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => openDelDeny(d)}>
          削除
        </Button>
      );
    }
    return <div className={s.ops}>{ops}</div>;
  }

  const auditRows = (data?.audit ?? []).filter((a) => {
    const q = auditQ.trim().toLowerCase();
    if (!q) return true;
    return [a.actor_name, a.entity_type, a.action, a.entity_id].some((x) =>
      String(x ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <div className={s.header}>
        <Title3>管理</Title3>
      </div>
      <div className={s.crumb}>
        ユーザー・ロール権限・コードマスタ（分類・区分）・着信拒否リスト・監査ログ・通知を管理できます。ユーザーと分類・区分は追加／編集／削除、着信拒否は申請→承認／却下・解除・編集、監査ログは検索と変更前後の確認ができます。
      </div>

      <div className={s.toolbar}>
        <Button icon={<ArrowClockwise20Regular />} onClick={load} appearance="secondary">
          更新
        </Button>
        <div style={{ flexGrow: 1 }} />
        {tab === "users" && (
          <Button icon={<Add20Regular />} onClick={openAddUser} appearance="primary">
            ユーザーを追加
          </Button>
        )}
        {tab === "deny" && (
          <Button icon={<Add20Regular />} onClick={openApplyDeny} appearance="primary">
            着信拒否を申請
          </Button>
        )}
        {tab === "audit" && (
          <Input
            value={auditQ}
            onChange={(_, d) => setAuditQ(d.value)}
            contentBefore={<Search16Regular />}
            placeholder="担当・対象・操作で検索"
            style={{ width: 260 }}
          />
        )}
      </div>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)} style={{ marginBottom: 8 }}>
        <Tab value="users">ユーザー（{data?.users.length ?? 0}）</Tab>
        <Tab value="roles">ロール・権限</Tab>
        <Tab value="masters">コードマスタ（{data?.code_masters.length ?? 0}）</Tab>
        <Tab value="deny">着信拒否（{data?.deny_list.length ?? 0}）</Tab>
        <Tab value="audit">監査ログ（{data?.audit.length ?? 0}）</Tab>
        <Tab value="notifications">通知（{data?.notifications.length ?? 0}）</Tab>
        {data?.mock_reset?.enabled && <Tab value="maintenance">メンテナンス</Tab>}
      </TabList>

      <div className={s.card}>
        {loading && !data ? (
          <div style={{ padding: 24 }}>
            <Spinner label="読み込み中…" />
          </div>
        ) : tab === "users" ? (
          <Table aria-label="ユーザー" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>氏名</TableHeaderCell>
                <TableHeaderCell>ユーザー名（UPN）</TableHeaderCell>
                <TableHeaderCell>メール</TableHeaderCell>
                <TableHeaderCell>状態</TableHeaderCell>
                <TableHeaderCell>内線</TableHeaderCell>
                <TableHeaderCell>通知先</TableHeaderCell>
                <TableHeaderCell>Discord連携</TableHeaderCell>
                <TableHeaderCell>最終サインイン</TableHeaderCell>
                <TableHeaderCell>操作</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.users ?? []).map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.display_name}</TableCell>
                  <TableCell className={s.wrap}>{u.user_principal_name}</TableCell>
                  <TableCell className={s.wrap}>{u.mail ?? "—"}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={userStatusAppearance(u.status)}>
                      {userStatusLabel(u.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className={s.mono}>
                    {u.cti_ext_num || "—"}
                    {u.cti_ext_num && !u.has_cti_password ? "（PW未設定）" : ""}
                  </TableCell>
                  <TableCell>{notifyChannelLabel(u.notify_channel)}</TableCell>
                  <TableCell>{boolLabel(!!u.discord_user_id)}</TableCell>
                  <TableCell>{u.last_signed_in_at ? fmtDateTime(u.last_signed_in_at) : "—"}</TableCell>
                  <TableCell>
                    <div className={s.ops}>
                      <Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={() => openEditUser(u)}>
                        編集
                      </Button>
                      <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => openDelUser(u)}>
                        削除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(data?.users.length ?? 0) === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={9}>
                    <Body1>ユーザーがありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        ) : tab === "roles" ? (
          <div style={{ display: "flex", flexDirection: "column", rowGap: 16 }}>
            <div className={s.note}>
              サインインは Microsoft Entra ID（会社アカウント）で行います。利用者ができる操作は「ロール」で決まり、
              ロールは所属する Entra の「セキュリティグループ」から、サインインのたびに自動で割り当てられます。
              ロールには「見られる画面」と「できる操作」を細かく設定でき、必要に応じて独自の
              「カスタムロール」を作れます。下の表でロールを整え、その下の表で、どのグループにどのロールを割り当てるかを設定してください。
            </div>

            <div className={s.masterSection}>
              <div className={s.masterHead}>
                <Subtitle2>ロールの一覧（できること）</Subtitle2>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  {(data?.roles ?? []).length}件
                </Caption1>
                <div style={{ flexGrow: 1 }} />
                <Button
                  size="small"
                  appearance="primary"
                  icon={<Add20Regular />}
                  onClick={openAddRole}
                >
                  ロールを追加
                </Button>
              </div>
              <Table aria-label="ロール一覧" size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>ロール</TableHeaderCell>
                    <TableHeaderCell>識別子</TableHeaderCell>
                    <TableHeaderCell>見られる画面／できる操作</TableHeaderCell>
                    <TableHeaderCell>付与人数</TableHeaderCell>
                    <TableHeaderCell>操作</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.roles ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5}>ロールがまだ登録されていません。</TableCell>
                    </TableRow>
                  ) : (
                    (data?.roles ?? []).map((r) => {
                      const screens = r.permissions.filter((k) => k.startsWith("screen."));
                      const actions = r.permissions.filter((k) => k.startsWith("action."));
                      const nameOf = (k: string) =>
                        (data?.permissions ?? []).find((p) => p.perm_key === k)?.perm_name ?? k;
                      return (
                        <TableRow key={r.id}>
                          <TableCell>
                            {r.role_name}
                            <br />
                            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                              {r.description || ROLE_DESC[r.role_key] || ""}
                            </Caption1>
                          </TableCell>
                          <TableCell className={s.mono}>
                            {r.role_key}
                            <br />
                            <Badge
                              appearance="tint"
                              color={r.is_builtin ? "informative" : "success"}
                              size="small"
                            >
                              {r.is_builtin ? "標準" : "カスタム"}
                            </Badge>
                          </TableCell>
                          <TableCell className={s.wrap}>
                            <div>
                              画面 {screens.length}／操作 {actions.length}
                            </div>
                            <div
                              style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}
                              title={screens.map(nameOf).join("、")}
                            >
                              {actions.map((k) => (
                                <Badge key={k} appearance="outline" size="small">
                                  {nameOf(k)}
                                </Badge>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className={s.mono}>{r.user_count}人</TableCell>
                          <TableCell>
                            <div className={s.ops}>
                              <Button
                                size="small"
                                icon={<Edit16Regular />}
                                onClick={() => openEditRole(r)}
                              >
                                編集
                              </Button>
                              {!r.is_builtin && (
                                <Button
                                  size="small"
                                  icon={<Delete16Regular />}
                                  onClick={() => openDelRole(r)}
                                >
                                  削除
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
              <div className={s.note}>
                ※「標準」ロールは名前・説明・権限を編集できます（削除は不可）。「カスタム」ロールは
                「ロールを追加」から自由に作成でき、編集・削除もできます。各ロールに「見られる画面」と
                「できる操作」を割り当ててください。管理画面は、安全のため管理者だけが使えます。
              </div>
            </div>

            <div className={s.masterSection}>
              <div className={s.masterHead}>
                <Subtitle2>セキュリティグループとロールの対応</Subtitle2>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  {(data?.group_role_maps ?? []).length}件
                </Caption1>
                <div style={{ flexGrow: 1 }} />
                <Button
                  size="small"
                  appearance="primary"
                  icon={<Add20Regular />}
                  onClick={openAddGroupMap}
                  disabled={(data?.roles ?? []).length === 0}
                >
                  対応を追加
                </Button>
              </div>
              <Table aria-label="グループとロールの対応" size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>グループ名</TableHeaderCell>
                    <TableHeaderCell>グループ ID（GUID）</TableHeaderCell>
                    <TableHeaderCell>割り当てるロール</TableHeaderCell>
                    <TableHeaderCell>操作</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.group_role_maps ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4}>
                        まだ対応が登録されていません。「対応を追加」から設定してください。
                      </TableCell>
                    </TableRow>
                  ) : (
                    (data?.group_role_maps ?? []).map((m) => (
                      <TableRow key={`${m.entra_group_id}:${m.role_id}`}>
                        <TableCell>
                          {m.entra_group_name || (
                            <span style={{ color: tokens.colorNeutralForeground3 }}>（名称未設定）</span>
                          )}
                        </TableCell>
                        <TableCell className={s.mono}>{m.entra_group_id}</TableCell>
                        <TableCell>
                          <Badge appearance="tint">{m.role_name}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className={s.ops}>
                            <Button
                              size="small"
                              icon={<Edit16Regular />}
                              onClick={() => openRenameGroupMap(m)}
                            >
                              名前
                            </Button>
                            <Button
                              size="small"
                              icon={<Dismiss16Regular />}
                              onClick={() => openDelGroupMap(m)}
                            >
                              解除
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              <div className={s.note}>
                ※ グループ ID（GUID）は、Microsoft Entra 管理センターで対象のセキュリティグループを開いたときの
                「オブジェクト ID」です。口座番号・カード番号などの機微情報は、承認を受けたときだけ一定時間フル表示され、
                閲覧はすべて監査ログに記録されます。
              </div>
            </div>
          </div>
        ) : tab === "masters" ? (
          <div style={{ display: "flex", flexDirection: "column", rowGap: 16 }}>
            <div className={s.note}>
              各画面の選択肢（ドロップダウン）に出てくる区分を、項目ごとに分けて管理できます。項目の中の「追加」を押すと、その項目の区分として登録されます。使わなくなった区分は、削除せず「編集」で“有効”をオフにすると選択肢から隠せます。
            </div>
            {CATEGORY_OPTIONS.map((cat) => {
              const rows = (data?.code_masters ?? []).filter((m) => m.category === cat.value);
              return (
                <div key={cat.value} className={s.masterSection}>
                  <div className={s.masterHead}>
                    <Subtitle2>{cat.label}</Subtitle2>
                    <Caption1 className={s.mono} style={{ color: tokens.colorNeutralForeground3 }}>
                      {cat.value}・{rows.length}件
                    </Caption1>
                    <div style={{ flexGrow: 1 }} />
                    <Button
                      size="small"
                      appearance="secondary"
                      icon={<Add20Regular />}
                      onClick={() => openAddMaster(cat.value)}
                    >
                      追加
                    </Button>
                  </div>
                  <Table aria-label={cat.label} size="small">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>コード</TableHeaderCell>
                        <TableHeaderCell>表示名</TableHeaderCell>
                        <TableHeaderCell>並び順</TableHeaderCell>
                        <TableHeaderCell>状態</TableHeaderCell>
                        <TableHeaderCell>操作</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell className={s.mono}>{m.code}</TableCell>
                          <TableCell>{m.label}</TableCell>
                          <TableCell className={s.mono}>{m.sort_order ?? "—"}</TableCell>
                          <TableCell>
                            <Badge appearance="tint" color={m.is_active ? "success" : "subtle"}>
                              {m.is_active ? "有効" : "無効"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className={s.ops}>
                              <Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={() => openEditMaster(m)}>
                                編集
                              </Button>
                              <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => openDelMaster(m)}>
                                削除
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                      {rows.length === 0 && !loading && (
                        <TableRow>
                          <TableCell colSpan={5}>
                            <Body1>この項目にはまだ区分がありません。右上の「追加」から登録できます。</Body1>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              );
            })}
          </div>
        ) : tab === "deny" ? (
          <Table aria-label="着信拒否" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>電話番号</TableHeaderCell>
                <TableHeaderCell>理由</TableHeaderCell>
                <TableHeaderCell>補足</TableHeaderCell>
                <TableHeaderCell>会社</TableHeaderCell>
                <TableHeaderCell>承認状態</TableHeaderCell>
                <TableHeaderCell>拒否</TableHeaderCell>
                <TableHeaderCell>申請者</TableHeaderCell>
                <TableHeaderCell>操作</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.deny_list ?? []).map((d) => (
                <TableRow key={d.id}>
                  <TableCell className={s.mono}>{d.phone_number}</TableCell>
                  <TableCell>{denyReasonLabel(d.reason_code)}</TableCell>
                  <TableCell className={s.wrap}>
                    {d.reason_note ?? "—"}
                    {d.approval_status === "3" && d.reject_note ? (
                      <div style={{ color: tokens.colorPaletteRedForeground1, fontSize: 12 }}>却下理由：{d.reject_note}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>{d.company_name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={denyApprovalAppearance(d.approval_status)}>
                      {denyApprovalLabel(d.approval_status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={d.is_active ? "danger" : "subtle"}>
                      {d.is_active ? "有効" : "無効"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {d.created_by_name ?? "—"}
                    <div style={{ color: tokens.colorNeutralForeground3, fontSize: 12 }}>
                      {d.created_at ? fmtDate(d.created_at) : ""}
                    </div>
                  </TableCell>
                  <TableCell>{denyOps(d)}</TableCell>
                </TableRow>
              ))}
              {(data?.deny_list.length ?? 0) === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={8}>
                    <Body1>着信拒否の登録がありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        ) : tab === "audit" ? (
          <Table aria-label="監査ログ" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>日時</TableHeaderCell>
                <TableHeaderCell>対象</TableHeaderCell>
                <TableHeaderCell>対象ID</TableHeaderCell>
                <TableHeaderCell>操作</TableHeaderCell>
                <TableHeaderCell>担当</TableHeaderCell>
                <TableHeaderCell>変更内容</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditRows.map((a) => {
                const open = auditOpen.has(a.id);
                const hasDetail = a.before_json != null || a.after_json != null;
                return (
                  <Fragment key={a.id}>
                    <TableRow>
                      <TableCell>{fmtDateTime(a.acted_at)}</TableCell>
                      <TableCell className={s.mono}>{a.entity_type}</TableCell>
                      <TableCell className={s.mono}>{a.entity_id ?? "—"}</TableCell>
                      <TableCell>{a.action}</TableCell>
                      <TableCell>{a.actor_name ?? "—"}</TableCell>
                      <TableCell>
                        {hasDetail ? (
                          <Button size="small" appearance="subtle" onClick={() => toggleAudit(a.id)}>
                            {open ? "閉じる" : "詳細"}
                          </Button>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow>
                        <TableCell colSpan={6}>
                          <div className={s.diffWrap}>
                            <div className={s.diffCol}>
                              <div className={s.diffLabel}>変更前</div>
                              <pre className={s.pre}>{fmtJson(a.before_json)}</pre>
                            </div>
                            <div className={s.diffCol}>
                              <div className={s.diffLabel}>変更後</div>
                              <pre className={s.pre}>{fmtJson(a.after_json)}</pre>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
              {auditRows.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Body1>{auditQ.trim() ? "条件に合う監査ログがありません。" : "監査ログがありません。"}</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        ) : tab === "maintenance" ? (
          <div style={{ padding: "12px 4px", display: "grid", rowGap: 12, maxWidth: 760 }}>
            <MessageBar intent="warning">
              <MessageBarBody>
                <strong>この環境（DF・動作確認用）だけの機能です。</strong>{" "}
                毎日 {data?.mock_reset?.at ?? "00:00"}（日本時間）に、登録・編集・削除した内容をすべて消して、
                もともと用意しているモックデータだけの状態へ自動で戻します。下のボタンでいますぐ戻すこともできます。
              </MessageBarBody>
            </MessageBar>

            {resetMsg && (
              <MessageBar intent="success">
                <MessageBarBody>{resetMsg}</MessageBarBody>
              </MessageBar>
            )}

            <div className={s.card} style={{ padding: 16, display: "grid", rowGap: 12 }}>
              <div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>次回の自動初期化</Caption1>
                <div>{data?.mock_reset?.next_run ? `${fmtDateTime(data.mock_reset.next_run)}（日本時間）` : "—"}</div>
              </div>
              <div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>直近の初期化</Caption1>
                <div>
                  {data?.mock_reset?.last_run
                    ? `${fmtDateTime(data.mock_reset.last_run.at)}（${
                        data.mock_reset.last_run.trigger === "scheduler" ? "自動" : "手動"
                      }・${data.mock_reset.last_run.duration_ms}ミリ秒）`
                    : "まだ実行されていません"}
                </div>
              </div>
              <div>
                <Button appearance="primary" icon={<ArrowClockwise20Regular />} onClick={openMockReset}>
                  いますぐ初期化する
                </Button>
              </div>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                ※ 元に戻せません。テスト用に追加したデータはすべて消え、口座・カードの実番号や権限設定なども“お手本”の状態に戻ります。
              </Caption1>
            </div>
          </div>
        ) : (
          <Table aria-label="通知" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>種別</TableHeaderCell>
                <TableHeaderCell>状態</TableHeaderCell>
                <TableHeaderCell>送信日時</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.notifications ?? []).map((n) => (
                <TableRow key={n.id}>
                  <TableCell>{n.notification_type}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={n.status === "sent" || n.status === "posted" ? "success" : "warning"}>
                      {n.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{n.posted_at ? fmtDateTime(n.posted_at) : "—"}</TableCell>
                </TableRow>
              ))}
              {(data?.notifications.length ?? 0) === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={3}>
                    <Body1>通知の記録がありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {dlg && (
        <FormDialog
          open={!!dlg}
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
          open={!!confirm}
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
