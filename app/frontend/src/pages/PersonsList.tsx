import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  makeStyles,
  tokens,
  Title3,
  Body1,
  Input,
  Button,
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
import { fetchPersons, PersonListItem, createPerson } from "../api/client";
import { fmtDate } from "../util/format";
import FormDialog from "../components/FormDialog";
import { PERSON_FIELDS, toPersonIn } from "../util/formSchemas";

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

export default function PersonsList() {
  const s = useStyles();
  const navigate = useNavigate();

  const [q, setQ] = useState("");
  const [items, setItems] = useState<PersonListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPersons({ q });
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
  }, [q]);

  return (
    <div>
      <div className={s.header}>
        <Title3>名義一覧</Title3>
        <span className={s.count}>{loading ? "読み込み中…" : `${total} 件`}</span>
      </div>

      <div className={s.toolbar}>
        <Input
          className={s.search}
          value={q}
          onChange={(_, d) => setQ(d.value)}
          placeholder="氏名・カナ・市区町村で検索"
          contentBefore={<Search20Regular />}
        />
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
          <Table aria-label="名義一覧" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>氏名</TableHeaderCell>
                <TableHeaderCell>カナ</TableHeaderCell>
                <TableHeaderCell>生年月日</TableHeaderCell>
                <TableHeaderCell>所在地</TableHeaderCell>
                <TableHeaderCell>契約数</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow
                  key={p.id}
                  className={s.row}
                  onClick={() => navigate(`/persons/${p.id}`)}
                >
                  <TableCell className={s.name}>{p.full_name}</TableCell>
                  <TableCell>{p.full_name_kana ?? "—"}</TableCell>
                  <TableCell>{fmtDate(p.birth_date)}</TableCell>
                  <TableCell>
                    {(p.prefecture ?? "") + (p.city ?? "") || "—"}
                  </TableCell>
                  <TableCell className={s.num}>{p.contract_count ?? 0}</TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Open16Regular />}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/persons/${p.id}`);
                      }}
                    >
                      開く
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Body1>該当する名義がありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      <FormDialog
        open={createOpen}
        title="名義の新規登録"
        fields={PERSON_FIELDS}
        submitLabel="登録"
        onSubmit={async (v) => {
          await createPerson(toPersonIn(v));
          await load();
        }}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
