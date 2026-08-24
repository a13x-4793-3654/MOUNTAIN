import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  makeStyles,
  tokens,
  Title3,
  Body1,
  Input,
  Dropdown,
  Option,
  Button,
  Badge,
  Spinner,
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { Search20Regular, ArrowClockwise20Regular, Add20Regular, Delete16Regular, Edit16Regular } from "@fluentui/react-icons";
import {
  fetchHousehold,
  HouseholdData,
  HouseholdEntry,
  fetchContracts,
  ContractListItem,
  createHousehold,
  updateHousehold,
  deleteHousehold,
} from "../api/client";
import { fmtYen, fmtDate, entryTypeLabel, entryTypeAppearance } from "../util/format";
import FormDialog, { FormField } from "../components/FormDialog";
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
  kpiNumIncome: { color: tokens.colorPaletteGreenForeground1 },
  kpiNumExpense: { color: tokens.colorPaletteRedForeground1 },
  toolbar: { display: "flex", columnGap: "8px", flexWrap: "wrap", marginBottom: "12px" },
  search: { minWidth: "280px" },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "4px 8px",
  },
  row: { cursor: "pointer" },
  mono: { fontVariantNumeric: "tabular-nums" },
  count: { color: tokens.colorNeutralForeground3, fontSize: "12px" },
});

const TYPE_OPTIONS = [
  { code: "income", label: "収入" },
  { code: "expense", label: "支出" },
];

export default function Household() {
  const s = useStyles();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [etype, setEtype] = useState("");
  const [data, setData] = useState<HouseholdData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editCtx, setEditCtx] = useState<HouseholdEntry | null>(null);
  const [delCtx, setDelCtx] = useState<HouseholdEntry | null>(null);
  const [contracts, setContracts] = useState<ContractListItem[]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchHousehold({ q, entry_type: etype }));
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
  }, [q, etype]);

  useEffect(() => {
    fetchContracts({}).then((r) => setContracts(r.items)).catch(() => {});
  }, []);

  const contractOptions = [
    { value: "", label: "（契約に紐づけない）" },
    ...contracts.map((c) => ({ value: c.id, label: `${c.contract_no}　${c.contract_summary ?? ""}`.trim() })),
  ];

  const hhFields = (): FormField[] => [
    { key: "entry_type", label: "収支", type: "select", required: true, options: TYPE_OPTIONS.map((o) => ({ value: o.code, label: o.label })) },
    { key: "used_on", label: "利用日", type: "date", required: true },
    { key: "amount", label: "金額（円）", type: "number", required: true },
    { key: "category_code", label: "分類（費目）", type: "text", required: true, placeholder: "例）食費・給与・家賃 など" },
    { key: "used_place", label: "利用先", type: "text", placeholder: "例）〇〇スーパー" },
    { key: "contract_id", label: "契約（任意）", type: "select", options: contractOptions },
  ];

  const k = data?.kpis ?? {};
  const typeText = etype ? TYPE_OPTIONS.find((o) => o.code === etype)?.label ?? "" : "";

  return (
    <div>
      <div className={s.header}>
        <Title3>家計簿</Title3>
        <span className={s.count}>{loading ? "読み込み中…" : `${k.entries_count ?? 0} 件`}</span>
      </div>
      <div className={s.crumb}>
        契約者の収入・支出の記録です。契約番号をクリックすると、その契約の詳細を開きます。
      </div>

      <div className={s.cards}>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>収入（合計）</span>
          <span className={`${s.kpiNum} ${s.kpiNumIncome}`}>{fmtYen(k.income_total as any)}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>支出（合計）</span>
          <span className={`${s.kpiNum} ${s.kpiNumExpense}`}>{fmtYen(k.expense_total as any)}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>収支</span>
          <span className={s.kpiNum}>{fmtYen(k.balance as any)}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>記録件数</span>
          <span className={s.kpiNum}>{k.entries_count ?? "—"}</span>
        </div>
      </div>

      <div className={s.toolbar}>
        <Input
          className={s.search}
          value={q}
          onChange={(_, d) => setQ(d.value)}
          placeholder="利用先・分類で検索"
          contentBefore={<Search20Regular />}
        />
        <Dropdown
          placeholder="収支: すべて"
          value={typeText}
          selectedOptions={etype ? [etype] : [""]}
          onOptionSelect={(_, d) => setEtype(d.optionValue ?? "")}
        >
          <Option value="">すべて</Option>
          {TYPE_OPTIONS.map((o) => (
            <Option key={o.code} value={o.code}>
              {o.label}
            </Option>
          ))}
        </Dropdown>
        <Button icon={<ArrowClockwise20Regular />} onClick={load} appearance="secondary">
          更新
        </Button>
        <div style={{ flexGrow: 1 }} />
        <Button icon={<Add20Regular />} onClick={() => setCreateOpen(true)} appearance="primary">
          収支を登録
        </Button>
      </div>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.card}>
        {loading && !data ? (
          <div style={{ padding: 24 }}>
            <Spinner label="読み込み中…" />
          </div>
        ) : (
          <Table aria-label="家計簿" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>利用日</TableHeaderCell>
                <TableHeaderCell>収支</TableHeaderCell>
                <TableHeaderCell>利用先</TableHeaderCell>
                <TableHeaderCell>分類</TableHeaderCell>
                <TableHeaderCell>金額</TableHeaderCell>
                <TableHeaderCell>契約番号</TableHeaderCell>
                <TableHeaderCell>操作</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.entries ?? []).map((e) => (
                <TableRow
                  key={e.id}
                  className={e.contract_id ? s.row : undefined}
                  onClick={() => e.contract_id && navigate(`/contracts/${e.contract_id}`)}
                >
                  <TableCell>{fmtDate(e.used_on)}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={entryTypeAppearance(e.entry_type)}>
                      {entryTypeLabel(e.entry_type)}
                    </Badge>
                  </TableCell>
                  <TableCell>{e.used_place ?? "—"}</TableCell>
                  <TableCell>{e.category_code ?? "—"}</TableCell>
                  <TableCell className={s.mono}>{fmtYen(e.amount)}</TableCell>
                  <TableCell className={s.mono}>{e.contract_no ?? "—"}</TableCell>
                  <TableCell onClick={(ev) => ev.stopPropagation()}>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Edit16Regular />}
                      onClick={() => setEditCtx(e)}
                    >
                      編集
                    </Button>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Delete16Regular />}
                      onClick={() => setDelCtx(e)}
                    >
                      削除
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(data?.entries.length ?? 0) === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Body1>該当する記録がありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      <FormDialog
        open={createOpen}
        title="収支を登録"
        fields={hhFields()}
        initial={{ entry_type: "expense" }}
        submitLabel="登録する"
        onSubmit={async (v) => {
          await createHousehold({
            entry_type: String(v.entry_type || "expense"),
            used_on: String(v.used_on),
            amount: Number(v.amount),
            category_code: String(v.category_code ?? "").trim(),
            used_place: String(v.used_place ?? "").trim() || null,
            contract_id: String(v.contract_id ?? "").trim() || null,
          });
          setCreateOpen(false);
          await load();
        }}
        onClose={() => setCreateOpen(false)}
      />

      {editCtx && (
        <FormDialog
          open={!!editCtx}
          title="収支を編集"
          fields={hhFields()}
          initial={{
            entry_type: editCtx.entry_type ?? "expense",
            used_on: editCtx.used_on ?? "",
            amount: editCtx.amount as any,
            category_code: editCtx.category_code ?? "",
            used_place: editCtx.used_place ?? "",
            contract_id: editCtx.contract_id ?? "",
          }}
          submitLabel="保存する"
          onSubmit={async (v) => {
            await updateHousehold(editCtx.id, {
              entry_type: String(v.entry_type || "expense"),
              used_on: String(v.used_on),
              amount: Number(v.amount),
              category_code: String(v.category_code ?? "").trim(),
              used_place: String(v.used_place ?? "").trim() || null,
              contract_id: String(v.contract_id ?? "").trim() || null,
            });
            setEditCtx(null);
            await load();
          }}
          onClose={() => setEditCtx(null)}
        />
      )}

      {delCtx && (
        <ConfirmDialog
          open={!!delCtx}
          title="収支の削除"
          message={`「${fmtDate(delCtx.used_on)}／${delCtx.category_code ?? ""}／${fmtYen(delCtx.amount)}」を削除します。よろしいですか？`}
          confirmLabel="削除する"
          onConfirm={async () => {
            await deleteHousehold(delCtx.id);
            setDelCtx(null);
            await load();
          }}
          onClose={() => setDelCtx(null)}
        />
      )}
    </div>
  );
}
