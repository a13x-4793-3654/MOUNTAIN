import { useEffect, useState } from "react";
import {
  makeStyles,
  tokens,
  Title3,
  Body1,
  Input,
  Button,
  Badge,
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
import {
  Search20Regular,
  ArrowClockwise20Regular,
  Add20Regular,
  Money20Regular,
  Edit20Regular,
  Delete20Regular,
} from "@fluentui/react-icons";
import {
  fetchBilling,
  BillingData,
  BillingClaim,
  BillingPayment,
  fetchContracts,
  ContractListItem,
  createPayment,
  createClaim,
  updateClaim,
  deleteClaim,
  updatePayment,
  deletePayment,
} from "../api/client";
import {
  fmtYen,
  fmtDate,
  claimStatusLabel,
  claimAppearance,
  claimCategoryLabel,
  allocAppearance,
  boolLabel,
} from "../util/format";
import FormDialog, { FormField, FormValues } from "../components/FormDialog";
import ConfirmDialog from "../components/ConfirmDialog";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: "4px",
  },
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "12px" },
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: "12px",
    marginBottom: "16px",
  },
  kpi: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    rowGap: "2px",
  },
  kpiLabel: { color: tokens.colorNeutralForeground2, fontSize: "12px" },
  kpiNum: { fontSize: "24px", fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  kpiNumWarn: { color: tokens.colorPaletteDarkOrangeForeground1 },
  kpiNumDanger: { color: tokens.colorPaletteRedForeground1 },
  toolbar: {
    display: "flex",
    columnGap: "8px",
    flexWrap: "wrap",
    alignItems: "center",
    marginBottom: "12px",
  },
  search: { minWidth: "280px" },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "4px 8px",
  },
  mono: { fontVariantNumeric: "tabular-nums" },
  count: { color: tokens.colorNeutralForeground3, fontSize: "12px" },
  rowActions: { display: "flex", columnGap: "6px", flexWrap: "nowrap" },
});

const METHOD_OPTIONS = [
  { value: "銀行振込", label: "銀行振込" },
  { value: "口座振替", label: "口座振替" },
  { value: "現金", label: "現金" },
  { value: "コンビニ", label: "コンビニ" },
  { value: "カード", label: "カード" },
  { value: "弁護士経由", label: "弁護士経由" },
  { value: "その他", label: "その他" },
];
const SOURCE_OPTIONS = [
  { value: "通常", label: "通常入金" },
  { value: "訴訟", label: "訴訟回収" },
  { value: "強制執行", label: "強制執行" },
  { value: "預り金充当", label: "預り金充当" },
  { value: "返金", label: "返金（マイナス）" },
];
const RECEIPT_OPTIONS = [
  { value: "", label: "（なし）" },
  { value: "領収書", label: "領収書" },
  { value: "領収書控え", label: "領収書控え" },
  { value: "コンビニ受領書", label: "コンビニ受領書" },
  { value: "振込明細", label: "振込明細" },
  { value: "QR決済明細", label: "QR決済明細" },
  { value: "その他", label: "その他" },
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
// 請求で受け付けられる支払方法（複数選択可・可視化用）
const CLAIM_METHOD_OPTIONS = [
  { value: "口座振替", label: "口座振替" },
  { value: "銀行振込", label: "銀行振込" },
  { value: "コンビニ", label: "コンビニ" },
  { value: "カード", label: "カード" },
  { value: "現金", label: "現金" },
  { value: "その他", label: "その他" },
];

export default function Billing() {
  const s = useStyles();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<string>("claims");
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contracts, setContracts] = useState<ContractListItem[]>([]);
  const [dlg, setDlg] = useState<{
    title: string;
    submitLabel?: string;
    fields: FormField[];
    initial: FormValues;
    onSubmit: (v: FormValues) => Promise<void>;
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    onConfirm: () => Promise<void>;
  } | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchBilling({ q }));
    } catch (e: any) {
      setError(e?.message ?? "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    fetchContracts({}).then((r) => setContracts(r.items)).catch(() => {});
  }, []);

  const contractOptions = contracts.map((c) => ({
    value: c.id,
    label: `${c.contract_no}　${c.contract_summary ?? ""}`.trim(),
  }));

  // 入金フォーム（withContract=trueで契約選択欄を表示）
  function payFields(withContract: boolean): FormField[] {
    const f: FormField[] = [];
    if (withContract) {
      f.push({
        key: "contract_id",
        label: "契約",
        type: "select",
        required: true,
        options: contractOptions,
        placeholder: "契約を選択してください",
      });
    }
    f.push(
      { key: "received_at", label: "入金日", type: "date", required: true },
      { key: "amount", label: "入金額（円）", type: "number", required: true, hint: "返金の場合はマイナスの金額を入力します" },
      { key: "received_method", label: "入金方法", type: "select", options: METHOD_OPTIONS },
      { key: "received_place", label: "入金場所・入金者", type: "text", placeholder: "例）本社／コンビニ／振込人名義" },
      { key: "source_type", label: "区分", type: "select", options: SOURCE_OPTIONS },
      { key: "receipt_type", label: "証票種別", type: "select", options: RECEIPT_OPTIONS },
    );
    return f;
  }
  function payBody(v: FormValues) {
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
  // 入金登録（prefillContractId を渡すと請求からの入金＝その契約を初期選択）
  function openAddPayment(prefillContractId?: string) {
    setDlg({
      title: "入金登録",
      submitLabel: "登録する",
      fields: payFields(true),
      initial: { contract_id: prefillContractId ?? "", source_type: "通常" },
      onSubmit: async (v) => {
        await createPayment({ contract_id: String(v.contract_id), ...payBody(v) });
      },
    });
  }
  function openEditPayment(p: BillingPayment) {
    setDlg({
      title: "入金の編集",
      submitLabel: "保存する",
      fields: payFields(false),
      initial: {
        received_at: (p.received_at ?? "").slice(0, 10),
        amount: String(p.amount ?? ""),
        received_method: p.received_method ?? "",
        source_type: p.source_type ?? "通常",
        receipt_type: p.receipt_type ?? "",
      },
      onSubmit: async (v) => {
        await updatePayment(p.id, payBody(v));
      },
    });
  }
  function delPayment(p: BillingPayment) {
    setConfirm({
      title: "入金の削除",
      message: "この入金記録を削除します。よろしいですか？",
      onConfirm: async () => {
        await deletePayment(p.id);
      },
    });
  }

  // 請求フォーム
  const claimBaseFields: FormField[] = [
    { key: "claim_category", label: "請求区分", type: "select", required: true, options: CLAIM_CATEGORIES },
    { key: "occurred_on", label: "計上日", type: "date", required: true },
    { key: "due_at", label: "支払期限", type: "date" },
    { key: "new_amount", label: "新規請求額（円）", type: "number" },
    { key: "carry_over_amount", label: "繰越額（円）", type: "number" },
    { key: "status", label: "状態", type: "select", required: true, options: CLAIM_STATUSES },
    { key: "methods", label: "支払方法（複数選択可）", type: "multiselect", required: true, options: CLAIM_METHOD_OPTIONS, hint: "この請求をどの方法で支払えるかを選びます（複数選べます）" },
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
      title: "請求を追加",
      submitLabel: "発行する",
      fields: [
        { key: "contract_id", label: "契約", type: "select", required: true, options: contractOptions, placeholder: "契約を選択してください" },
        ...claimBaseFields,
      ],
      initial: { contract_id: "", claim_category: "monthly", carry_over_amount: "0", status: "open", methods: "" },
      onSubmit: async (v) => {
        await createClaim(String(v.contract_id), claimBody(v));
      },
    });
  }
  function openEditClaim(c: BillingClaim) {
    setDlg({
      title: "請求の編集",
      submitLabel: "保存する",
      fields: claimBaseFields,
      initial: {
        claim_category: c.claim_category ?? "monthly",
        occurred_on: (c.occurred_on ?? "").slice(0, 10),
        due_at: (c.due_at ?? "").slice(0, 10),
        new_amount: String(c.claim_total_amount ?? ""),
        carry_over_amount: "0",
        status: c.status ?? "open",
        methods: (c.methods ?? []).join(","),
        memo: "",
      },
      onSubmit: async (v) => {
        await updateClaim(c.id, claimBody(v));
      },
    });
  }
  function delClaim(c: BillingClaim) {
    setConfirm({
      title: "請求の削除",
      message: "この請求を削除します。よろしいですか？",
      onConfirm: async () => {
        await deleteClaim(c.id);
      },
    });
  }

  const k = data?.kpis ?? {};

  return (
    <div>
      <div className={s.header}>
        <Title3>請求・入金</Title3>
        <span className={s.count}>{loading ? "読み込み中…" : ""}</span>
      </div>
      <div className={s.crumb}>
        すべての契約の請求（発生した支払い）と入金（受け取ったお金）をまとめて確認できます。
      </div>

      <div className={s.cards}>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>請求（件数）</span>
          <span className={s.kpiNum}>{k.claims_count ?? "—"}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>未入金（残額）</span>
          <span className={`${s.kpiNum} ${s.kpiNumWarn}`}>{fmtYen(k.unpaid_amount as any)}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>期日超過（件数）</span>
          <span className={`${s.kpiNum} ${s.kpiNumDanger}`}>{k.overdue_count ?? "—"}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>期日超過（金額）</span>
          <span className={`${s.kpiNum} ${s.kpiNumDanger}`}>{fmtYen(k.overdue_amount as any)}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>今月の入金</span>
          <span className={s.kpiNum}>{fmtYen(k.month_paid as any)}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>本日の入金</span>
          <span className={s.kpiNum}>{fmtYen(k.today_paid as any)}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>預り金（過入金）</span>
          <span className={s.kpiNum}>{fmtYen(k.advance_total as any)}</span>
        </div>
      </div>

      <div className={s.toolbar}>
        <Input
          className={s.search}
          value={q}
          onChange={(_, d) => setQ(d.value)}
          placeholder="契約番号・会社名で検索"
          contentBefore={<Search20Regular />}
        />
        <Button icon={<ArrowClockwise20Regular />} onClick={load} appearance="secondary">
          更新
        </Button>
        <div style={{ flexGrow: 1 }} />
        <Button icon={<Add20Regular />} onClick={openAddClaim} appearance="secondary">
          請求を追加
        </Button>
        <Button icon={<Add20Regular />} onClick={() => openAddPayment()} appearance="primary">
          入金登録
        </Button>
      </div>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)} style={{ marginBottom: 8 }}>
        <Tab value="claims">請求（{data?.claims.length ?? 0}）</Tab>
        <Tab value="payments">入金（{data?.payments.length ?? 0}）</Tab>
      </TabList>

      <div className={s.card}>
        {loading && !data ? (
          <div style={{ padding: 24 }}>
            <Spinner label="読み込み中…" />
          </div>
        ) : tab === "claims" ? (
          <Table aria-label="請求一覧" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>契約番号</TableHeaderCell>
                <TableHeaderCell>会社</TableHeaderCell>
                <TableHeaderCell>区分</TableHeaderCell>
                <TableHeaderCell>支払方法</TableHeaderCell>
                <TableHeaderCell>発生日</TableHeaderCell>
                <TableHeaderCell>請求額</TableHeaderCell>
                <TableHeaderCell>入金済</TableHeaderCell>
                <TableHeaderCell>残</TableHeaderCell>
                <TableHeaderCell>支払期限</TableHeaderCell>
                <TableHeaderCell>状態</TableHeaderCell>
                <TableHeaderCell>操作</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.claims ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell className={s.mono}>{c.contract_no}</TableCell>
                  <TableCell>{c.company_name ?? "—"}</TableCell>
                  <TableCell>{claimCategoryLabel(c.claim_category)}</TableCell>
                  <TableCell>
                    {(c.methods ?? []).length ? (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {(c.methods ?? []).map((m) => (
                          <Badge key={m} appearance="outline" color="informative">{m}</Badge>
                        ))}
                      </div>
                    ) : (
                      <span style={{ color: tokens.colorNeutralForeground3 }}>未設定</span>
                    )}
                  </TableCell>
                  <TableCell>{fmtDate(c.occurred_on)}</TableCell>
                  <TableCell className={s.mono}>{fmtYen(c.claim_total_amount)}</TableCell>
                  <TableCell className={s.mono}>{fmtYen(c.paid_amount as any)}</TableCell>
                  <TableCell className={s.mono}>{fmtYen(c.remaining_balance as any)}</TableCell>
                  <TableCell>{fmtDate(c.due_at)}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={claimAppearance(c.status)}>
                      {claimStatusLabel(c.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className={s.rowActions}>
                      <Button
                        size="small"
                        appearance="primary"
                        icon={<Money20Regular />}
                        onClick={() => openAddPayment(c.contract_id)}
                        title="この請求に入金を登録します（自動で消込されます）"
                      >
                        入金
                      </Button>
                      <Button size="small" icon={<Edit20Regular />} onClick={() => openEditClaim(c)} title="請求を編集">
                        編集
                      </Button>
                      <Button size="small" icon={<Delete20Regular />} onClick={() => delClaim(c)} title="請求を削除">
                        削除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(data?.claims.length ?? 0) === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={11}>
                    <Body1>該当する請求がありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        ) : (
          <Table aria-label="入金一覧" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>契約番号</TableHeaderCell>
                <TableHeaderCell>会社</TableHeaderCell>
                <TableHeaderCell>入金日</TableHeaderCell>
                <TableHeaderCell>金額</TableHeaderCell>
                <TableHeaderCell>入金方法</TableHeaderCell>
                <TableHeaderCell>区分</TableHeaderCell>
                <TableHeaderCell>証票</TableHeaderCell>
                <TableHeaderCell>消込状態</TableHeaderCell>
                <TableHeaderCell>操作</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.payments ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell className={s.mono}>{p.contract_no}</TableCell>
                  <TableCell>{p.company_name ?? "—"}</TableCell>
                  <TableCell>{fmtDate(p.received_at)}</TableCell>
                  <TableCell className={s.mono}>{fmtYen(p.amount)}</TableCell>
                  <TableCell>{p.received_method ?? "—"}</TableCell>
                  <TableCell>{p.source_type ?? "—"}</TableCell>
                  <TableCell>{p.receipt_type ?? boolLabel(p.has_receipt)}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={allocAppearance(p.alloc_status)}>
                      {p.alloc_status ?? "—"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className={s.rowActions}>
                      <Button size="small" icon={<Edit20Regular />} onClick={() => openEditPayment(p)} title="入金を編集">
                        編集
                      </Button>
                      <Button size="small" icon={<Delete20Regular />} onClick={() => delPayment(p)} title="入金を削除">
                        削除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(data?.payments.length ?? 0) === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={9}>
                    <Body1>該当する入金がありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      <FormDialog
        open={!!dlg}
        title={dlg?.title ?? ""}
        fields={dlg?.fields ?? []}
        initial={dlg?.initial ?? {}}
        submitLabel={dlg?.submitLabel}
        onSubmit={async (v) => {
          if (dlg) {
            await dlg.onSubmit(v);
            await load();
          }
        }}
        onClose={() => setDlg(null)}
      />

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ""}
        message={confirm?.message ?? ""}
        onConfirm={async () => {
          if (confirm) {
            await confirm.onConfirm();
            await load();
          }
        }}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
