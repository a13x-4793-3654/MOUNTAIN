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
import { Search20Regular, ArrowClockwise20Regular, Open16Regular, Add20Regular, Edit16Regular, Delete16Regular, Eye16Regular, ArrowDownload16Regular, ArrowUpload16Regular } from "@fluentui/react-icons";
import {
  fetchFiles,
  FilesData,
  FileItem,
  fetchContracts,
  ContractListItem,
  updateFile,
  deleteFile,
  downloadFileContent,
} from "../api/client";
import { fmtDateTime, fmtFileSize, boolLabel, fileTypeLabel } from "../util/format";
import FormDialog, { FormField } from "../components/FormDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import FileUploadDialog from "../components/FileUploadDialog";
import FilePreviewDialog from "../components/FilePreviewDialog";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: "4px",
  },
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "12px" },
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: "12px",
    marginBottom: "16px",
  },
  kpi: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    rowGap: "2px",
  },
  kpiLabel: { color: tokens.colorNeutralForeground2, fontSize: "12px" },
  kpiNum: { fontSize: "24px", fontWeight: 700, fontVariantNumeric: "tabular-nums" },
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

export default function Files() {
  const s = useStyles();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [data, setData] = useState<FilesData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editCtx, setEditCtx] = useState<FileItem | null>(null);
  const [delCtx, setDelCtx] = useState<FileItem | null>(null);
  const [previewCtx, setPreviewCtx] = useState<FileItem | null>(null);
  const [attachCtx, setAttachCtx] = useState<FileItem | null>(null);
  const [contracts, setContracts] = useState<ContractListItem[]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchFiles({ q }));
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

  useEffect(() => {
    fetchContracts({}).then((r) => setContracts(r.items)).catch(() => {});
  }, []);

  const contractOptions = contracts.map((c) => ({
    value: c.id,
    label: `${c.contract_no}　${c.contract_summary ?? ""}`.trim(),
  }));

  const editFields: FormField[] = [
    { key: "file_name", label: "ファイル名", required: true },
    { key: "tag_text", label: "タグ・区分" },
    { key: "is_password_protected", label: "パスワード保護あり", type: "switch" },
  ];

  const tagOptions = ["契約書", "本人確認", "督促", "裁判関連", "明細", "その他"].map((x) => ({
    value: x,
    label: x,
  }));

  async function onDownload(f: FileItem) {
    try {
      await downloadFileContent(f.id, f.file_name);
    } catch (e: any) {
      setError(e?.message ?? "ダウンロードに失敗しました");
    }
  }

  const k = data?.kpis ?? {};

  return (
    <div>
      <div className={s.header}>
        <Title3>ファイル</Title3>
        <span className={s.count}>{loading ? "読み込み中…" : `${data?.total ?? 0} 件`}</span>
      </div>
      <div className={s.crumb}>
        すべての契約に添付されたファイルを横断して確認できます。行をクリックすると、そのファイルが属する契約を開きます。
      </div>

      <div className={s.cards}>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>ファイル総数</span>
          <span className={s.kpiNum}>{k.files_count ?? "—"}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>パスワード保護</span>
          <span className={s.kpiNum}>{k.protected_count ?? "—"}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.kpiLabel}>合計サイズ</span>
          <span className={s.kpiNum}>{fmtFileSize(k.total_bytes as any)}</span>
        </div>
      </div>

      <div className={s.toolbar}>
        <Input
          className={s.search}
          value={q}
          onChange={(_, d) => setQ(d.value)}
          placeholder="ファイル名・タグ・契約番号・会社名で検索"
          contentBefore={<Search20Regular />}
        />
        <Button icon={<ArrowClockwise20Regular />} onClick={load} appearance="secondary">
          更新
        </Button>
        <div style={{ flexGrow: 1 }} />
        <Button icon={<Add20Regular />} onClick={() => setCreateOpen(true)} appearance="primary">
          ファイルを登録
        </Button>
      </div>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.card}>
        {loading && !data ? (
          <div style={{ padding: 24 }}>
            <Spinner label="読み込み中…" />
          </div>
        ) : (
          <Table aria-label="ファイル一覧" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>ファイル名</TableHeaderCell>
                <TableHeaderCell>種別</TableHeaderCell>
                <TableHeaderCell>サイズ</TableHeaderCell>
                <TableHeaderCell>タグ</TableHeaderCell>
                <TableHeaderCell>保護</TableHeaderCell>
                <TableHeaderCell>契約番号</TableHeaderCell>
                <TableHeaderCell>登録日時</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.items ?? []).map((f) => (
                <TableRow
                  key={f.id}
                  className={f.contract_id ? s.row : undefined}
                  onClick={() => f.contract_id && navigate(`/contracts/${f.contract_id}`)}
                >
                  <TableCell>{f.file_name}</TableCell>
                  <TableCell title={f.content_type ?? undefined}>
                    {fileTypeLabel(f.content_type)}
                  </TableCell>
                  <TableCell className={s.mono}>{fmtFileSize(f.file_size_bytes)}</TableCell>
                  <TableCell>{f.tag_text ?? "—"}</TableCell>
                  <TableCell>{boolLabel(f.is_password_protected)}</TableCell>
                  <TableCell className={s.mono}>{f.contract_no ?? "—"}</TableCell>
                  <TableCell>{fmtDateTime(f.created_at)}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {f.has_content ? (
                      <>
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<Eye16Regular />}
                          onClick={() => setPreviewCtx(f)}
                        >
                          プレビュー
                        </Button>
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<ArrowDownload16Regular />}
                          onClick={() => onDownload(f)}
                        >
                          保存
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<ArrowUpload16Regular />}
                        onClick={() => setAttachCtx(f)}
                      >
                        実ファイル追加
                      </Button>
                    )}
                    {f.contract_id && (
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<Open16Regular />}
                        onClick={() => navigate(`/contracts/${f.contract_id}`)}
                      >
                        契約を開く
                      </Button>
                    )}
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Edit16Regular />}
                      onClick={() => setEditCtx(f)}
                    >
                      編集
                    </Button>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Delete16Regular />}
                      onClick={() => setDelCtx(f)}
                    >
                      削除
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(data?.items.length ?? 0) === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={8}>
                    <Body1>該当するファイルがありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      <FileUploadDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={load}
        contractOptions={contractOptions}
        tagOptions={tagOptions}
      />

      {attachCtx && (
        <FileUploadDialog
          open={!!attachCtx}
          onClose={() => setAttachCtx(null)}
          onDone={load}
          attachFileId={attachCtx.id}
          attachFileName={attachCtx.file_name}
        />
      )}

      {previewCtx && (
        <FilePreviewDialog
          open={!!previewCtx}
          fileId={previewCtx.id}
          fileName={previewCtx.file_name}
          contentType={previewCtx.content_type}
          onClose={() => setPreviewCtx(null)}
        />
      )}

      {editCtx && (
        <FormDialog
          open={!!editCtx}
          title="ファイルを編集"
          fields={editFields}
          initial={{
            file_name: editCtx.file_name ?? "",
            tag_text: editCtx.tag_text ?? "",
            is_password_protected: editCtx.is_password_protected === true,
          }}
          submitLabel="保存する"
          onSubmit={async (v) => {
            await updateFile(editCtx.id, {
              file_name: String(v.file_name ?? "").trim(),
              tag_text: String(v.tag_text ?? "").trim() || null,
              is_password_protected: v.is_password_protected === true,
            });
            setEditCtx(null);
            await load();
          }}
          onClose={() => setEditCtx(null)}
        />
      )}

      {delCtx && (
        <ConfirmDialog
          open={!!delCtx}
          title="ファイルの削除"
          message={`「${delCtx.file_name}」を削除します。よろしいですか？`}
          confirmLabel="削除する"
          onConfirm={async () => {
            await deleteFile(delCtx.id);
            setDelCtx(null);
            await load();
          }}
          onClose={() => setDelCtx(null)}
        />
      )}
    </div>
  );
}
