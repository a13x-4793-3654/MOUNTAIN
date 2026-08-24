import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  makeStyles,
  tokens,
  Title3,
  Body1,
  Button,
  Spinner,
  Input,
  Textarea,
  Field,
  Badge,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import {
  ArrowLeft20Regular,
  Print20Regular,
  Dismiss16Regular,
  Search16Regular,
} from "@fluentui/react-icons";
import {
  fetchDocTemplate,
  resolveDocMerge,
  generateDocument,
  regenerateDocument,
  fetchGeneratedDoc,
  downloadGeneratedPdf,
  fetchContracts,
  fetchCompanies,
  fetchPersons,
  fetchAccounts,
  DocTemplateDetail,
  DocField,
  DocMergeSelection,
} from "../api/client";

const useStyles = makeStyles({
  header: { display: "flex", alignItems: "center", columnGap: "10px", marginBottom: "4px" },
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "12px" },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", alignItems: "start" },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "14px 16px",
    marginBottom: "16px",
  },
  cardTitle: { fontWeight: 700, marginBottom: "10px" },
  picker: { marginBottom: "14px" },
  pickerLabel: { fontWeight: 600, marginBottom: "4px" },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: "6px",
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    borderRadius: "6px",
    padding: "3px 8px",
    fontSize: "13px",
    marginBottom: "6px",
  },
  results: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "6px",
    marginTop: "4px",
    maxHeight: "220px",
    overflowY: "auto",
  },
  resultRow: {
    display: "block",
    width: "100%",
    textAlign: "left",
    border: "none",
    background: "none",
    padding: "6px 10px",
    cursor: "pointer",
    fontSize: "13px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  fieldRow: { marginBottom: "12px" },
  hint: { color: tokens.colorNeutralForeground3, fontSize: "11.5px" },
  autoTag: { marginLeft: "6px" },
  actions: { display: "flex", columnGap: "8px", marginTop: "8px", flexWrap: "wrap" },
  muted: { color: tokens.colorNeutralForeground3 },
});

const RESTRICT_HINT: Record<string, string> = {
  TEXT: "文字", NUM: "数字", KANA: "カナ", DATE: "日付", ZIP: "郵便番号", TEL: "電話番号",
};

type EntityKey = "contract" | "company" | "person" | "account";

interface PickResult {
  id: string;
  label: string;
  sub?: string;
}

function RecordPicker(props: {
  title: string;
  placeholder: string;
  selectedLabel: string | null;
  auto: boolean;
  onSearch: (q: string) => Promise<PickResult[]>;
  onPick: (id: string, label: string) => void;
  onClear: () => void;
}) {
  const s = useStyles();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PickResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function run(text: string) {
    setQ(text);
    if (!text.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      const r = await props.onSearch(text.trim());
      setResults(r);
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={s.picker}>
      <div className={s.pickerLabel}>{props.title}</div>
      {props.selectedLabel ? (
        <div>
          <span className={s.chip}>
            {props.selectedLabel}
            {props.auto && (
              <Badge size="small" appearance="tint" color="informative">
                自動
              </Badge>
            )}
            <Button
              size="small"
              appearance="subtle"
              icon={<Dismiss16Regular />}
              onClick={() => {
                props.onClear();
                setQ("");
                setResults([]);
                setOpen(false);
              }}
            >
              選び直す
            </Button>
          </span>
        </div>
      ) : (
        <div style={{ color: tokens.colorNeutralForeground3, fontSize: 12, marginBottom: 4 }}>
          未選択
        </div>
      )}
      <Input
        value={q}
        placeholder={props.placeholder}
        contentBefore={<Search16Regular />}
        onChange={(_, d) => run(d.value)}
      />
      {busy && <Spinner size="tiny" style={{ marginTop: 4 }} />}
      {open && results.length > 0 && (
        <div className={s.results}>
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              className={s.resultRow}
              onClick={() => {
                props.onPick(r.id, r.label);
                setQ("");
                setResults([]);
                setOpen(false);
              }}
            >
              <b>{r.label}</b>
              {r.sub && <span className={s.muted}>　{r.sub}</span>}
            </button>
          ))}
        </div>
      )}
      {open && results.length === 0 && !busy && (
        <div className={s.hint} style={{ marginTop: 4 }}>
          該当なし
        </div>
      )}
    </div>
  );
}

export default function DocMerge() {
  const s = useStyles();
  const navigate = useNavigate();
  const { templateId = "" } = useParams();
  const [sp] = useSearchParams();
  const editId = sp.get("edit"); // 履歴からの再編集（生成済みID）

  const [tpl, setTpl] = useState<DocTemplateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});

  // 手動で選んだレコード（resolve へ送る）。null=未選択（契約から自動導出）。
  const [manual, setManual] = useState<DocMergeSelection>({});
  // 直近 resolve の実効選択とラベル（チップ表示用）。
  const [effLabels, setEffLabels] = useState<Record<EntityKey, string | null>>({
    contract: null, company: null, person: null, account: null,
  });
  const [effSel, setEffSel] = useState<DocMergeSelection>({});

  const [generating, setGenerating] = useState(false);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  const fields: DocField[] = tpl?.fields ?? [];

  const need = useMemo(() => {
    const ents = new Set(fields.map((f) => f.entity).filter(Boolean) as string[]);
    return {
      contract: ents.has("CONTRACT") || ents.has("AMOUNT") || ents.has("ASSIGNEE"),
      company: ents.has("COMPANY"),
      person: ents.has("PERSON"),
      account: ents.has("ACCOUNT"),
      anyPick: ents.has("CONTRACT") || ents.has("AMOUNT") || ents.has("ASSIGNEE") ||
        ents.has("COMPANY") || ents.has("PERSON") || ents.has("ACCOUNT"),
    };
  }, [fields]);

  // 選択に基づき値を解決（自由入力の手入力は保持）。
  const resolve = useCallback(
    async (sel: DocMergeSelection, curFields: DocField[]) => {
      try {
        const r = await resolveDocMerge(templateId, sel);
        setEffSel(r.selection);
        setEffLabels({
          contract: r.labels.contract,
          company: r.labels.company,
          person: r.labels.person,
          account: r.labels.account,
        });
        setValues((prev) => {
          const next = { ...prev };
          for (const f of curFields) {
            if (f.free_input) continue; // 手入力は温存
            next[f.token] = r.values[f.token] ?? "";
          }
          return next;
        });
      } catch (e: any) {
        setError(e?.message ?? "値の引き当てに失敗しました");
      }
    },
    [templateId]
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const t = await fetchDocTemplate(templateId);
        if (!alive) return;
        setTpl(t);
        if (editId) {
          // 履歴からの再編集：保存済みの値・選択・タイトルを復元
          const g = await fetchGeneratedDoc(editId);
          if (!alive) return;
          setTitle(g.title);
          const inV = g.inputs?.values ?? {};
          const base: Record<string, string> = {};
          for (const f of t.fields) base[f.token] = inV[f.token] ?? "";
          setValues(base);
          const insel = g.inputs?.selection ?? {};
          setManual(insel);
          setEffSel(insel);
          setEffLabels({
            contract: insel.contract_id ? "選択済み" : null,
            company: insel.company_id ? "選択済み" : null,
            person: insel.person_id ? "選択済み" : null,
            account: insel.account_id ? "選択済み" : null,
          });
        } else {
          setTitle(`${t.name}_${new Date().toISOString().slice(0, 10)}`);
          const base: Record<string, string> = {};
          for (const f of t.fields) base[f.token] = "";
          setValues(base);
          // 初期解決（SYSTEM の発行日などを埋める）
          await resolve({}, t.fields);
        }
      } catch (e: any) {
        if (alive) setError(e?.message ?? "テンプレートの読み込みに失敗しました");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, editId]);

  function pick(entity: EntityKey, id: string) {
    const key = `${entity}_id` as keyof DocMergeSelection;
    const nextManual = { ...manual, [key]: id };
    setManual(nextManual);
    resolve(nextManual, fields);
  }

  function clearPick(entity: EntityKey) {
    const key = `${entity}_id` as keyof DocMergeSelection;
    const nextManual = { ...manual, [key]: null };
    setManual(nextManual);
    resolve(nextManual, fields);
  }

  async function onGenerate() {
    setGenerating(true);
    setDoneMsg(null);
    setError(null);
    try {
      const body = { title: title.trim(), values, selection: effSel };
      const r = editId
        ? await regenerateDocument(editId, body)
        : await generateDocument({ template_id: templateId, ...body });
      await downloadGeneratedPdf(r.id, `${r.title}.pdf`);
      setDoneMsg(`「${r.title}」のPDFを作成しました。ダウンロードが始まります。`);
    } catch (e: any) {
      setError(e?.message ?? "PDFの作成に失敗しました");
    } finally {
      setGenerating(false);
    }
  }

  if (loading) {
    return <Spinner label="読み込み中…" style={{ marginTop: 40 }} />;
  }
  if (!tpl) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>{error ?? "テンプレートが見つかりません。"}</MessageBarBody>
      </MessageBar>
    );
  }

  const autoFor = (k: EntityKey) => {
    const key = `${k}_id` as keyof DocMergeSelection;
    return !manual[key] && !!effSel[key];
  };

  return (
    <div>
      <div className={s.header}>
        <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={() => navigate("/doc-templates")}>
          戻る
        </Button>
        <Title3>{editId ? "差し込み文書を編集" : "差し込み印刷（作成）"}</Title3>
      </div>
      <div className={s.crumb}>
        書式「{tpl.name}」に、選んだ会社・契約などのデータを差し込んで PDF を作成します。
      </div>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {doneMsg && (
        <MessageBar intent="success" style={{ marginBottom: 12 }}>
          <MessageBarBody>
            {doneMsg}　
            <Button size="small" appearance="transparent" onClick={() => navigate("/doc-generated")}>
              作成履歴を見る
            </Button>
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.grid}>
        {/* 左：レコード選択 */}
        <div>
          <div className={s.card}>
            <div className={s.cardTitle}>① データを選ぶ</div>
            {!need.anyPick && (
              <Body1 className={s.muted}>
                この書式は自動差し込みの項目がありません。右側の入力欄に直接ご記入ください。
              </Body1>
            )}
            {need.contract && (
              <RecordPicker
                title="契約を選ぶ"
                placeholder="契約番号・概要・会社名で検索"
                selectedLabel={effLabels.contract}
                auto={autoFor("contract")}
                onSearch={async (q) => {
                  const r = await fetchContracts({ q });
                  return r.items.map((c) => ({
                    id: c.id,
                    label: `${c.contract_no}　${c.contract_summary ?? ""}`.trim(),
                    sub: [c.company_name, c.status_label].filter(Boolean).join(" / "),
                  }));
                }}
                onPick={(id) => pick("contract", id)}
                onClear={() => clearPick("contract")}
              />
            )}
            {need.company && (
              <RecordPicker
                title="会社を選ぶ"
                placeholder="会社名で検索"
                selectedLabel={effLabels.company}
                auto={autoFor("company")}
                onSearch={async (q) => {
                  const r = await fetchCompanies({ q });
                  return r.items.map((c) => ({
                    id: c.id,
                    label: c.company_name,
                    sub: [c.prefecture, c.city].filter(Boolean).join(""),
                  }));
                }}
                onPick={(id) => pick("company", id)}
                onClear={() => clearPick("company")}
              />
            )}
            {need.person && (
              <RecordPicker
                title="契約者（個人）を選ぶ"
                placeholder="氏名で検索"
                selectedLabel={effLabels.person}
                auto={autoFor("person")}
                onSearch={async (q) => {
                  const r = await fetchPersons({ q });
                  return r.items.map((p) => ({
                    id: p.id,
                    label: p.full_name,
                    sub: p.full_name_kana ?? "",
                  }));
                }}
                onPick={(id) => pick("person", id)}
                onClear={() => clearPick("person")}
              />
            )}
            {need.account && (
              <RecordPicker
                title="口座・カードを選ぶ"
                placeholder="銀行名・名義カナで検索"
                selectedLabel={effLabels.account}
                auto={autoFor("account")}
                onSearch={async (q) => {
                  const r = await fetchAccounts({ q });
                  return r.items.map((a) => ({
                    id: a.id,
                    label: `${a.bank_name ?? ""} ${a.branch_name ?? ""}`.trim() || "(名称なし)",
                    sub: a.account_no_masked ?? "",
                  }));
                }}
                onPick={(id) => pick("account", id)}
                onClear={() => clearPick("account")}
              />
            )}
            {need.anyPick && (
              <Body1 className={s.hint}>
                契約を選ぶと、その契約に紐づく会社・契約者・口座・金額を自動で引き当てます（右側で修正できます）。
              </Body1>
            )}
          </div>
        </div>

        {/* 右：入力・確認 */}
        <div>
          <div className={s.card}>
            <div className={s.cardTitle}>② 内容を確認・修正する</div>
            <Field label="文書のタイトル（保存名）" style={{ marginBottom: 14 }}>
              <Input value={title} onChange={(_, d) => setTitle(d.value)} />
            </Field>
            {fields.length === 0 && (
              <Body1 className={s.muted}>この書式には差し込み項目がありません。</Body1>
            )}
            {fields.map((f) => {
              const auto = !f.free_input && f.known;
              const long = f.maxlen >= 40 || f.source === "FullAddress";
              const hint = f.free_input
                ? `手で入力（${RESTRICT_HINT[f.restrict] ?? f.restrict}／最大${f.maxlen}文字）`
                : f.known
                ? `自動：${f.link}`
                : "この印は自動データに未対応です。手で入力してください。";
              return (
                <div key={f.token} className={s.fieldRow}>
                  <Field
                    label={
                      <span>
                        {f.label}
                        {auto && (
                          <Badge size="small" appearance="tint" color="brand" className={s.autoTag}>
                            自動
                          </Badge>
                        )}
                        {f.free_input && (
                          <Badge size="small" appearance="tint" color="warning" className={s.autoTag}>
                            手入力
                          </Badge>
                        )}
                      </span>
                    }
                  >
                    {long ? (
                      <Textarea
                        value={values[f.token] ?? ""}
                        onChange={(_, d) => setValues((p) => ({ ...p, [f.token]: d.value }))}
                        rows={2}
                      />
                    ) : (
                      <Input
                        value={values[f.token] ?? ""}
                        onChange={(_, d) => setValues((p) => ({ ...p, [f.token]: d.value }))}
                      />
                    )}
                  </Field>
                  <div className={s.hint}>{hint}</div>
                </div>
              );
            })}
            <div className={s.actions}>
              <Button
                appearance="primary"
                icon={<Print20Regular />}
                onClick={onGenerate}
                disabled={generating || !title.trim()}
              >
                {generating ? "作成中…" : editId ? "この内容で作り直す（PDF）" : "PDFを作成する"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
