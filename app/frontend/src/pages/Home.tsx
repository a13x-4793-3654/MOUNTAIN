import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  makeStyles,
  tokens,
  Title3,
  Subtitle2,
  Body1,
  Badge,
  Spinner,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import {
  DocumentBulletList20Regular,
  ClipboardTaskListLtr20Regular,
  MoneyHand20Regular,
  Gavel20Regular,
  Call20Regular,
  Mail20Regular,
  Money20Regular,
} from "@fluentui/react-icons";
import { fetchDashboard, DashboardData } from "../api/client";
import { fmtYen, fmtDateTime } from "../util/format";

const useStyles = makeStyles({
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "16px" },
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "12px",
    marginBottom: "16px",
  },
  kpi: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "14px 16px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    rowGap: "4px",
    transitionProperty: "box-shadow",
    transitionDuration: "120ms",
    ":hover": { boxShadow: tokens.shadow8 },
  },
  kpiLabel: {
    display: "flex",
    alignItems: "center",
    columnGap: "6px",
    color: tokens.colorNeutralForeground2,
    fontSize: "12px",
  },
  kpiNum: { fontSize: "28px", fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  kpiNumWarn: { color: tokens.colorPaletteDarkOrangeForeground1 },
  kpiNumDanger: { color: tokens.colorPaletteRedForeground1 },
  kpiSub: { color: tokens.colorNeutralForeground3, fontSize: "12px" },
  grid2: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
    "@media (max-width: 900px)": { gridTemplateColumns: "1fr" },
  },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "16px",
  },
  panelHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: "8px",
  },
  list: { display: "flex", flexDirection: "column" },
  item: {
    display: "flex",
    alignItems: "flex-start",
    columnGap: "10px",
    padding: "10px 4px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: "pointer",
  },
  itemIcon: { marginTop: "2px", color: tokens.colorNeutralForeground3 },
  itemBody: { display: "flex", flexDirection: "column", rowGap: "2px", minWidth: 0 },
  itemTitle: { fontWeight: 600 },
  itemDetail: { color: tokens.colorNeutralForeground3, fontSize: "12px" },
  empty: { color: tokens.colorNeutralForeground3, padding: "12px 4px" },
});

function severityColor(sev: string): "warning" | "danger" | "brand" | "informative" {
  if (sev === "danger") return "danger";
  if (sev === "warning") return "warning";
  if (sev === "info") return "brand";
  return "informative";
}

function taskIcon(kind: string) {
  if (kind === "review") return <ClipboardTaskListLtr20Regular />;
  if (kind === "claim") return <MoneyHand20Regular />;
  if (kind === "call") return <Call20Regular />;
  return <DocumentBulletList20Regular />;
}

function recentIcon(kind: string) {
  if (kind === "call") return <Call20Regular />;
  if (kind === "payment") return <Money20Regular />;
  return <Mail20Regular />;
}

export default function Home() {
  const s = useStyles();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchDashboard()
      .then((d) => setData(d))
      .catch((e) => setError(e?.message ?? "読み込みに失敗しました"))
      .finally(() => setLoading(false));
  }, []);

  const today = new Date();
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  const dateStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(
    today.getDate(),
  ).padStart(2, "0")}（${days[today.getDay()]}）`;

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
        <MessageBarBody>{error ?? "ダッシュボードを読み込めません"}</MessageBarBody>
      </MessageBar>
    );
  }

  const k = data.kpis;

  return (
    <div>
      <Title3>ホーム</Title3>
      <div className={s.crumb}>本日 {dateStr}　MOUNTAIN 債権・家計管理システム</div>

      <div className={s.cards}>
        <div className={s.kpi} onClick={() => navigate("/contracts")}>
          <span className={s.kpiLabel}>
            <DocumentBulletList20Regular />
            契約（全体）
          </span>
          <span className={s.kpiNum}>{k.contracts_total}</span>
          <span className={s.kpiSub}>
            延滞 {k.contracts_delinquent} / 訴訟 {k.contracts_litigation} / 対応中 {k.contracts_active}
          </span>
        </div>

        <div className={s.kpi} onClick={() => navigate("/contracts")}>
          <span className={s.kpiLabel}>
            <ClipboardTaskListLtr20Regular />
            未処理の審査
          </span>
          <span className={`${s.kpiNum} ${s.kpiNumWarn}`}>{k.reviews_pending}</span>
          <span className={s.kpiSub}>承認待ちの契約</span>
        </div>

        <div className={s.kpi} onClick={() => navigate("/contracts")}>
          <span className={s.kpiLabel}>
            <MoneyHand20Regular />
            期日超過の請求
          </span>
          <span className={`${s.kpiNum} ${s.kpiNumDanger}`}>{k.overdue_count}</span>
          <span className={s.kpiSub}>合計 {fmtYen(k.overdue_amount)}</span>
        </div>

        <div className={s.kpi} onClick={() => navigate("/contracts")}>
          <span className={s.kpiLabel}>
            <Gavel20Regular />
            進行中の訴訟
          </span>
          <span className={s.kpiNum}>{k.lawsuits_active}</span>
          <span className={s.kpiSub}>係争中の案件</span>
        </div>

        <div className={s.kpi} onClick={() => navigate("/cti")}>
          <span className={s.kpiLabel}>
            <Call20Regular />
            未応答の通話
          </span>
          <span className={`${s.kpiNum} ${s.kpiNumWarn}`}>{k.calls_missed}</span>
          <span className={s.kpiSub}>不応答・留守電</span>
        </div>
      </div>

      <div className={s.grid2}>
        <div className={s.panel}>
          <div className={s.panelHead}>
            <Subtitle2>対応が必要なこと</Subtitle2>
            <span className={s.kpiSub}>{data.tasks.length} 件</span>
          </div>
          {data.tasks.length === 0 ? (
            <div className={s.empty}>
              <Body1>対応が必要な項目はありません。</Body1>
            </div>
          ) : (
            <div className={s.list}>
              {data.tasks.map((t, i) => (
                <div key={i} className={s.item} onClick={() => navigate(t.to)}>
                  <span className={s.itemIcon}>{taskIcon(t.kind)}</span>
                  <div className={s.itemBody}>
                    <span className={s.itemTitle}>
                      <Badge appearance="tint" color={severityColor(t.severity)}>
                        {t.title}
                      </Badge>
                    </span>
                    <span className={s.itemDetail}>
                      {t.detail}
                      {t.due_at ? `　期日：${fmtDateTime(t.due_at)}` : ""}
                      {t.occurred_at ? `　${fmtDateTime(t.occurred_at)}` : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={s.panel}>
          <div className={s.panelHead}>
            <Subtitle2>最近のやり取り</Subtitle2>
          </div>
          {data.recent.length === 0 ? (
            <div className={s.empty}>
              <Body1>最近のやり取りはありません。</Body1>
            </div>
          ) : (
            <div className={s.list}>
              {data.recent.map((r, i) => (
                <div key={i} className={s.item} onClick={() => navigate(r.to)}>
                  <span className={s.itemIcon}>{recentIcon(r.kind)}</span>
                  <div className={s.itemBody}>
                    <span className={s.itemTitle}>{r.title}</span>
                    <span className={s.itemDetail}>
                      {fmtDateTime(r.occurred_at)}　{r.detail}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
