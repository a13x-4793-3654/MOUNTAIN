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
import { fetchCompanies, CompanyListItem, createCompany } from "../api/client";
import { companyStatusLabel, companyStatusAppearance } from "../util/format";
import FormDialog from "../components/FormDialog";
import { COMPANY_FIELDS, toCompanyIn } from "../util/formSchemas";

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
  name: { fontWeight: 600 },
  num: { fontVariantNumeric: "tabular-nums" },
});

const STATUS_OPTIONS = [
  { code: "0", label: "通常" },
  { code: "1", label: "注意" },
  { code: "2", label: "取引停止" },
];

export default function CompaniesList() {
  const s = useStyles();
  const navigate = useNavigate();

  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<CompanyListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchCompanies({ q, status });
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
  }, [q, status]);

  const statusText = status
    ? STATUS_OPTIONS.find((o) => o.code === status)?.label ?? ""
    : "";

  return (
    <div>
      <div className={s.header}>
        <Title3>会社一覧</Title3>
        <span className={s.count}>{loading ? "読み込み中…" : `${total} 件`}</span>
      </div>

      <div className={s.toolbar}>
        <Input
          className={s.search}
          value={q}
          onChange={(_, d) => setQ(d.value)}
          placeholder="会社名・カナ・市区町村で検索"
          contentBefore={<Search20Regular />}
        />
        <Dropdown
          placeholder="状態: すべて"
          value={statusText}
          selectedOptions={status ? [status] : [""]}
          onOptionSelect={(_, d) => setStatus(d.optionValue ?? "")}
        >
          <Option value="">すべて</Option>
          {STATUS_OPTIONS.map((o) => (
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
          <Table aria-label="会社一覧" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>会社名</TableHeaderCell>
                <TableHeaderCell>カナ</TableHeaderCell>
                <TableHeaderCell>所在地</TableHeaderCell>
                <TableHeaderCell>電話</TableHeaderCell>
                <TableHeaderCell>状態</TableHeaderCell>
                <TableHeaderCell>契約数</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c) => (
                <TableRow
                  key={c.id}
                  className={s.row}
                  onClick={() => navigate(`/companies/${c.id}`)}
                >
                  <TableCell className={s.name}>{c.company_name}</TableCell>
                  <TableCell>{c.company_name_kana ?? "—"}</TableCell>
                  <TableCell>
                    {(c.prefecture ?? "") + (c.city ?? "") || "—"}
                  </TableCell>
                  <TableCell>{c.phone ?? "—"}</TableCell>
                  <TableCell>
                    <Badge
                      appearance="tint"
                      color={companyStatusAppearance(c.status_flag)}
                    >
                      {companyStatusLabel(c.status_flag)}
                    </Badge>
                  </TableCell>
                  <TableCell className={s.num}>{c.contract_count ?? 0}</TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Open16Regular />}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/companies/${c.id}`);
                      }}
                    >
                      開く
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Body1>該当する会社がありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      <FormDialog
        open={createOpen}
        title="会社の新規登録"
        fields={COMPANY_FIELDS}
        initial={{ status_flag: "0" }}
        submitLabel="登録"
        onSubmit={async (v) => {
          await createCompany(toCompanyIn(v));
          await load();
        }}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
