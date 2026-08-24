import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  makeStyles,
  tokens,
  Title3,
  Body1,
  Input,
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
import { Search20Regular, ArrowClockwise20Regular, Open16Regular } from "@fluentui/react-icons";
import { fetchLawsuits, LawsuitListItem } from "../api/client";
import { fmtYen, fmtDate, fmtDateTime, lawsuitStatusAppearance } from "../util/format";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: "4px",
  },
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "12px" },
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

export default function Litigation() {
  const s = useStyles();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<LawsuitListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchLawsuits({ q });
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
        <Title3>訴訟</Title3>
        <span className={s.count}>{loading ? "読み込み中…" : `${total} 件`}</span>
      </div>
      <div className={s.crumb}>
        訴訟・法的手続きの一覧です。行をクリックすると、当事者・期日・提出書類・経過メモの詳細を確認できます。
      </div>

      <div className={s.toolbar}>
        <Input
          className={s.search}
          value={q}
          onChange={(_, d) => setQ(d.value)}
          placeholder="契約番号・事件番号・裁判所で検索"
          contentBefore={<Search20Regular />}
        />
        <Button icon={<ArrowClockwise20Regular />} onClick={load} appearance="secondary">
          更新
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
          <Table aria-label="訴訟一覧" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>契約番号</TableHeaderCell>
                <TableHeaderCell>手続</TableHeaderCell>
                <TableHeaderCell>事件番号</TableHeaderCell>
                <TableHeaderCell>裁判所</TableHeaderCell>
                <TableHeaderCell>相手方</TableHeaderCell>
                <TableHeaderCell>訴額</TableHeaderCell>
                <TableHeaderCell>状態</TableHeaderCell>
                <TableHeaderCell>次回期日</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((l) => (
                <TableRow key={l.id} className={s.row} onClick={() => navigate(`/litigation/${l.id}`)}>
                  <TableCell className={s.mono}>{l.contract_no}</TableCell>
                  <TableCell>{l.proc_type ?? "—"}</TableCell>
                  <TableCell className={s.mono}>{l.case_number ?? "—"}</TableCell>
                  <TableCell>{l.court_name ?? "—"}</TableCell>
                  <TableCell>{l.opponent_name ?? "—"}</TableCell>
                  <TableCell className={s.mono}>{fmtYen(l.claim_amount)}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={lawsuitStatusAppearance(l.status)}>
                      {l.status ?? "—"}
                    </Badge>
                  </TableCell>
                  <TableCell>{l.next_schedule_at ? fmtDateTime(l.next_schedule_at) : "—"}</TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Open16Regular />}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/litigation/${l.id}`);
                      }}
                    >
                      詳細
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={9}>
                    <Body1>該当する訴訟がありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
