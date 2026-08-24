import { useEffect, useState } from "react";
import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Input,
  Textarea,
  Dropdown,
  Option,
  Switch,
  Field,
  Spinner,
  MessageBar,
  MessageBarBody,
  Text,
} from "@fluentui/react-components";
import { lookupPostal, lookupCorporate } from "../api/client";
import { detectCardBrand } from "../util/cards";
import BankLookupDialog, { BankSelection } from "./BankLookupDialog";

export type FieldType = "text" | "textarea" | "date" | "number" | "select" | "multiselect" | "switch";

// 入力補助の種類。
//  postal    : 郵便番号 → 都道府県・市区町村・住所1 を自動入力
//  corporate : 法人番号 → 会社名・カナ・住所 を自動入力
//  bank      : 銀行・支店を検索して 銀行/支店コード・名称 を自動入力（逆引き）
//  cardBrand : カード番号の先頭から ブランド(種別) を自動判定
export type AssistKind = "postal" | "corporate" | "bank" | "cardBrand";

export interface SelectOption {
  value: string;
  label: string;
}

export interface FormField {
  key: string;
  label: string;
  type?: FieldType;
  options?: SelectOption[];
  required?: boolean;
  placeholder?: string;
  hint?: string;
  assist?: AssistKind;
  // 別の項目の値に応じて、この項目を出し分ける（例：区分＝銀行のときだけ銀行名を表示）
  showWhen?: { field: string; in: string[] };
  // 別の項目の値に応じて、選択肢を切り替える（例：区分＝銀行→口座種別／クレジット→ブランド）
  optionsWhen?: { field: string; options: Record<string, SelectOption[]> };
  // 別の項目の値に応じて、ラベルを切り替える（例：口座番号／カード番号）
  labelWhen?: { field: string; labels: Record<string, string> };
}

// showWhen 条件を満たすか（条件が無ければ常に表示）
export function fieldVisible(f: FormField, values: FormValues): boolean {
  if (!f.showWhen) return true;
  return f.showWhen.in.includes(String(values[f.showWhen.field] ?? ""));
}

// optionsWhen / labelWhen を今の入力値で解決した項目を返す
export function resolveField(f: FormField, values: FormValues): FormField {
  let label = f.label;
  let options = f.options;
  if (f.labelWhen) {
    const key = String(values[f.labelWhen.field] ?? "");
    label = f.labelWhen.labels[key] ?? f.label;
  }
  if (f.optionsWhen) {
    const key = String(values[f.optionsWhen.field] ?? "");
    options = f.optionsWhen.options[key] ?? [];
  }
  return { ...f, label, options };
}

export type FormValue = string | number | boolean | null;
export type FormValues = Record<string, FormValue>;

function renderInput(
  f: FormField,
  values: FormValues,
  set: (k: string, v: FormValue) => void
) {
  const val = values[f.key];
  if (f.type === "textarea") {
    return (
      <Textarea
        value={String(val ?? "")}
        onChange={(_, d) => set(f.key, d.value)}
        placeholder={f.placeholder}
      />
    );
  }
  if (f.type === "select") {
    const opts = f.options ?? [];
    const selected = String(val ?? "");
    const selLabel = opts.find((o) => o.value === selected)?.label ?? "";
    return (
      <Dropdown
        placeholder={f.placeholder ?? "選択してください"}
        value={selLabel}
        selectedOptions={[selected]}
        onOptionSelect={(_, d) => set(f.key, d.optionValue ?? "")}
      >
        {opts.map((o) => (
          <Option key={o.value} value={o.value}>
            {o.label}
          </Option>
        ))}
      </Dropdown>
    );
  }
  if (f.type === "multiselect") {
    const opts = f.options ?? [];
    const selected = String(val ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const selLabel = selected
      .map((v0) => opts.find((o) => o.value === v0)?.label ?? v0)
      .join("、");
    return (
      <Dropdown
        multiselect
        placeholder={f.placeholder ?? "選択してください（複数選べます）"}
        value={selLabel}
        selectedOptions={selected}
        onOptionSelect={(_, d) => set(f.key, (d.selectedOptions ?? []).join(","))}
      >
        {opts.map((o) => (
          <Option key={o.value} value={o.value}>
            {o.label}
          </Option>
        ))}
      </Dropdown>
    );
  }
  if (f.type === "switch") {
    return (
      <Switch
        checked={Boolean(val)}
        onChange={(_, d) => set(f.key, d.checked)}
      />
    );
  }
  if (f.type === "date") {
    return (
      <Input
        type="date"
        value={String(val ?? "")}
        onChange={(_, d) => set(f.key, d.value)}
      />
    );
  }
  if (f.type === "number") {
    return (
      <Input
        type="number"
        value={String(val ?? "")}
        onChange={(_, d) => set(f.key, d.value)}
        placeholder={f.placeholder}
      />
    );
  }
  return (
    <Input
      value={String(val ?? "")}
      onChange={(_, d) => set(f.key, d.value)}
      placeholder={f.placeholder}
    />
  );
}

// ---- 郵便番号 → 住所 ----
function PostalAssist({ value, onFill }: { value: string; onFill: (p: FormValues) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await lookupPostal(value);
      if (!r.found || r.candidates.length === 0) {
        setMsg("住所が見つかりませんでした");
        return;
      }
      const c = r.candidates[0];
      onFill({
        postal_code: c.postal_code,
        prefecture: c.prefecture,
        city: c.city,
        address1: c.town,
      });
      setMsg(
        r.candidates.length > 1
          ? `${r.candidates.length}件の候補から先頭を入力しました`
          : "住所を入力しました"
      );
    } catch (e: any) {
      setMsg(e?.message ?? "住所検索に失敗しました");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AssistSlot msg={msg}>
      <Button size="small" onClick={run} disabled={busy || !value.trim()}>
        {busy ? <Spinner size="tiny" /> : "住所を検索"}
      </Button>
    </AssistSlot>
  );
}

// ---- 法人番号 → 企業情報 ----
function CorporateAssist({ value, onFill }: { value: string; onFill: (p: FormValues) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await lookupCorporate(value);
      if (!r.found) {
        setMsg("企業情報が見つかりませんでした");
        return;
      }
      const patch: FormValues = { company_name: r.name ?? "" };
      if (r.kana) patch.company_name_kana = r.kana;
      if (r.postal_code) patch.postal_code = r.postal_code;
      if (r.prefecture) patch.prefecture = r.prefecture;
      if (r.city) patch.city = r.city;
      if (r.street_number) patch.address1 = r.street_number;
      onFill(patch);
      setMsg("企業情報を入力しました");
    } catch (e: any) {
      setMsg(e?.message ?? "法人番号検索に失敗しました");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AssistSlot msg={msg}>
      <Button size="small" onClick={run} disabled={busy || !value.trim()}>
        {busy ? <Spinner size="tiny" /> : "企業情報を取得"}
      </Button>
    </AssistSlot>
  );
}

// ---- 銀行・支店 検索 ----
function BankAssist({ onFill }: { onFill: (p: FormValues) => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  function onSelect(sel: BankSelection) {
    const patch: FormValues = { bank_code: sel.bank_code, bank_name: sel.bank_name };
    if (sel.branch_code) patch.branch_code = sel.branch_code;
    if (sel.branch_name) patch.branch_name = sel.branch_name;
    onFill(patch);
    setMsg("銀行・支店を入力しました");
  }
  return (
    <AssistSlot msg={msg}>
      <Button size="small" onClick={() => setOpen(true)}>
        銀行・支店を検索
      </Button>
      <BankLookupDialog open={open} onSelect={onSelect} onClose={() => setOpen(false)} />
    </AssistSlot>
  );
}

function AssistSlot({ msg, children }: { msg: string | null; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 2,
        flexShrink: 0,
      }}
    >
      {children}
      {msg && (
        <Text size={100} style={{ color: "#666", whiteSpace: "nowrap" }}>
          {msg}
        </Text>
      )}
    </div>
  );
}

export default function FormDialog({
  open,
  title,
  fields,
  initial,
  submitLabel = "保存",
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  fields: FormField[];
  initial?: FormValues;
  submitLabel?: string;
  onSubmit: (values: FormValues) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<FormValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const base: FormValues = {};
      for (const f of fields) {
        const v = initial?.[f.key];
        base[f.key] = v ?? (f.type === "switch" ? true : "");
      }
      setValues(base);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function set(k: string, v: FormValue) {
    setValues((prev) => ({ ...prev, [k]: v }));
  }

  function setMany(patch: FormValues) {
    setValues((prev) => ({ ...prev, ...patch }));
  }

  // カード番号の先頭からブランド(種別)を自動判定して account_type に反映。
  const cardField = fields.find((f) => f.assist === "cardBrand");
  const cardNo = cardField ? String(values[cardField.key] ?? "") : "";
  const category = String(values.account_category ?? "");
  useEffect(() => {
    if (!cardField) return;
    if (category !== "credit") return;
    const brand = detectCardBrand(cardNo);
    if (brand && brand.value !== "other" && values.account_type !== brand.value) {
      set("account_type", brand.value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardNo, category]);

  // 区分（銀行／クレジット）を切り替えたとき、種別を新しい区分の選択肢に合わせて直す。
  // 有効な値の一覧は account_type 項目の optionsWhen から取得（ハードコードしない）。
  const typeField = fields.find((f) => f.key === "account_type" && f.optionsWhen);
  useEffect(() => {
    if (!typeField?.optionsWhen) return;
    const valid = (typeField.optionsWhen.options[category] ?? []).map((o) => o.value);
    if (valid.length > 0 && !valid.includes(String(values.account_type ?? ""))) {
      set("account_type", valid[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  async function submit() {
    const visible = fields.filter((f) => fieldVisible(f, values));
    for (const f of visible) {
      if (f.required && !String(values[f.key] ?? "").trim()) {
        setError(`「${resolveField(f, values).label}」を入力してください`);
        return;
      }
    }
    // 非表示の項目は保存しない（区分を切り替えた際の入力残りを持ち越さない）
    const cleaned: FormValues = { ...values };
    for (const f of fields) {
      if (!fieldVisible(f, values) && f.type !== "switch") cleaned[f.key] = "";
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(cleaned);
      onClose();
    } catch (e: any) {
      setError(e?.message ?? "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(_, d) => {
        if (!d.open && !busy) onClose();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            {error && (
              <MessageBar intent="error" style={{ marginBottom: 12 }}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            <div style={{ display: "grid", rowGap: 12, paddingTop: 4 }}>
              {fields.filter((f0) => fieldVisible(f0, values)).map((f0) => {
                const f = resolveField(f0, values);
                const hasButton =
                  f.assist === "postal" || f.assist === "corporate" || f.assist === "bank";
                const cardHint =
                  f.assist === "cardBrand" &&
                  category === "credit" &&
                  detectCardBrand(String(values[f.key] ?? ""));
                return (
                  <Field key={f.key} label={f.label} required={f.required} hint={f.hint}>
                    {hasButton ? (
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>{renderInput(f, values, set)}</div>
                        {f.assist === "postal" && (
                          <PostalAssist value={String(values[f.key] ?? "")} onFill={setMany} />
                        )}
                        {f.assist === "corporate" && (
                          <CorporateAssist value={String(values[f.key] ?? "")} onFill={setMany} />
                        )}
                        {f.assist === "bank" && <BankAssist onFill={setMany} />}
                      </div>
                    ) : (
                      <>
                        {renderInput(f, values, set)}
                        {cardHint && (
                          <Text size={100} style={{ color: "#666", marginTop: 2 }}>
                            自動判定：{cardHint.label}
                          </Text>
                        )}
                      </>
                    )}
                  </Field>
                );
              })}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>
              キャンセル
            </Button>
            <Button appearance="primary" onClick={submit} disabled={busy}>
              {busy ? <Spinner size="tiny" /> : submitLabel}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
