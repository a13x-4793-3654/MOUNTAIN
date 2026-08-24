import { ReactNode, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  makeStyles,
  tokens,
  Title3,
  Subtitle2,
  Badge,
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import {
  ArrowLeft20Regular,
  Open16Regular,
  CallInbound20Regular,
  CallOutbound20Regular,
  Play16Regular,
} from "@fluentui/react-icons";
import { fetchCall, CallDetail as Detail } from "../api/client";
import {
  callDirectionLabel,
  callResultLabel,
  callResultAppearance,
  operationTypeLabel,
  fmtDuration,
  fmtDateTime,
  statusAppearance,
} from "../util/format";

const useStyles = makeStyles({
  topbar: { display: "flex", alignItems: "center", columnGap: "8px", marginBottom: "12px" },
  headCard: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "16px",
    marginBottom: "12px",
  },
  headRow: { display: "flex", alignItems: "center", columnGap: "12px", flexWrap: "wrap" },
  name: { fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "16px",
    marginBottom: "12px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "160px 1fr",
    rowGap: "10px",
    columnGap: "12px",
    maxWidth: "760px",
  },
  label: { color: tokens.colorNeutralForeground3 },
  mono: { fontVariantNumeric: "tabular-nums" },
  section: { marginTop: "4px", marginBottom: "8px" },
  note: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginTop: "8px" },
  linkRow: { display: "flex", alignItems: "center", columnGap: "10px", flexWrap: "wrap" },
  // 操作ログ タイムライン
  tl: { display: "flex", flexDirection: "column", rowGap: "0" },
  tlItem: {
    display: "grid",
    gridTemplateColumns: "72px 110px 1fr 120px",
    columnGap: "12px",
    alignItems: "center",
    padding: "8px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tlTime: { fontVariantNumeric: "tabular-nums", color: tokens.colorNeutralForeground2 },
  tlBy: { color: tokens.colorNeutralForeground3, fontSize: "12px" },
});

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  const s = useStyles();
  return (
    <>
      <div className={s.label}>{label}</div>
      <div>{children}</div>
    </>
  );
}

function offsetLabel(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function CtiCallDetail() {
  const s = useStyles();
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetchCall(id)
      .then((d) => setData(d))
      .catch((e) => setError(e?.message ?? "読み込みに失敗しました"))
      .finally(() => setLoading(false));
  }, [id]);

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
        <MessageBarBody>{error ?? "通話履歴が見つかりません"}</MessageBarBody>
      </MessageBar>
    );
  }

  const c = data.call;
  const isOut = c.direction === "out";
  const other = isOut ? c.to_number : c.from_number;

  return (
    <div>
      <div className={s.topbar}>
        <Button
          appearance="subtle"
          icon={<ArrowLeft20Regular />}
          onClick={() => navigate("/cti")}
        >
          通話履歴へ戻る
        </Button>
      </div>

      <div className={s.headCard}>
        <div className={s.headRow}>
          {isOut ? (
            <CallOutbound20Regular style={{ color: tokens.colorBrandForeground1 }} />
          ) : (
            <CallInbound20Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />
          )}
          <Title3 className={s.name}>{other ?? "（番号不明）"}</Title3>
          <Badge appearance="tint" color={isOut ? "brand" : "success"}>
            {callDirectionLabel(c.direction)}
          </Badge>
          <Badge appearance="tint" color={callResultAppearance(c.call_result)}>
            {callResultLabel(c.call_result)}
          </Badge>
        </div>
        <div className={s.note}>
          {fmtDateTime(c.started_at)}　通話時間 {fmtDuration(c.duration_seconds)}
        </div>
      </div>

      <div className={s.panel}>
        <Subtitle2 className={s.section}>通話情報</Subtitle2>
        <div className={s.grid}>
          <InfoRow label="通話ID">
            <span className={s.mono}>{c.call_id}</span>
          </InfoRow>
          <InfoRow label="種別">{callDirectionLabel(c.direction)}</InfoRow>
          <InfoRow label="発信元">
            <span className={s.mono}>{c.from_number ?? "—"}</span>
          </InfoRow>
          <InfoRow label="着信先">
            <span className={s.mono}>{c.to_number ?? "—"}</span>
          </InfoRow>
          <InfoRow label="開始日時">{fmtDateTime(c.started_at)}</InfoRow>
          <InfoRow label="終了日時">{fmtDateTime(c.ended_at)}</InfoRow>
          <InfoRow label="通話時間">{fmtDuration(c.duration_seconds)}</InfoRow>
          <InfoRow label="結果">
            <Badge appearance="tint" color={callResultAppearance(c.call_result)}>
              {callResultLabel(c.call_result)}
            </Badge>
          </InfoRow>
          <InfoRow label="対応者">{c.operator_name ?? "—"}</InfoRow>
        </div>
      </div>

      <div className={s.panel}>
        <Subtitle2 className={s.section}>通話録音</Subtitle2>
        {c.has_recording ? (
          <div>
            <div className={s.linkRow}>
              <Button icon={<Play16Regular />} appearance="secondary" disabled>
                再生（PBX接続後に有効）
              </Button>
              <span className={s.mono}>{c.recording_file ?? "—"}</span>
            </div>
            <div className={s.note}>
              ※ 録音データは電話交換機（PBX）の録音ストレージに保存されます。本番でPBXと接続後、この画面から再生できます。
            </div>
          </div>
        ) : (
          <div className={s.note}>この通話の録音はありません。</div>
        )}
      </div>

      <div className={s.panel}>
        <Subtitle2 className={s.section}>操作ログ（保留・転送・プッシュ・切電など）</Subtitle2>
        {data.operations.length === 0 ? (
          <div className={s.note}>操作ログはありません。</div>
        ) : (
          <div className={s.tl}>
            {data.operations.map((o) => (
              <div className={s.tlItem} key={o.seq_no}>
                <span className={s.tlTime}>{offsetLabel(o.offset_seconds)}</span>
                <Badge appearance="outline">{operationTypeLabel(o.operation_type)}</Badge>
                <span>{o.detail ?? "—"}</span>
                <span className={s.tlBy}>{o.operated_by_name ?? ""}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={s.panel}>
        <Subtitle2 className={s.section}>関連する契約</Subtitle2>
        {c.contract_id ? (
          <div className={s.linkRow}>
            <span className={s.mono}>{c.contract_no}</span>
            <span>{c.contract_summary ?? ""}</span>
            {c.contract_status && (
              <Badge appearance="tint" color={statusAppearance(c.contract_status)}>
                {c.contract_status_label ?? c.contract_status}
              </Badge>
            )}
            <Button
              size="small"
              appearance="subtle"
              icon={<Open16Regular />}
              onClick={() => navigate(`/contracts/${c.contract_id}`)}
            >
              契約を開く
            </Button>
          </div>
        ) : (
          <div className={s.note}>この通話は契約にひも付いていません。</div>
        )}
      </div>
    </div>
  );
}
