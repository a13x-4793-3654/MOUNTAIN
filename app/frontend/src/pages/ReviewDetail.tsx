import { useEffect, useState, ReactNode } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import {
  makeStyles,
  tokens,
  shorthands,
  mergeClasses,
  Title3,
  Body1,
  Button,
  Badge,
  Spinner,
  Checkbox,
  MessageBar,
  MessageBarBody,
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
} from "@fluentui/react-components";
import {
  ArrowLeft20Regular,
  Open16Regular,
  Checkmark16Regular,
  ArrowUndo16Regular,
  Dismiss16Regular,
  ArrowClockwise20Regular,
} from "@fluentui/react-icons";
import {
  ReviewDetail as ReviewDetailData,
  SimilarContract,
  fetchReviewDetail,
  fetchSimilarContracts,
  postReviewAction,
} from "../api/client";
import { fmtDateTime, reviewAppearance } from "../util/format";
import FormDialog from "../components/FormDialog";

const useStyles = makeStyles({
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "8px" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: "12px",
    marginBottom: "12px",
    flexWrap: "wrap",
    rowGap: "8px",
  },
  headLeft: { display: "flex", alignItems: "center", columnGap: "10px", flexWrap: "wrap" },
  mono: { fontVariantNumeric: "tabular-nums" },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "12px 16px",
    marginBottom: "16px",
  },
  sectionTitle: { fontWeight: tokens.fontWeightSemibold, marginBottom: "8px", fontSize: "14px" },
  grid: {
    display: "grid",
    gridTemplateColumns: "140px 1fr",
    rowGap: "6px",
    columnGap: "12px",
    alignItems: "baseline",
  },
  label: { color: tokens.colorNeutralForeground3, fontSize: "13px" },
  value: { fontSize: "13px" },
  reasonBox: {
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "8px 12px",
    marginTop: "8px",
    whiteSpace: "pre-wrap",
    fontSize: "13px",
  },
  simCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflowX: "auto",
  },
  reasons: { display: "flex", gap: "4px", flexWrap: "wrap" },
  ack: {
    backgroundColor: tokens.colorStatusWarningBackground1,
    border: `1px solid ${tokens.colorStatusWarningBorder1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "10px 12px",
    marginTop: "12px",
  },
  okText: { color: tokens.colorNeutralForeground3, fontSize: "13px" },
  actionBar: {
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    flexWrap: "nowrap",
    rowGap: "8px",
    marginTop: "4px",
    overflowX: "auto",
  },
  actBtn: { flexShrink: 0, whiteSpace: "nowrap" },
  spacer: { flex: 1 },
  denyBtn: {
    color: tokens.colorStatusDangerForeground1,
    ...shorthands.borderColor(tokens.colorStatusDangerBorder1),
    ":hover": {
      color: tokens.colorStatusDangerForeground1,
      backgroundColor: tokens.colorStatusDangerBackground1,
      ...shorthands.borderColor(tokens.colorStatusDangerBorder1),
    },
    ":hover:active": {
      color: tokens.colorStatusDangerForeground1,
      backgroundColor: tokens.colorStatusDangerBackground2,
      ...shorthands.borderColor(tokens.colorStatusDangerBorder1),
    },
  },
  hint: { color: tokens.colorNeutralForeground3, fontSize: "12px" },
});

type DialogAction = "approved" | "returned" | "rejected";
const ACTION_META: Record<DialogAction, { title: string; submit: string; needReason: boolean }> = {
  approved: { title: "審査を承認", submit: "承認する", needReason: false },
  returned: { title: "審査を差し戻し", submit: "差し戻す", needReason: true },
  rejected: { title: "審査を否決", submit: "否決する", needReason: true },
};

function Info({ label, children }: { label: string; children: ReactNode }) {
  const s = useStyles();
  return (
    <>
      <div className={s.label}>{label}</div>
      <div className={s.value}>{children}</div>
    </>
  );
}

export default function ReviewDetail() {
  const s = useStyles();
  const navigate = useNavigate();
  const { id = "" } = useParams();

  const [detail, setDetail] = useState<ReviewDetailData | null>(null);
  const [items, setItems] = useState<SimilarContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [simLoading, setSimLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [actionCtx, setActionCtx] = useState<DialogAction | null>(null);

  async function load() {
    setLoading(true);
    setSimLoading(true);
    setError(null);
    try {
      const d = await fetchReviewDetail(id);
      setDetail(d);
    } catch (e: any) {
      setError(e?.message ?? "審査対象の読み込みに失敗しました");
      setLoading(false);
      setSimLoading(false);
      return;
    }
    setLoading(false);
    try {
      const r = await fetchSimilarContracts(id);
      setItems(r.items);
    } catch {
      setItems([]);
    } finally {
      setSimLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const hasSimilar = items.length > 0;
  const isPending = detail?.review_status === "pending";
  const canApprove = isPending && !simLoading && (!hasSimilar || ack);

  function openContract(cid: string) {
    window.open(`/contracts/${cid}`, "_blank", "noopener");
  }

  return (
    <div>
      <div className={s.crumb}>
        <Link to="/review">審査</Link> ／ 審査中の契約
      </div>

      <div className={s.header}>
        <div className={s.headLeft}>
          <Button
            appearance="subtle"
            icon={<ArrowLeft20Regular />}
            onClick={() => navigate("/review")}
          >
            一覧へ戻る
          </Button>
          <Title3>審査：{detail?.contract_no ?? "—"}</Title3>
          {detail && (
            <Badge appearance="tint" color={reviewAppearance(detail.review_status)}>
              {detail.review_label ?? detail.review_status ?? "—"}
            </Badge>
          )}
        </div>
        <div style={{ display: "flex", columnGap: 8 }}>
          <Button appearance="secondary" icon={<ArrowClockwise20Regular />} onClick={load}>
            更新
          </Button>
          {detail && (
            <Button appearance="secondary" icon={<Open16Regular />} onClick={() => openContract(detail.id)}>
              契約の詳細（編集）を開く
            </Button>
          )}
        </div>
      </div>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {loading && !detail ? (
        <div style={{ padding: 24 }}>
          <Spinner label="読み込み中…" />
        </div>
      ) : detail ? (
        <>
          {/* 契約の要点 */}
          <div className={s.card}>
            <div className={s.sectionTitle}>契約の要点</div>
            <div className={s.grid}>
              <Info label="件名">{detail.contract_summary || "—"}</Info>
              <Info label="区分">{detail.category_label ?? "—"}</Info>
              <Info label="会社">{detail.company_name ?? "—"}</Info>
              <Info label="契約者">{detail.person_name ?? "—"}</Info>
              <Info label="担当">{detail.assignee_name ?? "—"}</Info>
              <Info label="受付日時">{fmtDateTime(detail.created_at)}</Info>
            </div>
            {detail.review_reason && <div className={s.reasonBox}>審査理由：{detail.review_reason}</div>}
          </div>

          {/* 類似契約（重複チェック） */}
          <div className={s.card}>
            <div className={s.sectionTitle}>類似する契約（重複チェック）</div>
            {simLoading ? (
              <Spinner size="tiny" label="類似する契約を確認しています…" />
            ) : hasSimilar ? (
              <>
                <MessageBar intent="warning" style={{ marginBottom: 12 }}>
                  <MessageBarBody>
                    同じ会社・名義・外部管理番号を持つ契約が <b>{items.length} 件</b> 見つかりました。
                    二重登録でないか確認してください。
                  </MessageBarBody>
                </MessageBar>
                <div className={s.simCard}>
                  <Table size="small" aria-label="類似する契約">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>契約番号</TableHeaderCell>
                        <TableHeaderCell>概要</TableHeaderCell>
                        <TableHeaderCell>会社 / 名義</TableHeaderCell>
                        <TableHeaderCell>状態</TableHeaderCell>
                        <TableHeaderCell>一致した項目</TableHeaderCell>
                        <TableHeaderCell />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((it) => (
                        <TableRow key={it.id}>
                          <TableCell className={s.mono}>{it.contract_no}</TableCell>
                          <TableCell>{it.contract_summary ?? "—"}</TableCell>
                          <TableCell>
                            {it.company_name ?? "—"}
                            {it.person_name ? ` / ${it.person_name}` : ""}
                          </TableCell>
                          <TableCell>{it.status_label ?? "—"}</TableCell>
                          <TableCell>
                            <div className={s.reasons}>
                              {it.reasons.map((r) => (
                                <Badge key={r} appearance="tint" color="danger">
                                  {r}
                                </Badge>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Button
                              size="small"
                              appearance="subtle"
                              icon={<Open16Regular />}
                              onClick={() => openContract(it.id)}
                            >
                              開く
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {isPending && (
                  <div className={s.ack}>
                    <Checkbox
                      checked={ack}
                      onChange={(_, d) => setAck(Boolean(d.checked))}
                      label="上記の類似契約を確認しました（重複ではありません）"
                    />
                  </div>
                )}
              </>
            ) : (
              <div className={s.okText}>類似する契約は見つかりませんでした。そのまま承認できます。</div>
            )}
          </div>

          {/* 審査操作 */}
          <div className={s.card}>
            <div className={s.sectionTitle}>審査操作</div>
            {isPending ? (
              <>
                <div className={s.actionBar}>
                  <Button
                    appearance="primary"
                    className={s.actBtn}
                    icon={<Checkmark16Regular />}
                    disabled={!canApprove}
                    onClick={() => setActionCtx("approved")}
                  >
                    承認
                  </Button>
                  <Button
                    appearance="secondary"
                    className={mergeClasses(s.actBtn, s.denyBtn)}
                    icon={<Dismiss16Regular />}
                    onClick={() => setActionCtx("rejected")}
                  >
                    否決
                  </Button>
                  <Button
                    appearance="secondary"
                    className={s.actBtn}
                    icon={<ArrowUndo16Regular />}
                    onClick={() => setActionCtx("returned")}
                  >
                    差戻
                  </Button>
                </div>
                {hasSimilar && !ack && (
                  <div className={s.hint} style={{ marginTop: 8 }}>
                    ※ 類似する契約があります。上のチェックを入れると「承認」できます（差し戻し・否決はいつでも可能です）。
                  </div>
                )}
              </>
            ) : (
              <Body1>
                この契約は審査中ではありません（現在の審査状況：{detail.review_label ?? detail.review_status ?? "—"}）。
                操作の履歴は「審査」一覧の「審査履歴」で確認できます。
              </Body1>
            )}
          </div>
        </>
      ) : null}

      {actionCtx && detail && (
        <FormDialog
          open={!!actionCtx}
          title={`${ACTION_META[actionCtx].title}（${detail.contract_no}）`}
          fields={[
            {
              key: "comment",
              label: ACTION_META[actionCtx].needReason ? "理由・コメント" : "コメント（任意）",
              type: "textarea",
              required: ACTION_META[actionCtx].needReason,
              placeholder: ACTION_META[actionCtx].needReason
                ? "差し戻し・否決の理由を入力してください"
                : "必要に応じてコメントを入力できます",
            },
          ]}
          submitLabel={ACTION_META[actionCtx].submit}
          onSubmit={async (v) => {
            await postReviewAction(detail.id, {
              action: actionCtx,
              comment: String(v.comment ?? "").trim() || null,
            });
            setActionCtx(null);
            navigate("/review");
          }}
          onClose={() => setActionCtx(null)}
        />
      )}
    </div>
  );
}
