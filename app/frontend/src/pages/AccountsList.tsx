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
import {
  Search20Regular,
  ArrowClockwise20Regular,
  Open16Regular,
  Add20Regular,
} from "@fluentui/react-icons";
import { fetchAccounts, AccountListItem, createAccount } from "../api/client";
import { accountCategoryLabel, accountTypeLabel, boolLabel } from "../util/format";
import FormDialog from "../components/FormDialog";
import { ACCOUNT_FIELDS, toAccountIn } from "../util/formSchemas";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: "12px",
  },
  toolbar: {
    display: "flex",
    columnGap: "8px",
    rowGap: "8px",
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
  row: { cursor: "pointer" },
  count: { color: tokens.colorNeutralForeground3, fontSize: "12px" },
  mono: { fontVariantNumeric: "tabular-nums" },
  num: { fontVariantNumeric: "tabular-nums" },
});

const CATEGORY_OPTIONS = [
  { code: "bank", label: "銀行口座" },
  { code: "credit", label: "クレジットカード" },
];

export default function AccountsList() {
  const s = useStyles();
  const navigate = useNavigate();

  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [items, setItems] = useState<AccountListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAccounts({ q, category });
      setItems(res.items);
      setTotal(res.total);
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
  }, [q, category]);

  const categoryText = category
    ? CATEGORY_OPTIONS.find((o) => o.code === category)?.label ?? ""
    : "";

  return (
    <div>
      <div className={s.header}>
        <Title3>口座・カード一覧</Title3>
        <span className={s.count}>{loading ? "読み込み中…" : `${total} 件`}</span>
      </div>

      <div className={s.toolbar}>
        <Input
          className={s.search}
          value={q}
          onChange={(_, d) => setQ(d.value)}
          placeholder="銀行・ブランド・支店・名義カナで検索"
          contentBefore={<Search20Regular />}
        />
        <Dropdown
          placeholder="区分: すべて"
          value={categoryText}
          selectedOptions={category ? [category] : [""]}
          onOptionSelect={(_, d) => setCategory(d.optionValue ?? "")}
        >
          <Option value="">すべて</Option>
          {CATEGORY_OPTIONS.map((o) => (
            <Option key={o.code} value={o.code}>
              {o.label}
            </Option>
          ))}
        </Dropdown>
        <Button
          icon={<ArrowClockwise20Regular />}
          onClick={load}
          appearance="secondary"
        >
          更新
        </Button>
        <Button
          icon={<Add20Regular />}
          onClick={() => setCreateOpen(true)}
          appearance="primary"
        >
          新規登録
        </Button>
      </div>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.card}>
        {loading && items.length === 0 ? (
          <div style={{ padding: 24 }}>
            <Spinner label="読み込み中…" />
          </div>
        ) : (
          <Table aria-label="口座・カード一覧" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>区分</TableHeaderCell>
                <TableHeaderCell>銀行・ブランド</TableHeaderCell>
                <TableHeaderCell>支店</TableHeaderCell>
                <TableHeaderCell>番号（マスク）</TableHeaderCell>
                <TableHeaderCell>名義（カナ）</TableHeaderCell>
                <TableHeaderCell>有効期限</TableHeaderCell>
                <TableHeaderCell>有効</TableHeaderCell>
                <TableHeaderCell>契約数</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((a) => (
                <TableRow
                  key={a.id}
                  className={s.row}
                  onClick={() => navigate(`/accounts/${a.id}`)}
                >
                  <TableCell>
                    <Badge
                      appearance="tint"
                      color={a.account_category === "credit" ? "brand" : "informative"}
                    >
                      {accountCategoryLabel(a.account_category)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {a.account_category === "credit"
                      ? accountTypeLabel(a.account_type)
                      : (a.bank_name ?? "—")}
                  </TableCell>
                  <TableCell>{a.account_category === "credit" ? "—" : (a.branch_name ?? "—")}</TableCell>
                  <TableCell className={s.mono}>{a.account_no_masked ?? "—"}</TableCell>
                  <TableCell>{a.account_holder_kana ?? "—"}</TableCell>
                  <TableCell className={s.mono}>{a.expiry_mm_yy ?? "—"}</TableCell>
                  <TableCell>{boolLabel(a.is_active)}</TableCell>
                  <TableCell className={s.num}>{a.contract_count ?? 0}</TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Open16Regular />}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/accounts/${a.id}`);
                      }}
                    >
                      開く
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={9}>
                    <Body1>該当する口座・カードがありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      <FormDialog
        open={createOpen}
        title="口座・カードの新規登録"
        fields={ACCOUNT_FIELDS}
        initial={{ account_category: "bank", account_role: "self", account_type: "ordinary", is_active: true }}
        submitLabel="登録"
        onSubmit={async (v) => {
          await createAccount(toAccountIn(v));
          await load();
        }}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
