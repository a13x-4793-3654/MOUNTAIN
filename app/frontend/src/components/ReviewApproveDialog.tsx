import { useEffect, useState } from "react";
import {
  makeStyles,
  tokens,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Textarea,
  Field,
  Checkbox,
  Spinner,
  Badge,
  MessageBar,
  MessageBarBody,
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
  Text,
} from "@fluentui/react-components";
import { Open16Regular } from "@fluentui/react-icons";
import {
  ReviewPending,
  SimilarContract,
  fetchSimilarContracts,
  postReviewAction,
} from "../api/client";

const useStyles = makeStyles({
  surface: { maxWidth: "760px", width: "760px" },
  warnBar: { marginBottom: "12px" },
  simCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    marginBottom: "12px",
    maxHeight: "260px",
    overflowY: "auto",
  },
  reasons: { display: "flex", gap: "4px", flexWrap: "wrap" },
  ack: {
    backgroundColor: tokens.colorStatusWarningBackground1,
    border: `1px solid ${tokens.colorStatusWarningBorder1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "10px 12px",
    marginBottom: "12px",
  },
  ok: { color: tokens.colorNeutralForeground3, marginBottom: "12px", fontSize: "13px" },
  mono: { fontVariantNumeric: "tabular-nums" },
});

export default function ReviewApproveDialog({
  contract,
  onClose,
  onApproved,
}: {
  contract: ReviewPending;
  onClose: () => void;
  onApproved: () => void;
}) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<SimilarContract[]>([]);
  const [comment, setComment] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchSimilarContracts(contract.id)
      .then((r) => {
        if (alive) setItems(r.items);
      })
      .catch((e: any) => {
        if (alive) setError(e?.message ?? "類似契約の確認に失敗しました");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [contract.id]);

  const hasSimilar = items.length > 0;
  const canApprove = !busy && !loading && (!hasSimilar || ack);

  async function approve() {
    if (hasSimilar && !ack) {
      setError("類似契約を確認し、チェックを入れてください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postReviewAction(contract.id, {
        action: "approved",
        comment: comment.trim() || null,
      });
      onApproved();
    } catch (e: any) {
      setError(e?.message ?? "承認に失敗しました");
      setBusy(false);
    }
  }

  function openContract(id: string) {
    window.open(`/contracts/${id}`, "_blank", "noopener");
  }

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open && !busy) onClose(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>審査を承認（{contract.contract_no}）</DialogTitle>
          <DialogContent>
            {error && (
              <MessageBar intent="error" style={{ marginBottom: 12 }}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}

            {loading ? (
              <div style={{ padding: 16 }}>
                <Spinner size="tiny" label="類似する契約を確認しています…" />
              </div>
            ) : hasSimilar ? (
              <>
                <MessageBar intent="warning" className={s.warnBar}>
                  <MessageBarBody>
                    会社と名義の両方、または外部管理番号が一致する契約が <b>{items.length} 件</b> 見つかりました。
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
                <div className={s.ack}>
                  <Checkbox
                    checked={ack}
                    onChange={(_, d) => setAck(Boolean(d.checked))}
                    label="上記の類似契約を確認しました（重複ではありません）"
                  />
                </div>
              </>
            ) : (
              <div className={s.ok}>
                <Text>類似する契約は見つかりませんでした。そのまま承認できます。</Text>
              </div>
            )}

            <Field label="コメント（任意）">
              <Textarea
                value={comment}
                onChange={(_, d) => setComment(d.value)}
                placeholder="必要に応じてコメントを入力できます"
              />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>
              キャンセル
            </Button>
            <Button appearance="primary" onClick={approve} disabled={!canApprove}>
              {busy ? <Spinner size="tiny" /> : "承認する"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
