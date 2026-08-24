import { useEffect, useMemo, useRef, useState } from "react";
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
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Field,
  Input,
  Textarea,
  Menu,
  MenuTrigger,
  MenuButton,
  MenuPopover,
  MenuList,
  MenuItem,
} from "@fluentui/react-components";
import {
  ArrowClockwise20Regular,
  Add20Regular,
  Edit16Regular,
  Delete16Regular,
  ArrowDownload16Regular,
  Eye16Regular,
  QuestionCircle20Regular,
  Print16Regular,
  MoreHorizontal16Regular,
} from "@fluentui/react-icons";
import {
  fetchDocTemplates,
  fetchDocTemplate,
  uploadDocTemplate,
  updateDocTemplate,
  deleteDocTemplate,
  downloadDocTemplateFile,
  fetchDocMergeCatalog,
  DocTemplateListItem,
  DocTemplateDetail,
  DocMergeCatalog,
  DocField,
} from "../api/client";
import { fmtDateTime } from "../util/format";
import FormDialog, { FormField } from "../components/FormDialog";
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
  help: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "14px 16px",
    marginBottom: "16px",
  },
  helpTitle: { fontWeight: 700, marginBottom: "6px" },
  code: {
    fontFamily: "Consolas, monospace",
    backgroundColor: tokens.colorNeutralBackground3,
    padding: "1px 5px",
    borderRadius: "4px",
    fontSize: "12.5px",
  },
  count: { color: tokens.colorNeutralForeground3, fontSize: "12px" },
  mono: { fontVariantNumeric: "tabular-nums" },
  ops: { whiteSpace: "nowrap" },
  opsWrap: { display: "flex", alignItems: "center", columnGap: "6px", justifyContent: "flex-end" },
  fileRow: { display: "flex", alignItems: "center", columnGap: "10px" },
  cataGroup: { marginTop: "8px" },
  cataEntity: { fontWeight: 600, marginTop: "8px", marginBottom: "2px" },
  chips: { display: "flex", flexWrap: "wrap", gap: "6px" },
  note: {
    backgroundColor: tokens.colorStatusWarningBackground1,
    border: `1px solid ${tokens.colorStatusWarningBorder1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "10px 12px",
    marginTop: "12px",
  },
  noteTitle: { fontWeight: 700, marginBottom: "4px" },
});

const RESTRICT_HINT: Record<string, string> = {
  TEXT: "文字",
  NUM: "数字",
  KANA: "カナ",
  DATE: "日付",
  ZIP: "郵便番号",
  TEL: "電話番号",
};

export default function DocTemplates() {
  const s = useStyles();
  const navigate = useNavigate();
  const [items, setItems] = useState<DocTemplateListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<DocMergeCatalog | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [detail, setDetail] = useState<DocTemplateDetail | null>(null);
  const [editCtx, setEditCtx] = useState<DocTemplateListItem | null>(null);
  const [delCtx, setDelCtx] = useState<DocTemplateListItem | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchDocTemplates();
      setItems(r.items);
    } catch (e: any) {
      setError(e?.message ?? "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    fetchDocMergeCatalog().then(setCatalog).catch(() => {});
  }, []);

  const entityLabel = useMemo(() => {
    const m: Record<string, string> = {};
    catalog?.entities.forEach((e) => (m[e.key] = e.label));
    return m;
  }, [catalog]);

  const linkLabel = useMemo(() => {
    const m: Record<string, string> = {};
    catalog?.fields.forEach((f) => (m[f.link] = f.label));
    return m;
  }, [catalog]);

  function fieldSource(f: DocField): string {
    if (f.free_input) return "自由入力（手で記入）";
    const ent = f.entity ? entityLabel[f.entity] ?? f.entity : "";
    const nm = linkLabel[f.link] ?? f.source ?? "";
    return `${ent}　${nm}`.trim();
  }

  const catalogByEntity = useMemo(() => {
    const g: Record<string, { label: string; fields: DocMergeCatalog["fields"] }> = {};
    catalog?.fields.forEach((f) => {
      if (!g[f.entity]) g[f.entity] = { label: f.entity_label, fields: [] };
      g[f.entity].fields.push(f);
    });
    return g;
  }, [catalog]);

  const editFields: FormField[] = [
    { key: "name", label: "テンプレート名", required: true },
    { key: "description", label: "説明", type: "textarea" },
    { key: "is_active", label: "有効（一覧に表示する）", type: "switch" },
  ];

  return (
    <div>
      <div className={s.header}>
        <Title3>差し込み印刷（文書テンプレート）</Title3>
        <span className={s.count}>{loading ? "読み込み中…" : `${items.length} 件`}</span>
      </div>
      <div className={s.crumb}>
        送付書や請求書などの Word / Excel ファイルを「ひな形（テンプレート）」として登録します。ひな形の中に
        <span className={s.code}>{"{MOUNTAIN_…}"}</span>
        という印を書いておくと、あとで会社名や住所などを自動で差し込んで印刷できます。
      </div>

      <div className={s.toolbar}>
        <Button icon={<ArrowClockwise20Regular />} onClick={load} appearance="secondary">
          更新
        </Button>
        <Button
          icon={<QuestionCircle20Regular />}
          onClick={() => setShowHelp((v) => !v)}
          appearance="secondary"
        >
          {showHelp ? "書き方を閉じる" : "ひな形の書き方"}
        </Button>
        <div style={{ flexGrow: 1 }} />
        <Button icon={<Add20Regular />} onClick={() => setUploadOpen(true)} appearance="primary">
          ひな形を登録
        </Button>
      </div>

      {showHelp && (
        <div className={s.help}>
          <div className={s.helpTitle}>ひな形（Word / Excel）への印の書き方</div>
          <Body1>
            Word の文中、または Excel のセルに、差し込みたい場所へ次の形で印を書きます（すべて半角）。
          </Body1>
          <div style={{ margin: "8px 0" }}>
            <span className={s.code}>{"{MOUNTAIN_項目名_差し込み元_入力制限_文字数}"}</span>
          </div>
          <Body1>
            ・<b>項目名</b>＝画面に出る見出し（例：郵便番号）。アンダーバー（_）は使えません。<br />
            ・<b>差し込み元</b>＝自動で入れたいデータ（下の一覧から選ぶ）。手で書く場合は
            <span className={s.code}>NONE</span>。<br />
            ・<b>入力制限</b>＝TEXT（文字）/ NUM（数字）/ KANA（カナ）/ DATE（日付）/ ZIP（郵便番号）/ TEL（電話）。<br />
            ・<b>文字数</b>＝最大文字数（数字）。
          </Body1>
          <div style={{ marginTop: 8 }}>
            <Body1>例）会社の郵便番号を自動で入れる：</Body1>
            <div>
              <span className={s.code}>{"{MOUNTAIN_郵便番号_COMPANY|PostalCode_ZIP_8}"}</span>
            </div>
            <Body1 style={{ marginTop: 4 }}>例）送付理由を手で書く：</Body1>
            <div>
              <span className={s.code}>{"{MOUNTAIN_送付理由_NONE_TEXT_100}"}</span>
            </div>
          </div>

          <div className={s.note}>
            <div className={s.noteTitle}>敬称（様・御中）は「手入力」にしてください</div>
            <Body1>
              宛名のうしろに「様」「御中」を直接書くと、宛名が入らなかったときに
              <b>「様」だけが残って</b>しまいます。敬称は自動ではなく手入力（
              <span className={s.code}>NONE</span>）にして、差し込みのときに入力してください。
            </Body1>
            <div style={{ marginTop: 6 }}>
              <span className={s.code}>
                {"{MOUNTAIN_氏名_PERSON|FullName_TEXT_30} {MOUNTAIN_敬称_NONE_TEXT_6}"}
              </span>
            </div>
            <Body1 style={{ marginTop: 6 }}>
              作成画面で「様」「御中」などを入力します。宛名が無いときは空欄にできます。
            </Body1>
          </div>

          <div className={s.note}>
            <div className={s.noteTitle}>Excel（.xlsx）で作るときのコツ</div>
            <Body1>
              印はセルの中にそのまま書きます（例：セルに
              <span className={s.code}>{"{MOUNTAIN_会社名_COMPANY|Name_TEXT_40}"}</span>
              と入力）。1 つのセルに複数の印を並べても構いません。<br />
              できあがりの PDF は Excel の<b>印刷範囲・用紙設定（ページレイアウト）</b>のとおりになります。
              はみ出す場合は、Excel 側で印刷範囲の設定や「シートを 1 ページに印刷」を指定してから登録してください。
            </Body1>
          </div>

          <div className={s.cataGroup}>
            <div className={s.helpTitle} style={{ marginTop: 12 }}>
              自動で差し込める項目の一覧
            </div>
            {Object.entries(catalogByEntity).map(([key, g]) => (
              <div key={key}>
                <div className={s.cataEntity}>{g.label}</div>
                <div className={s.chips}>
                  {g.fields.map((f) => (
                    <span key={f.link} className={s.code} title={`入力制限：${RESTRICT_HINT[f.restrict] ?? f.restrict}`}>
                      {f.label}｜{f.link}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
          <Table aria-label="テンプレート一覧" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>テンプレート名</TableHeaderCell>
                <TableHeaderCell>説明</TableHeaderCell>
                <TableHeaderCell>元ファイル</TableHeaderCell>
                <TableHeaderCell>差し込み項目</TableHeaderCell>
                <TableHeaderCell>作成日時</TableHeaderCell>
                <TableHeaderCell style={{ flexBasis: "268px", flexGrow: 0, flexShrink: 0 }} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    {t.name}
                    {!t.is_active && (
                      <Badge appearance="tint" color="informative" style={{ marginLeft: 6 }}>
                        非表示
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{t.description ?? "—"}</TableCell>
                  <TableCell>
                    <Badge
                      appearance="tint"
                      color={t.file_name.toLowerCase().endsWith(".xlsx") ? "success" : "brand"}
                      style={{ marginRight: 6 }}
                    >
                      {t.file_name.toLowerCase().endsWith(".xlsx") ? "Excel" : "Word"}
                    </Badge>
                    {t.file_name}
                  </TableCell>
                  <TableCell className={s.mono}>{t.field_count} 項目</TableCell>
                  <TableCell>{fmtDateTime(t.created_at)}</TableCell>
                  <TableCell className={s.ops} style={{ flexBasis: "268px", flexGrow: 0, flexShrink: 0 }}>
                    <div className={s.opsWrap}>
                      <Button
                        size="small"
                        appearance="primary"
                        icon={<Print16Regular />}
                        onClick={() => navigate(`/doc-merge/${t.id}`)}
                        disabled={!t.is_active}
                        style={{ flexShrink: 0, whiteSpace: "nowrap" }}
                      >
                        この書式で作成
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
                              icon={<Eye16Regular />}
                              onClick={async () => setDetail(await fetchDocTemplate(t.id))}
                            >
                              項目を見る
                            </MenuItem>
                            <MenuItem
                              icon={<ArrowDownload16Regular />}
                              onClick={() => downloadDocTemplateFile(t.id, t.file_name)}
                            >
                              原本をダウンロード
                            </MenuItem>
                            <MenuItem icon={<Edit16Regular />} onClick={() => setEditCtx(t)}>
                              編集
                            </MenuItem>
                            <MenuItem icon={<Delete16Regular />} onClick={() => setDelCtx(t)}>
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
                    <Body1>まだひな形が登録されていません。「ひな形を登録」から Word / Excel ファイルを追加してください。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {uploadOpen && (
        <UploadDialog
          onClose={() => setUploadOpen(false)}
          onDone={async () => {
            setUploadOpen(false);
            await load();
          }}
        />
      )}

      {detail && (
        <FieldsDialog
          detail={detail}
          fieldSource={fieldSource}
          onClose={() => setDetail(null)}
        />
      )}

      {editCtx && (
        <FormDialog
          open={!!editCtx}
          title="ひな形の情報を編集"
          fields={editFields}
          initial={{
            name: editCtx.name,
            description: editCtx.description ?? "",
            is_active: editCtx.is_active,
          }}
          submitLabel="保存する"
          onSubmit={async (v) => {
            await updateDocTemplate(editCtx.id, {
              name: String(v.name ?? "").trim(),
              description: String(v.description ?? "").trim() || null,
              is_active: v.is_active === true,
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
          title="ひな形の削除"
          message={`「${delCtx.name}」を削除します。よろしいですか？`}
          confirmLabel="削除する"
          onConfirm={async () => {
            await deleteDocTemplate(delCtx.id);
            setDelCtx(null);
            await load();
          }}
          onClose={() => setDelCtx(null)}
        />
      )}
    </div>
  );
}

// ---- Word ファイルのアップロード（multipart 専用ダイアログ） ----
function UploadDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const s = useStyles();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ field_count: number; unknown_count: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit() {
    if (!file) {
      setError("Word（.docx）または Excel（.xlsx）ファイルを選んでください");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await uploadDocTemplate(file, name.trim() || file.name, description.trim());
      setResult({ field_count: r.field_count, unknown_count: r.unknown_count });
    } catch (e: any) {
      setError(e?.message ?? "登録に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && !busy && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>ひな形（Word / Excel）を登録</DialogTitle>
          <DialogContent>
            {error && (
              <MessageBar intent="error" style={{ marginBottom: 12 }}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            {result ? (
              <MessageBar intent={result.unknown_count > 0 ? "warning" : "success"}>
                <MessageBarBody>
                  登録しました。差し込み項目を {result.field_count} 個みつけました。
                  {result.unknown_count > 0 &&
                    `（うち ${result.unknown_count} 個は差し込み元が見つからない印です。印の書き方をご確認ください。）`}
                </MessageBarBody>
              </MessageBar>
            ) : (
              <div style={{ display: "grid", rowGap: 12, paddingTop: 4 }}>
                <Field label="Word（.docx）または Excel（.xlsx）ファイル" required>
                  <div className={s.fileRow}>
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".docx,.xlsx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        setFile(f);
                        if (f && !name) setName(f.name.replace(/\.(docx|xlsx)$/i, ""));
                      }}
                    />
                  </div>
                </Field>
                <Field label="テンプレート名" required hint="一覧に表示される名前（例：送付書）">
                  <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="例）送付書" />
                </Field>
                <Field label="説明">
                  <Textarea
                    value={description}
                    onChange={(_, d) => setDescription(d.value)}
                    placeholder="どんな時に使うひな形かをメモできます"
                  />
                </Field>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            {result ? (
              <Button appearance="primary" onClick={onDone}>
                閉じる
              </Button>
            ) : (
              <>
                <Button appearance="secondary" onClick={onClose} disabled={busy}>
                  キャンセル
                </Button>
                <Button appearance="primary" onClick={submit} disabled={busy}>
                  {busy ? <Spinner size="tiny" /> : "登録する"}
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ---- 差し込み項目の確認ダイアログ ----
function FieldsDialog({
  detail,
  fieldSource,
  onClose,
}: {
  detail: DocTemplateDetail;
  fieldSource: (f: DocField) => string;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>差し込み項目：{detail.name}</DialogTitle>
          <DialogContent>
            {detail.unknown_count > 0 && (
              <MessageBar intent="warning" style={{ marginBottom: 12 }}>
                <MessageBarBody>
                  差し込み元が見つからない印が {detail.unknown_count} 個あります。印の書き方（差し込み元の綴り）をご確認ください。
                </MessageBarBody>
              </MessageBar>
            )}
            {detail.fields.length === 0 ? (
              <Body1>このひな形には差し込みの印がありません。</Body1>
            ) : (
              <Table size="small" aria-label="差し込み項目">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>項目名</TableHeaderCell>
                    <TableHeaderCell>差し込み元</TableHeaderCell>
                    <TableHeaderCell>入力制限</TableHeaderCell>
                    <TableHeaderCell>文字数</TableHeaderCell>
                    <TableHeaderCell>状態</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.fields.map((f) => (
                    <TableRow key={f.token}>
                      <TableCell>{f.label}</TableCell>
                      <TableCell>{fieldSource(f)}</TableCell>
                      <TableCell>{RESTRICT_HINT[f.restrict] ?? f.restrict}</TableCell>
                      <TableCell>{f.maxlen || "—"}</TableCell>
                      <TableCell>
                        {f.known ? (
                          <Badge appearance="tint" color="success">
                            OK
                          </Badge>
                        ) : (
                          <Badge appearance="tint" color="warning">
                            要確認
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>
              閉じる
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
