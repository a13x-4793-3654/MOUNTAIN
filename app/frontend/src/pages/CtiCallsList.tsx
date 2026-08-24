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
  CallInbound20Regular,
  CallOutbound20Regular,
} from "@fluentui/react-icons";
import { fetchCalls, CallListItem } from "../api/client";
import {
  callDirectionLabel,
  callResultLabel,
  callResultAppearance,
  fmtDuration,
  fmtDateTime,
  boolLabel,
} from "../util/format";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: "4px",
  },
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "12px" },
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
  dir: { display: "flex", alignItems: "center", columnGap: "6px" },
  inbound: { color: tokens.colorPaletteGreenForeground1 },
  outbound: { color: tokens.colorBrandForeground1 },
});

const DIRECTION_OPTIONS = [
  { code: "in", label: "着信" },
  { code: "out", label: "発信" },
];
const RESULT_OPTIONS = [
  { code: "answered", label: "応答" },
  { code: "missed", label: "不応答" },
  { code: "voicemail", label: "留守電" },
  { code: "transferred", label: "転送" },
];

export default function CtiCallsList() {
  const s = useStyles();
  const navigate = useNavigate();

  const [q, setQ] = useState("");
  const [direction, setDirection] = useState("");
  const [result, setResult] = useState("");
  const [items, setItems] = useState<CallListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchCalls({ q, direction, result });
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
  }, [q, direction, result]);

  const directionText = direction
    ? DIRECTION_OPTIONS.find((o) => o.code === direction)?.label ?? ""
    : "";
  const resultText = result
    ? RESULT_OPTIONS.find((o) => o.code === result)?.label ?? ""
    : "";

  return (
    <div>
      <div className={s.header}>
        <Title3>電話・CTI（通話履歴）</Title3>
        <span className={s.count}>{loading ? "読み込み中…" : `${total} 件`}</span>
      </div>
      <div className={s.crumb}>
        着信・発信の記録です。行をクリックすると、通話録音の再生と操作ログ（保留・転送・プッシュなど）を確認できます。通話は自動で契約にひも付きます。
      </div>

      <div className={s.toolbar}>
        <Input
          className={s.search}
          value={q}
          onChange={(_, d) => setQ(d.value)}
          placeholder="電話番号・通話ID・契約番号で検索"
          contentBefore={<Search20Regular />}
        />
        <Dropdown
          placeholder="種別: すべて"
          value={directionText}
          selectedOptions={direction ? [direction] : [""]}
          onOptionSelect={(_, d) => setDirection(d.optionValue ?? "")}
        >
          <Option value="">すべて</Option>
          {DIRECTION_OPTIONS.map((o) => (
            <Option key={o.code} value={o.code}>
              {o.label}
            </Option>
          ))}
        </Dropdown>
        <Dropdown
          placeholder="結果: すべて"
          value={resultText}
          selectedOptions={result ? [result] : [""]}
          onOptionSelect={(_, d) => setResult(d.optionValue ?? "")}
        >
          <Option value="">すべて</Option>
          {RESULT_OPTIONS.map((o) => (
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
          <Table aria-label="通話履歴" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>種別</TableHeaderCell>
                <TableHeaderCell>相手番号</TableHeaderCell>
                <TableHeaderCell>日時</TableHeaderCell>
                <TableHeaderCell>通話時間</TableHeaderCell>
                <TableHeaderCell>結果</TableHeaderCell>
                <TableHeaderCell>録音</TableHeaderCell>
                <TableHeaderCell>契約番号</TableHeaderCell>
                <TableHeaderCell>対応者</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c) => {
                const other = c.direction === "out" ? c.to_number : c.from_number;
                return (
                  <TableRow
                    key={c.id}
                    className={s.row}
                    onClick={() => navigate(`/cti/${c.id}`)}
                  >
                    <TableCell>
                      <span className={s.dir}>
                        {c.direction === "out" ? (
                          <CallOutbound20Regular className={s.outbound} />
                        ) : (
                          <CallInbound20Regular className={s.inbound} />
                        )}
                        {callDirectionLabel(c.direction)}
                      </span>
                    </TableCell>
                    <TableCell className={s.mono}>{other ?? "—"}</TableCell>
                    <TableCell>{fmtDateTime(c.started_at)}</TableCell>
                    <TableCell className={s.mono}>
                      {fmtDuration(c.duration_seconds)}
                    </TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={callResultAppearance(c.call_result)}>
                        {callResultLabel(c.call_result)}
                      </Badge>
                    </TableCell>
                    <TableCell>{boolLabel(c.has_recording)}</TableCell>
                    <TableCell className={s.mono}>{c.contract_no ?? "—"}</TableCell>
                    <TableCell>{c.operator_name ?? "—"}</TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<Open16Regular />}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/cti/${c.id}`);
                        }}
                      >
                        開く
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {items.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={9}>
                    <Body1>該当する通話履歴がありません。</Body1>
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
