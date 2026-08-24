import { ReactNode, useEffect, useState } from "react";
import {
  makeStyles,
  tokens,
  Title3,
  Body1,
  Caption1,
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
import {
  ArrowClockwise20Regular,
  Add20Regular,
  Edit16Regular,
  Delete16Regular,
  ArrowExportUp16Regular,
  ArrowImport16Regular,
  DismissCircle16Regular,
  Print16Regular,
  Print20Regular,
  Tag16Regular,
} from "@fluentui/react-icons";
import {
  fetchOriginals,
  OriginalsData,
  OriginalDoc,
  StorageFile,
  StorageLocation,
  fetchContracts,
  ContractListItem,
  createOriginal,
  updateOriginal,
  deleteOriginal,
  disposeOriginal,
  lendOriginal,
  returnOriginal,
  createStorageFile,
  updateStorageFile,
  deleteStorageFile,
  createStorageLocation,
  updateStorageLocation,
  deleteStorageLocation,
} from "../api/client";
import { fmtDate, originalStatusAppearance } from "../util/format";
import { printA4, escHtml, todayYmd } from "../util/print";
import FormDialog, { FormField, FormValues } from "../components/FormDialog";
import ConfirmDialog from "../components/ConfirmDialog";

type DlgSpec = {
  title: string;
  fields: FormField[];
  initial?: FormValues;
  submitLabel?: string;
  onSubmit: (v: FormValues) => Promise<void>;
};

type ConfirmSpec = {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
};

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: "4px",
  },
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "12px" },
  toolbar: { display: "flex", columnGap: "8px", marginBottom: "12px", alignItems: "center" },
  kpis: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: "12px",
    marginBottom: "16px",
  },
  kpi: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "12px 16px",
  },
  kpiNum: { fontSize: "24px", fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  mono: { fontVariantNumeric: "tabular-nums" },
  wrap: { maxWidth: "260px", whiteSpace: "normal", wordBreak: "break-all" },
  ops: { display: "flex", columnGap: "4px", flexWrap: "wrap" },
});

const num = (v: unknown) => (v == null ? 0 : Number(v));

export default function Originals() {
  const s = useStyles();
  const [tab, setTab] = useState("documents");
  const [data, setData] = useState<OriginalsData | null>(null);
  const [contracts, setContracts] = useState<ContractListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dlg, setDlg] = useState<DlgSpec | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchOriginals());
    } catch (e: any) {
      setError(e?.message ?? "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    fetchContracts({}).then((r) => setContracts(r.items)).catch(() => {});
  }, []);

  const contractOptions = [
    { value: "", label: "（契約に紐づけない）" },
    ...contracts.map((c) => ({
      value: c.id,
      label: `${c.contract_no}｜${c.contract_summary}`,
    })),
  ];
  const fileOptions = [
    { value: "", label: "（保管ファイルを指定しない）" },
    ...(data?.storage_files ?? []).map((f) => ({
      value: f.id,
      label: `${f.file_code}｜${f.title}`,
    })),
  ];
  const locationOptions = [
    { value: "", label: "（格納場所を指定しない）" },
    ...(data?.locations ?? []).map((l) => ({ value: l.id, label: l.name })),
  ];

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e?.message ?? "処理に失敗しました");
    } finally {
      setBusyId(null);
    }
  }

  // ---------- 原本 ----------
  function docFields(): FormField[] {
    return [
      { key: "doc_type", label: "原本の種別", type: "text", required: true, placeholder: "例）契約書 原本 / 印鑑証明書" },
      { key: "contract_id", label: "紐づける契約", type: "select", options: contractOptions },
      { key: "storage_file_id", label: "保管ファイル（バインダー）", type: "select", options: fileOptions },
      { key: "received_on", label: "受領日", type: "date" },
      { key: "note", label: "備考", type: "textarea", placeholder: "任意" },
    ];
  }

  function openAddDoc() {
    setDlg({
      title: "原本を登録",
      fields: docFields(),
      submitLabel: "登録する",
      onSubmit: async (v) => {
        await createOriginal({
          doc_type: String(v.doc_type ?? "").trim(),
          contract_id: String(v.contract_id ?? "") || null,
          storage_file_id: String(v.storage_file_id ?? "") || null,
          received_on: String(v.received_on ?? "") || null,
          note: String(v.note ?? "").trim() || null,
        });
        setDlg(null);
        await load();
      },
    });
  }

  function openEditDoc(d: OriginalDoc) {
    setDlg({
      title: "原本を編集",
      fields: docFields(),
      initial: {
        doc_type: d.doc_type,
        contract_id: d.contract_id ?? "",
        storage_file_id: d.storage_file_id ?? "",
        received_on: d.received_on ?? "",
        note: d.note ?? "",
      },
      submitLabel: "保存する",
      onSubmit: async (v) => {
        await updateOriginal(d.id, {
          doc_type: String(v.doc_type ?? "").trim(),
          contract_id: String(v.contract_id ?? "") || null,
          storage_file_id: String(v.storage_file_id ?? "") || null,
          received_on: String(v.received_on ?? "") || null,
          note: String(v.note ?? "").trim() || null,
        });
        setDlg(null);
        await load();
      },
    });
  }

  function docOps(d: OriginalDoc): ReactNode {
    const btns: ReactNode[] = [];
    if (d.status === "保管中") {
      btns.push(
        <Button
          key="lend"
          size="small"
          icon={<ArrowExportUp16Regular />}
          disabled={busyId === d.id}
          onClick={() => act(d.id, () => lendOriginal(d.id))}
        >
          貸出
        </Button>
      );
    }
    if (d.status === "貸出中") {
      btns.push(
        <Button
          key="return"
          size="small"
          icon={<ArrowImport16Regular />}
          disabled={busyId === d.id}
          onClick={() => act(d.id, () => returnOriginal(d.id))}
        >
          返却
        </Button>
      );
    }
    btns.push(
      <Button key="edit" size="small" icon={<Edit16Regular />} onClick={() => openEditDoc(d)}>
        編集
      </Button>
    );
    if (d.status !== "廃棄済" && d.status !== "貸出中") {
      btns.push(
        <Button
          key="dispose"
          size="small"
          icon={<DismissCircle16Regular />}
          onClick={() =>
            setConfirm({
              title: "原本を廃棄",
              message: `「${d.doc_type}」を廃棄済みにします。廃棄日と承認者が記録されます。よろしいですか？`,
              confirmLabel: "廃棄する",
              onConfirm: async () => {
                await disposeOriginal(d.id);
                setConfirm(null);
                await load();
              },
            })
          }
        >
          廃棄
        </Button>
      );
    }
    btns.push(
      <Button
        key="del"
        size="small"
        icon={<Delete16Regular />}
        onClick={() =>
          setConfirm({
            title: "原本を削除",
            message: `「${d.doc_type}」を削除します。元に戻せません。よろしいですか？`,
            confirmLabel: "削除する",
            onConfirm: async () => {
              await deleteOriginal(d.id);
              setConfirm(null);
              await load();
            },
          })
        }
      >
        削除
      </Button>
    );
    return <div className={s.ops}>{btns}</div>;
  }

  // ---------- 保管ファイル ----------
  function fileFields(): FormField[] {
    return [
      { key: "file_code", label: "ファイルコード", type: "text", required: true, placeholder: "例）BND-2026-001" },
      { key: "title", label: "タイトル", type: "text", required: true, placeholder: "例）契約書 原本ファイル①" },
      { key: "category", label: "分類", type: "text", placeholder: "例）契約書 / 証票" },
      { key: "location_id", label: "格納場所", type: "select", options: locationOptions },
      { key: "note", label: "備考", type: "textarea", placeholder: "任意" },
    ];
  }

  function openAddFile() {
    setDlg({
      title: "保管ファイルを追加",
      fields: fileFields(),
      submitLabel: "登録する",
      onSubmit: async (v) => {
        await createStorageFile({
          file_code: String(v.file_code ?? "").trim(),
          title: String(v.title ?? "").trim(),
          category: String(v.category ?? "").trim() || null,
          location_id: String(v.location_id ?? "") || null,
          note: String(v.note ?? "").trim() || null,
        });
        setDlg(null);
        await load();
      },
    });
  }

  function openEditFile(f: StorageFile) {
    setDlg({
      title: "保管ファイルを編集",
      fields: fileFields(),
      initial: {
        file_code: f.file_code,
        title: f.title,
        category: f.category ?? "",
        location_id: f.location_id ?? "",
        note: f.note ?? "",
      },
      submitLabel: "保存する",
      onSubmit: async (v) => {
        await updateStorageFile(f.id, {
          file_code: String(v.file_code ?? "").trim(),
          title: String(v.title ?? "").trim(),
          category: String(v.category ?? "").trim() || null,
          location_id: String(v.location_id ?? "") || null,
          note: String(v.note ?? "").trim() || null,
        });
        setDlg(null);
        await load();
      },
    });
  }

  // ---------- A4印刷（ラベル / 台帳） ----------
  function printLabel(f: StorageFile) {
    const html = `<div class="a4"><div class="a4-lb">
      <div class="lb-head">MOUNTAIN ／ 原本保管ラベル</div>
      <div class="lb-code">${escHtml(f.file_code)}</div>
      <div class="lb-title">${escHtml(f.title)}</div>
      <table class="lb-tbl">
        <tr><th>種別</th><td>${escHtml(f.category || "―")}</td></tr>
        <tr><th>格納場所</th><td>${escHtml(f.location_name || "―")}</td></tr>
        <tr><th>収容点数</th><td>${num(f.doc_count)} 点</td></tr>
        <tr><th>発行日</th><td>${todayYmd()}</td></tr>
      </table>
      <div class="lb-note">※ このラベルをファイル（バインダー）の背表紙に貼付してください。</div>
    </div></div>`;
    printA4(`原本保管ラベル ${f.file_code}`, html);
  }

  function printLedger(f?: StorageFile) {
    if (!data) return;
    const locName = (fileId: string | null): string => {
      if (!fileId) return "―";
      return data.storage_files.find((x) => x.id === fileId)?.location_name || "―";
    };
    const fileLabel = (d: OriginalDoc): string =>
      d.file_code ? `${d.file_code}｜${d.file_title ?? ""}` : "未格納";
    const list = data.documents
      .filter((d) => !f || d.storage_file_id === f.id)
      .slice()
      .sort((a, b) => String(a.received_on).localeCompare(String(b.received_on)));
    const body =
      list
        .map(
          (d, idx) =>
            `<tr><td>${idx + 1}</td><td>${escHtml(d.doc_type)}</td><td>${escHtml(
              d.contract_no || "―"
            )}</td><td>${escHtml(d.received_on || "")}</td><td>${escHtml(
              fileLabel(d)
            )}</td><td>${escHtml(locName(d.storage_file_id))}</td><td>${escHtml(
              d.status || ""
            )}</td><td>${escHtml(d.note || "")}</td></tr>`
        )
        .join("") ||
      '<tr><td colspan="8" style="text-align:center">該当なし</td></tr>';
    const scope = f ? `対象：${f.file_code} ${f.title}` : "対象：全ファイル";
    const html = `<div class="a4"><h2 class="a4-h">原本保管台帳</h2>
      <div class="a4-sub">発行日：${todayYmd()} ／ ${escHtml(scope)} ／ ${list.length}件</div>
      <table class="a4-tbl"><thead><tr><th>#</th><th>原本種別</th><th>対象契約</th><th>受領日</th><th>保管ファイル</th><th>格納場所</th><th>状態</th><th>備考</th></tr></thead><tbody>${body}</tbody></table>
      <div class="a4-foot">合計 ${list.length} 件　／　MOUNTAIN 原本ファイル管理</div>
    </div>`;
    printA4(f ? `原本保管台帳 ${f.file_code}` : "原本保管台帳（全体）", html);
  }

  function fileOps(f: StorageFile): ReactNode {
    return (
      <div className={s.ops}>
        <Button size="small" icon={<Tag16Regular />} onClick={() => printLabel(f)}>
          ラベル
        </Button>
        <Button size="small" icon={<Print16Regular />} onClick={() => printLedger(f)}>
          台帳
        </Button>
        <Button size="small" icon={<Edit16Regular />} onClick={() => openEditFile(f)}>
          編集
        </Button>
        <Button
          size="small"
          icon={<Delete16Regular />}
          onClick={() =>
            setConfirm({
              title: "保管ファイルを削除",
              message: `「${f.file_code}｜${f.title}」を削除します。よろしいですか？`,
              confirmLabel: "削除する",
              onConfirm: async () => {
                await deleteStorageFile(f.id);
                setConfirm(null);
                await load();
              },
            })
          }
        >
          削除
        </Button>
      </div>
    );
  }

  // ---------- 格納場所 ----------
  function locFields(): FormField[] {
    return [
      { key: "name", label: "格納場所の名称", type: "text", required: true, placeholder: "例）本社 書庫A" },
      { key: "detail", label: "詳細（棚・段など）", type: "text", placeholder: "例）3列目 2段目" },
      { key: "note", label: "備考", type: "textarea", placeholder: "任意" },
    ];
  }

  function openAddLoc() {
    setDlg({
      title: "格納場所を追加",
      fields: locFields(),
      submitLabel: "登録する",
      onSubmit: async (v) => {
        await createStorageLocation({
          name: String(v.name ?? "").trim(),
          detail: String(v.detail ?? "").trim() || null,
          note: String(v.note ?? "").trim() || null,
        });
        setDlg(null);
        await load();
      },
    });
  }

  function openEditLoc(l: StorageLocation) {
    setDlg({
      title: "格納場所を編集",
      fields: locFields(),
      initial: { name: l.name, detail: l.detail ?? "", note: l.note ?? "" },
      submitLabel: "保存する",
      onSubmit: async (v) => {
        await updateStorageLocation(l.id, {
          name: String(v.name ?? "").trim(),
          detail: String(v.detail ?? "").trim() || null,
          note: String(v.note ?? "").trim() || null,
        });
        setDlg(null);
        await load();
      },
    });
  }

  function locOps(l: StorageLocation): ReactNode {
    return (
      <div className={s.ops}>
        <Button size="small" icon={<Edit16Regular />} onClick={() => openEditLoc(l)}>
          編集
        </Button>
        <Button
          size="small"
          icon={<Delete16Regular />}
          onClick={() =>
            setConfirm({
              title: "格納場所を削除",
              message: `「${l.name}」を削除します。よろしいですか？`,
              confirmLabel: "削除する",
              onConfirm: async () => {
                await deleteStorageLocation(l.id);
                setConfirm(null);
                await load();
              },
            })
          }
        >
          削除
        </Button>
      </div>
    );
  }

  const kpis = data?.kpis ?? {};

  return (
    <div>
      <div className={s.header}>
        <Title3>原本管理</Title3>
        <Button appearance="subtle" icon={<ArrowClockwise20Regular />} onClick={load}>
          再読み込み
        </Button>
      </div>
      <div className={s.crumb}>ホーム ／ 原本管理</div>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.kpis}>
        <div className={s.kpi}>
          <Caption1>原本 総数</Caption1>
          <div className={s.kpiNum}>{num(kpis.docs_count)}</div>
        </div>
        <div className={s.kpi}>
          <Caption1>保管中</Caption1>
          <div className={s.kpiNum}>{num(kpis.stored_count)}</div>
        </div>
        <div className={s.kpi}>
          <Caption1>貸出中</Caption1>
          <div className={s.kpiNum}>{num(kpis.lent_count)}</div>
        </div>
        <div className={s.kpi}>
          <Caption1>保管ファイル</Caption1>
          <div className={s.kpiNum}>{num(kpis.files_count)}</div>
        </div>
        <div className={s.kpi}>
          <Caption1>格納場所</Caption1>
          <div className={s.kpiNum}>{num(kpis.locations_count)}</div>
        </div>
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
        <Tab value="documents">原本一覧</Tab>
        <Tab value="files">保管ファイル</Tab>
        <Tab value="locations">格納場所</Tab>
      </TabList>

      {loading && <Spinner style={{ marginTop: 24 }} label="読み込み中..." />}

      {!loading && data && tab === "documents" && (
        <div style={{ marginTop: 12 }}>
          <div className={s.toolbar}>
            <Button appearance="primary" icon={<Add20Regular />} onClick={openAddDoc}>
              原本を登録
            </Button>
            <Body1>{data.documents.length} 件</Body1>
          </div>
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>種別</TableHeaderCell>
                <TableHeaderCell>契約番号</TableHeaderCell>
                <TableHeaderCell>受領日</TableHeaderCell>
                <TableHeaderCell>状態</TableHeaderCell>
                <TableHeaderCell>保管ファイル</TableHeaderCell>
                <TableHeaderCell>貸出先／廃棄</TableHeaderCell>
                <TableHeaderCell>操作</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.documents.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className={s.wrap}>{d.doc_type}</TableCell>
                  <TableCell className={s.mono}>{d.contract_no ?? "—"}</TableCell>
                  <TableCell className={s.mono}>{fmtDate(d.received_on)}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={originalStatusAppearance(d.status)}>
                      {d.status}
                    </Badge>
                  </TableCell>
                  <TableCell className={s.wrap}>
                    {d.file_code ? `${d.file_code}｜${d.file_title ?? ""}` : "—"}
                  </TableCell>
                  <TableCell className={s.wrap}>
                    {d.status === "貸出中" && d.borrowed_by_name
                      ? `貸出：${d.borrowed_by_name}`
                      : d.status === "廃棄済"
                      ? `廃棄：${fmtDate(d.disposed_at)}${d.disposed_by_name ? `（${d.disposed_by_name}）` : ""}`
                      : "—"}
                  </TableCell>
                  <TableCell>{docOps(d)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {!loading && data && tab === "files" && (
        <div style={{ marginTop: 12 }}>
          <div className={s.toolbar}>
            <Button appearance="primary" icon={<Add20Regular />} onClick={openAddFile}>
              保管ファイルを追加
            </Button>
            <Button
              appearance="secondary"
              icon={<Print20Regular />}
              onClick={() => printLedger()}
            >
              台帳を印刷（全体・A4）
            </Button>
            <Body1>{data.storage_files.length} 件</Body1>
          </div>
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>コード</TableHeaderCell>
                <TableHeaderCell>タイトル</TableHeaderCell>
                <TableHeaderCell>分類</TableHeaderCell>
                <TableHeaderCell>格納場所</TableHeaderCell>
                <TableHeaderCell>収納数</TableHeaderCell>
                <TableHeaderCell>操作</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.storage_files.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className={s.mono}>{f.file_code}</TableCell>
                  <TableCell className={s.wrap}>{f.title}</TableCell>
                  <TableCell>{f.category ?? "—"}</TableCell>
                  <TableCell>{f.location_name ?? "—"}</TableCell>
                  <TableCell className={s.mono}>{num(f.doc_count)}</TableCell>
                  <TableCell>{fileOps(f)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {!loading && data && tab === "locations" && (
        <div style={{ marginTop: 12 }}>
          <div className={s.toolbar}>
            <Button appearance="primary" icon={<Add20Regular />} onClick={openAddLoc}>
              格納場所を追加
            </Button>
            <Body1>{data.locations.length} 件</Body1>
          </div>
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>名称</TableHeaderCell>
                <TableHeaderCell>詳細</TableHeaderCell>
                <TableHeaderCell>保管ファイル数</TableHeaderCell>
                <TableHeaderCell>備考</TableHeaderCell>
                <TableHeaderCell>操作</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.locations.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className={s.wrap}>{l.name}</TableCell>
                  <TableCell className={s.wrap}>{l.detail ?? "—"}</TableCell>
                  <TableCell className={s.mono}>{num(l.file_count)}</TableCell>
                  <TableCell className={s.wrap}>{l.note ?? "—"}</TableCell>
                  <TableCell>{locOps(l)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {dlg && (
        <FormDialog
          open
          title={dlg.title}
          fields={dlg.fields}
          initial={dlg.initial}
          submitLabel={dlg.submitLabel}
          onSubmit={dlg.onSubmit}
          onClose={() => setDlg(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          open
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
