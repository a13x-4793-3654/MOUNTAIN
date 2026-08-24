import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  TabList,
  Tab,
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { ArrowClockwise20Regular, Open16Regular } from "@fluentui/react-icons";
import { fetchReviews, ReviewData, ReviewPending, postReviewAction } from "../api/client";
import { fmtDateTime, reviewActionLabel, reviewActionAppearance } from "../util/format";
import FormDialog from "../components/FormDialog";
import ReviewApproveDialog from "../components/ReviewApproveDialog";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: "4px",
  },
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "12px" },
  toolbar: { display: "flex", columnGap: "8px", marginBottom: "12px" },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "4px 8px",
    overflowX: "auto",
  },
  row: { cursor: "pointer" },
  mono: { fontVariantNumeric: "tabular-nums" },
  count: { color: tokens.colorNeutralForeground3, fontSize: "12px" },
  actionCell: {
    display: "flex",
    columnGap: "4px",
    flexWrap: "nowrap",
    alignItems: "center",
  },
  actBtn: { flexShrink: 0, whiteSpace: "nowrap", minWidth: "auto" },
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
  simBtn: { minWidth: 0, paddingLeft: "4px", paddingRight: "4px" },
});

type ReviewAction = "approved" | "returned" | "rejected";
const ACTION_META: Record<ReviewAction, { title: string; submit: string; needReason: boolean }> = {
  approved: { title: "審査を承認", submit: "承認する", needReason: false },
  returned: { title: "審査を差し戻し", submit: "差し戻す", needReason: true },
  rejected: { title: "審査を否決", submit: "否決する", needReason: true },
};
type DialogAction = "returned" | "rejected";

export default function Review() {
  const s = useStyles();
  const navigate = useNavigate();
  const [tab, setTab] = useState("pending");
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionCtx, setActionCtx] = useState<{ contract: ReviewPending; action: DialogAction } | null>(null);
  const [approveCtx, setApproveCtx] = useState<ReviewPending | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchReviews());
    } catch (e: any) {
      setError(e?.message ?? "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <div className={s.header}>
        <Title3>審査</Title3>
        <span className={s.count}>{loading ? "読み込み中…" : ""}</span>
      </div>
      <div className={s.crumb}>
        承認待ちの契約（審査中）と、これまでの審査結果の履歴を確認できます。行をクリックすると「審査専用画面」が開き、類似契約の確認や承認・差し戻し・否決ができます。
      </div>

      <div className={s.toolbar}>
        <Button icon={<ArrowClockwise20Regular />} onClick={load} appearance="secondary">
          更新
        </Button>
      </div>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)} style={{ marginBottom: 8 }}>
        <Tab value="pending">審査待ち（{data?.pending.length ?? 0}）</Tab>
        <Tab value="history">審査履歴（{data?.history.length ?? 0}）</Tab>
      </TabList>

      <div className={s.card}>
        {loading && !data ? (
          <div style={{ padding: 24 }}>
            <Spinner label="読み込み中…" />
          </div>
        ) : tab === "pending" ? (
          <Table aria-label="審査待ち" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>契約番号</TableHeaderCell>
                <TableHeaderCell>件名</TableHeaderCell>
                <TableHeaderCell>区分</TableHeaderCell>
                <TableHeaderCell>会社</TableHeaderCell>
                <TableHeaderCell>契約者</TableHeaderCell>
                <TableHeaderCell>担当</TableHeaderCell>
                <TableHeaderCell>審査理由</TableHeaderCell>
                <TableHeaderCell>類似</TableHeaderCell>
                <TableHeaderCell>審査操作</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.pending ?? []).map((r) => (
                <TableRow key={r.id} className={s.row} onClick={() => navigate(`/review/${r.id}`)}>
                  <TableCell className={s.mono}>{r.contract_no}</TableCell>
                  <TableCell>{r.contract_summary ?? "—"}</TableCell>
                  <TableCell>{r.category_label ?? "—"}</TableCell>
                  <TableCell>{r.company_name ?? "—"}</TableCell>
                  <TableCell>{r.person_name ?? "—"}</TableCell>
                  <TableCell>{r.assignee_name ?? "—"}</TableCell>
                  <TableCell>{r.review_reason ?? "—"}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {r.similar_count > 0 ? (
                      <Button
                        className={s.simBtn}
                        size="small"
                        appearance="subtle"
                        onClick={() => navigate(`/review/${r.id}`)}
                        title="類似する契約を確認する"
                      >
                        <Badge appearance="tint" color="danger">
                          類似 {r.similar_count} 件
                        </Badge>
                      </Button>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className={s.actionCell}>
                      <Button
                        size="small"
                        appearance="primary"
                        className={s.actBtn}
                        onClick={() => setApproveCtx(r)}
                      >
                        承認
                      </Button>
                      <Button
                        size="small"
                        appearance="secondary"
                        className={mergeClasses(s.actBtn, s.denyBtn)}
                        onClick={() => setActionCtx({ contract: r, action: "rejected" })}
                      >
                        否決
                      </Button>
                      <Button
                        size="small"
                        appearance="secondary"
                        className={s.actBtn}
                        onClick={() => setActionCtx({ contract: r, action: "returned" })}
                      >
                        差戻
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(data?.pending.length ?? 0) === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={9}>
                    <Body1>審査待ちの契約はありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        ) : (
          <Table aria-label="審査履歴" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>日時</TableHeaderCell>
                <TableHeaderCell>契約番号</TableHeaderCell>
                <TableHeaderCell>操作</TableHeaderCell>
                <TableHeaderCell>担当</TableHeaderCell>
                <TableHeaderCell>コメント</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.history ?? []).map((h) => (
                <TableRow
                  key={h.id}
                  className={s.row}
                  onClick={() => navigate(`/contracts/${h.contract_id}`)}
                >
                  <TableCell>{fmtDateTime(h.created_at)}</TableCell>
                  <TableCell className={s.mono}>{h.contract_no}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={reviewActionAppearance(h.action)}>
                      {reviewActionLabel(h.action)}
                    </Badge>
                  </TableCell>
                  <TableCell>{h.actor_name ?? "—"}</TableCell>
                  <TableCell>{h.comment ?? "—"}</TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Open16Regular />}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/contracts/${h.contract_id}`);
                      }}
                    >
                      契約を開く
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(data?.history.length ?? 0) === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Body1>審査履歴がありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {actionCtx && (
        <FormDialog
          open={!!actionCtx}
          title={`${ACTION_META[actionCtx.action].title}（${actionCtx.contract.contract_no}）`}
          fields={[
            {
              key: "comment",
              label: ACTION_META[actionCtx.action].needReason ? "理由・コメント" : "コメント（任意）",
              type: "textarea",
              required: ACTION_META[actionCtx.action].needReason,
              placeholder: ACTION_META[actionCtx.action].needReason
                ? "差し戻し・否決の理由を入力してください"
                : "必要に応じてコメントを入力できます",
            },
          ]}
          submitLabel={ACTION_META[actionCtx.action].submit}
          onSubmit={async (v) => {
            await postReviewAction(actionCtx.contract.id, {
              action: actionCtx.action,
              comment: String(v.comment ?? "").trim() || null,
            });
            setActionCtx(null);
            await load();
          }}
          onClose={() => setActionCtx(null)}
        />
      )}

      {approveCtx && (
        <ReviewApproveDialog
          contract={approveCtx}
          onClose={() => setApproveCtx(null)}
          onApproved={async () => {
            setApproveCtx(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
