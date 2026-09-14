import { useEffect, useId, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { fetchMaster, MasterItem } from "../api/client";

export interface RecordSearchItem {
  id: string;
  label: string;
  cells: string[];
}

export interface RecordSearchConfig {
  title: string;
  searchHint: string;
  columns: string[];
  roleLabel: string;
  allowDefault?: boolean;
  search: (params: { q: string; limit: number; offset: number }) =>
    Promise<{ total: number; items: RecordSearchItem[] }>;
}

export interface RecordLinkValues {
  entity_id: string;
  link_category: string;
  is_default: boolean;
}

const PAGE_SIZE = 20;
const useStyles = makeStyles({
  surface: { width: "calc(100vw - 32px)", maxWidth: "1000px" },
  content: { display: "grid", gap: "12px", minWidth: 0 },
  search: { display: "flex", gap: "8px", alignItems: "flex-end", flexWrap: "wrap" },
  keyword: { flexGrow: 1, minWidth: "180px" },
  tableScroll: { overflowX: "auto", maxHeight: "300px", overflowY: "auto" },
  table: { minWidth: "760px" },
  cell: { overflowWrap: "anywhere" },
  selected: { backgroundColor: tokens.colorBrandBackground2 },
  summary: {
    padding: "10px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflowWrap: "anywhere",
  },
  pager: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
  hint: { color: tokens.colorNeutralForeground3, fontSize: "12px" },
  actions: { flexWrap: "wrap" },
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "通信状態をご確認ください。";
}

// 開くたびにマウントし直す。検索・選択・保存状態を別の紐付けに持ち越さない。
export default function RecordLinkDialog({
  config,
  onSubmit,
  onClose,
}: {
  config: RecordSearchConfig;
  onSubmit: (values: RecordLinkValues) => Promise<void>;
  onClose: () => void;
}) {
  const s = useStyles();
  const radioName = useId();
  const hintId = useId();
  const [keyword, setKeyword] = useState("");
  const [request, setRequest] = useState({ q: "", offset: 0, revision: 0 });
  const [result, setResult] = useState<{ total: number; items: RecordSearchItem[] } | null>(null);
  const [searching, setSearching] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RecordSearchItem | null>(null);
  const [roles, setRoles] = useState<MasterItem[]>([]);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [rolesRevision, setRolesRevision] = useState(0);
  const [role, setRole] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setSearching(true);
    setSearchError(null);
    setResult(null);
    config.search({ q: request.q, offset: request.offset, limit: PAGE_SIZE })
      .then((response) => {
        if (active) setResult(response);
      })
      .catch((error: unknown) => {
        if (active) setSearchError(`検索に失敗しました。${errorMessage(error)}`);
      })
      .finally(() => {
        if (active) setSearching(false);
      });
    // 遅い検索結果や閉じたモーダルの結果で現在の表示を上書きしない。
    return () => { active = false; };
  }, [config, request]);

  useEffect(() => {
    let active = true;
    setRolesLoading(true);
    setRolesError(null);
    fetchMaster("link_category")
      .then((items) => {
        if (!active) return;
        setRoles(items);
        if (!items.length) setRolesError("紐付け種別が未登録です。管理者にご確認ください。");
      })
      .catch((error: unknown) => {
        if (active) setRolesError(`紐付け種別の読み込みに失敗しました。${errorMessage(error)}`);
      })
      .finally(() => {
        if (active) setRolesLoading(false);
      });
    return () => { active = false; };
  }, [rolesRevision]);

  function search(q: string, offset = 0) {
    if (savingRef.current) return;
    setSelected(null);
    setSaveError(null);
    setSearching(true);
    setResult(null);
    setSearchError(null);
    setRequest((prev) => ({ q: q.trim(), offset, revision: prev.revision + 1 }));
  }

  const canSave = !!selected && roles.some((r) => r.code === role)
    && !searching && !rolesLoading && !rolesError && !saving;

  async function submit() {
    if (!canSave || !selected || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onSubmit({ entity_id: selected.id, link_category: role, is_default: isDefault });
    } catch (error: unknown) {
      if (mounted.current) setSaveError(`紐付けに失敗しました。${errorMessage(error)}`);
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(_, data) => { if (!data.open && !savingRef.current) onClose(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>{config.title}</DialogTitle>
          <DialogContent className={s.content}>
            <form className={s.search} onSubmit={(event) => { event.preventDefault(); search(keyword); }}>
              <Field label="キーワード検索" className={s.keyword} hint={config.searchHint}>
                <Input
                  value={keyword}
                  onChange={(_, data) => setKeyword(data.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
                      event.preventDefault();
                    }
                  }}
                  disabled={saving}
                  placeholder={config.searchHint}
                />
              </Field>
              <Button type="submit" disabled={saving}>検索</Button>
              <Button type="button" disabled={saving} onClick={() => { setKeyword(""); search(""); }}>条件をクリア</Button>
            </form>
            <div className={s.hint} id={hintId}>
              一覧から1件を選択してください（20件ずつ表示）。幅が狭い場合は表を横にスクロールできます。
            </div>
            <div role="status" aria-live="polite">
              {searching ? <Spinner size="tiny" label="検索中…" /> : result && (
                <>検索結果：{result.total} 件
                  {result.items.length > 0 && `（${request.offset + 1}–${request.offset + result.items.length} 件を表示）`}
                  {request.q ? ` ／「${request.q}」` : " ／すべて"}
                </>
              )}
            </div>
            {searchError && (
              <MessageBar intent="error">
                <MessageBarBody>
                  {searchError} <Button onClick={() => search(request.q, request.offset)}>再試行</Button>
                </MessageBarBody>
              </MessageBar>
            )}
            {!searching && result && (
              <>
                {result.items.length ? (
                  <div className={s.tableScroll} role="region" aria-label="検索結果の表" tabIndex={0}>
                    <Table className={s.table} aria-label={`${config.title}の検索結果`} aria-describedby={hintId}>
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell style={{ width: 64 }}>選択</TableHeaderCell>
                          {config.columns.map((column) => <TableHeaderCell key={column}>{column}</TableHeaderCell>)}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.items.map((item) => (
                          <TableRow key={item.id} className={selected?.id === item.id ? s.selected : undefined}>
                            <TableCell>
                              <input
                                type="radio"
                                name={radioName}
                                value={item.id}
                                checked={selected?.id === item.id}
                                onChange={() => { setSelected(item); setSaveError(null); }}
                                disabled={saving}
                                aria-label={`${item.cells.join("、")} を選択`}
                              />
                            </TableCell>
                            {item.cells.map((cell, index) => (
                              <TableCell key={config.columns[index]} className={s.cell}>{cell}</TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <div role="status">該当するレコードがありません。検索条件を変更してください。</div>
                )}
              </>
            )}
            <div className={s.pager}>
              <Button disabled={saving || searching || request.offset === 0}
                onClick={() => search(request.q, Math.max(0, request.offset - PAGE_SIZE))}>前の20件</Button>
              <Button disabled={saving || searching || !result || request.offset + PAGE_SIZE >= result.total}
                onClick={() => search(request.q, request.offset + PAGE_SIZE)}>次の20件</Button>
            </div>
            <div className={s.summary} role="status" aria-live="polite">
              {selected ? (
                <>
                  <strong>選択中：{selected.label}</strong>
                  <div>{selected.cells.map((cell, index) => `${config.columns[index]}：${cell}`).join(" ／ ")}</div>
                </>
              ) : "未選択：検索結果の「選択」でレコードを選んでください。"}
            </div>
            {rolesLoading && <Spinner size="tiny" label="紐付け種別を読み込み中…" />}
            {rolesError && (
              <MessageBar intent="error">
                <MessageBarBody>{rolesError} <Button disabled={rolesLoading || saving}
                  onClick={() => setRolesRevision((value) => value + 1)}>種別を再読み込み</Button></MessageBarBody>
              </MessageBar>
            )}
            <Field label={config.roleLabel} required>
              <Dropdown
                placeholder="選択してください"
                value={roles.find((r) => r.code === role)?.label ?? ""}
                selectedOptions={role ? [role] : []}
                disabled={saving || rolesLoading || !!rolesError}
                onOptionSelect={(_, data) => { setRole(data.optionValue ?? ""); setSaveError(null); }}
              >
                {roles.map((item) => <Option key={item.code} value={item.code}>{item.label}</Option>)}
              </Dropdown>
            </Field>
            {config.allowDefault && (
              <Switch label="既定にする" checked={isDefault} disabled={saving}
                onChange={(_, data) => setIsDefault(data.checked)} />
            )}
            {saveError && <MessageBar intent="error"><MessageBarBody>{saveError}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions className={s.actions}>
            <Button disabled={saving} onClick={onClose}>キャンセル</Button>
            <Button appearance="primary" disabled={!canSave} disabledFocusable={saving} onClick={() => void submit()}>
              {saving ? <Spinner size="tiny" label="紐付け中…" /> : "紐付ける"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
