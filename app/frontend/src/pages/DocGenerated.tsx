import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  makeStyles,
  tokens,
  Title3,
  Body1,
  Button,
  Spinner,
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
  Badge,
  MessageBar,
  MessageBarBody,
  Menu,
  MenuTrigger,
  MenuButton,
  MenuPopover,
  MenuList,
  MenuItem,
} from "@fluentui/react-components";
import {
  ArrowClockwise20Regular,
  ArrowDownload16Regular,
  Edit16Regular,
  Delete16Regular,
  Print20Regular,
  MoreHorizontal16Regular,
} from "@fluentui/react-icons";
import {
  fetchGeneratedDocs,
  downloadGeneratedPdf,
  deleteGeneratedDoc,
  DocGeneratedListItem,
} from "../api/client";
import { fmtDateTime, fmtFileSize } from "../util/format";
import ConfirmDialog from "../components/ConfirmDialog";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: "4px",
  },
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "12px" },
  toolbar: { display: "flex", columnGap: "8px", flexWrap: "wrap", marginBottom: "12px" },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "4px 8px",
  },
  count: { color: tokens.colorNeutralForeground3, fontSize: "12px" },
  mono: { fontVariantNumeric: "tabular-nums" },
  ops: { whiteSpace: "nowrap" },
  opsWrap: { display: "flex", alignItems: "center", columnGap: "6px", justifyContent: "flex-end" },
});

export default function DocGenerated() {
  const s = useStyles();
  const navigate = useNavigate();
  const [items, setItems] = useState<DocGeneratedListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delCtx, setDelCtx] = useState<DocGeneratedListItem | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchGeneratedDocs();
      setItems(r.items);
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
        <Title3>差し込み印刷の作成履歴</Title3>
        <span className={s.count}>{loading ? "読み込み中…" : `${items.length} 件`}</span>
      </div>
      <div className={s.crumb}>
        これまでに作成した差し込み文書の一覧です。もう一度ダウンロードしたり、内容を直して作り直せます。
      </div>

      <div className={s.toolbar}>
        <Button icon={<ArrowClockwise20Regular />} onClick={load} appearance="secondary">
          更新
        </Button>
        <div style={{ flexGrow: 1 }} />
        <Button
          icon={<Print20Regular />}
          onClick={() => navigate("/doc-templates")}
          appearance="primary"
        >
          新しく作成する（書式を選ぶ）
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
          <Table aria-label="作成履歴" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>タイトル</TableHeaderCell>
                <TableHeaderCell>使った書式</TableHeaderCell>
                <TableHeaderCell>作成者</TableHeaderCell>
                <TableHeaderCell>作成日時</TableHeaderCell>
                <TableHeaderCell>サイズ</TableHeaderCell>
                <TableHeaderCell style={{ flexBasis: "244px", flexGrow: 0, flexShrink: 0 }} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((g) => (
                <TableRow key={g.id}>
                  <TableCell>{g.title}</TableCell>
                  <TableCell>
                    {g.template_name ?? (
                      <Badge appearance="tint" color="warning">
                        書式が削除されました
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{g.created_by_name ?? "—"}</TableCell>
                  <TableCell>{fmtDateTime(g.created_at)}</TableCell>
                  <TableCell className={s.mono}>{fmtFileSize(g.pdf_size)}</TableCell>
                  <TableCell className={s.ops} style={{ flexBasis: "244px", flexGrow: 0, flexShrink: 0 }}>
                    <div className={s.opsWrap}>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<ArrowDownload16Regular />}
                        onClick={() => downloadGeneratedPdf(g.id, `${g.title}.pdf`)}
                        style={{ flexShrink: 0, whiteSpace: "nowrap" }}
                      >
                        ダウンロード
                      </Button>
                      <Menu positioning="below-end">
                        <MenuTrigger disableButtonEnhancement>
                          <MenuButton
                            size="small"
                            appearance="subtle"
                            icon={<MoreHorizontal16Regular />}
                          >
                            その他
                          </MenuButton>
                        </MenuTrigger>
                        <MenuPopover>
                          <MenuList>
                            <MenuItem
                              icon={<Edit16Regular />}
                              onClick={() => navigate(`/doc-merge/${g.template_id}?edit=${g.id}`)}
                            >
                              直して作り直す
                            </MenuItem>
                            <MenuItem icon={<Delete16Regular />} onClick={() => setDelCtx(g)}>
                              削除
                            </MenuItem>
                          </MenuList>
                        </MenuPopover>
                      </Menu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Body1>
                      まだ作成履歴がありません。「差し込み印刷（文書テンプレート）」から書式を選んで作成してください。
                    </Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {delCtx && (
        <ConfirmDialog
          open
          title="作成履歴を削除"
          message={`「${delCtx.title}」を削除します。よろしいですか？（PDFも一緒に削除されます）`}
          onConfirm={async () => {
            await deleteGeneratedDoc(delCtx.id);
            await load();
          }}
          onClose={() => setDelCtx(null)}
        />
      )}
    </div>
  );
}
