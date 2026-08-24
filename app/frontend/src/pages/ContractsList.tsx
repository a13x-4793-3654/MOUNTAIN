import { useEffect, useMemo, useState } from "react";
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
  ArrowDownload20Regular,
} from "@fluentui/react-icons";
import {
  fetchContracts,
  fetchMaster,
  ContractListItem,
  MasterItem,
  fetchCompanies,
  CompanyListItem,
  fetchPersons,
  PersonListItem,
  fetchUsers,
  UserLite,
  downloadContractsCsv,
} from "../api/client";
import { statusAppearance, reviewAppearance, fmtDate } from "../util/format";
import ContractCreateWizard from "../components/ContractCreateWizard";

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
  no: { fontVariantNumeric: "tabular-nums", fontWeight: 600 },
});

export default function ContractsList() {
  const s = useStyles();
  const navigate = useNavigate();

  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [statusMaster, setStatusMaster] = useState<MasterItem[]>([]);
  const [categoryMaster, setCategoryMaster] = useState<MasterItem[]>([]);
  const [items, setItems] = useState<ContractListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [companies, setCompanies] = useState<CompanyListItem[]>([]);
  const [persons, setPersons] = useState<PersonListItem[]>([]);
  const [users, setUsers] = useState<UserLite[]>([]);

  useEffect(() => {
    fetchMaster("contract_status").then(setStatusMaster).catch(() => {});
    fetchMaster("contract_category").then(setCategoryMaster).catch(() => {});
    fetchCompanies({}).then((r) => setCompanies(r.items)).catch(() => {});
    fetchPersons({}).then((r) => setPersons(r.items)).catch(() => {});
    fetchUsers().then(setUsers).catch(() => {});
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchContracts({ q, status, category });
      setItems(res.items);
      setTotal(res.total);
    } catch (e: any) {
      setError(e?.message ?? "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  // 絞り込み変更で自動再取得（検索語は軽くデバウンス）
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status, category]);

  async function onExport() {
    setExporting(true);
    setError(null);
    try {
      await downloadContractsCsv({ q, status, category });
    } catch (e: any) {
      setError(e?.message ?? "CSVの書き出しに失敗しました");
    } finally {
      setExporting(false);
    }
  }

  const statusText = useMemo(
    () => (status ? statusMaster.find((m) => m.code === status)?.label ?? status : ""),
    [status, statusMaster],
  );
  const categoryText = useMemo(
    () => (category ? categoryMaster.find((m) => m.code === category)?.label ?? category : ""),
    [category, categoryMaster],
  );

  const categoryOptions = categoryMaster.map((m) => ({ value: m.code, label: m.label }));
  const companyOptions = [
    { value: "", label: "（会社を選択しない）" },
    ...companies.map((c) => ({ value: c.id, label: c.company_name })),
  ];
  const personOptions = [
    { value: "", label: "（名義を選択しない）" },
    ...persons.map((p) => ({ value: p.id, label: p.full_name })),
  ];
  const userOptions = [
    { value: "", label: "（未定）" },
    ...users.map((u) => ({ value: u.id, label: u.display_name })),
  ];

  return (
    <div>
      <div className={s.header}>
        <Title3>契約一覧</Title3>
        <span className={s.count}>{loading ? "読み込み中…" : `${total} 件`}</span>
      </div>

      <div className={s.toolbar}>
        <Input
          className={s.search}
          value={q}
          onChange={(_, d) => setQ(d.value)}
          placeholder="契約番号・概要・会社・契約者で検索"
          contentBefore={<Search20Regular />}
        />
        <Dropdown
          placeholder="状態: すべて"
          value={statusText}
          selectedOptions={status ? [status] : [""]}
          onOptionSelect={(_, d) => setStatus(d.optionValue ?? "")}
        >
          <Option value="">すべて</Option>
          {statusMaster.map((m) => (
            <Option key={m.code} value={m.code}>
              {m.label}
            </Option>
          ))}
        </Dropdown>
        <Dropdown
          placeholder="区分: すべて"
          value={categoryText}
          selectedOptions={category ? [category] : [""]}
          onOptionSelect={(_, d) => setCategory(d.optionValue ?? "")}
        >
          <Option value="">すべて</Option>
          {categoryMaster.map((m) => (
            <Option key={m.code} value={m.code}>
              {m.label}
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
          icon={<ArrowDownload20Regular />}
          onClick={onExport}
          appearance="secondary"
          disabled={exporting || loading}
        >
          {exporting ? "書き出し中…" : "エクスポート"}
        </Button>
        <div style={{ flexGrow: 1 }} />
        <Button
          icon={<Add20Regular />}
          onClick={() => setCreateOpen(true)}
          appearance="primary"
        >
          新規契約
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
          <Table aria-label="契約一覧" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>契約番号</TableHeaderCell>
                <TableHeaderCell>概要</TableHeaderCell>
                <TableHeaderCell>区分</TableHeaderCell>
                <TableHeaderCell>状態</TableHeaderCell>
                <TableHeaderCell>審査</TableHeaderCell>
                <TableHeaderCell>会社</TableHeaderCell>
                <TableHeaderCell>契約者</TableHeaderCell>
                <TableHeaderCell>担当</TableHeaderCell>
                <TableHeaderCell>終了日</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c) => (
                <TableRow
                  key={c.id}
                  className={s.row}
                  onClick={() => navigate(`/contracts/${c.id}`)}
                >
                  <TableCell className={s.no}>{c.contract_no}</TableCell>
                  <TableCell>{c.contract_summary}</TableCell>
                  <TableCell>{c.category_label ?? c.contract_category}</TableCell>
                  <TableCell>
                    <Badge appearance="filled" color={statusAppearance(c.contract_status)}>
                      {c.status_label ?? c.contract_status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={reviewAppearance(c.review_status)}>
                      {c.review_label ?? c.review_status}
                    </Badge>
                  </TableCell>
                  <TableCell>{c.company_name ?? "—"}</TableCell>
                  <TableCell>{c.person_name ?? "—"}</TableCell>
                  <TableCell>{c.assignee_name ?? "—"}</TableCell>
                  <TableCell>{fmtDate(c.ended_at)}</TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Open16Regular />}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/contracts/${c.id}`);
                      }}
                    >
                      開く
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={10}>
                    <Body1>該当する契約がありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      <ContractCreateWizard
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={(id) => {
          setCreateOpen(false);
          navigate(`/contracts/${id}`);
        }}
        categoryOptions={categoryOptions}
        companyOptions={companyOptions}
        personOptions={personOptions}
        userOptions={userOptions}
      />
    </div>
  );
}
