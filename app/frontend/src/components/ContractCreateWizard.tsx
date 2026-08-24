import { useEffect, useMemo, useState } from "react";
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
  Input,
  Dropdown,
  Option,
  Switch,
  Field,
  Spinner,
  MessageBar,
  MessageBarBody,
  Divider,
  Text,
} from "@fluentui/react-components";
import { Checkmark12Filled } from "@fluentui/react-icons";
import { createContract } from "../api/client";

export interface Opt {
  value: string;
  label: string;
}

const COMPANY_LINK_OPTIONS: Opt[] = [
  { value: "debtor", label: "債務者" },
  { value: "creditor", label: "債権者" },
  { value: "guarantor", label: "保証人" },
  { value: "agent", label: "代理店" },
];
const PERSON_LINK_OPTIONS: Opt[] = [
  { value: "contractor", label: "契約者" },
  { value: "joint_guarantor", label: "連帯保証人" },
  { value: "guarantor", label: "保証人" },
  { value: "agent", label: "代理人" },
];
const IDENT_TYPE_OPTIONS: Opt[] = [
  { value: "customer_no", label: "顧客番号" },
  { value: "case_no", label: "案件番号" },
  { value: "policy_no", label: "証券番号" },
  { value: "member_no", label: "会員番号" },
  { value: "legacy_no", label: "旧システム番号" },
  { value: "other", label: "その他" },
];

const STEPS = ["基本情報", "当事者", "外部管理番号", "契約条件・担当", "確認"];

const useStyles = makeStyles({
  surface: { maxWidth: "760px", width: "760px" },
  stepper: {
    display: "flex",
    alignItems: "center",
    marginBottom: "16px",
    flexWrap: "wrap",
    rowGap: "8px",
  },
  stepItem: { display: "flex", alignItems: "center", columnGap: "8px" },
  circle: {
    width: "26px",
    height: "26px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "13px",
    fontWeight: 700,
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  circleActive: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  circleDone: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  stepLabel: { fontSize: "13px", color: tokens.colorNeutralForeground3, whiteSpace: "nowrap" },
  stepLabelActive: { color: tokens.colorNeutralForeground1, fontWeight: 600 },
  connector: {
    flexGrow: 1,
    height: "1px",
    backgroundColor: tokens.colorNeutralStroke2,
    marginLeft: "8px",
    marginRight: "8px",
    minWidth: "12px",
  },
  fields: { display: "grid", rowGap: "12px", paddingTop: "4px" },
  hint: { fontSize: "12px", color: tokens.colorNeutralForeground3 },
  review: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "16px",
    rowGap: "8px",
  },
  reviewKey: { color: tokens.colorNeutralForeground3, fontSize: "13px" },
  reviewVal: { fontSize: "13px" },
  spacer: { flexGrow: 1 },
});

interface WizardValues {
  contract_category: string;
  contract_summary: string;
  company_id: string;
  company_link_category: string;
  person_id: string;
  person_link_category: string;
  identifier_type: string;
  identifier_value: string;
  identifier_is_primary: boolean;
  signed_at: string;
  started_at: string;
  assignee_user_id: string;
}

const INITIAL: WizardValues = {
  contract_category: "",
  contract_summary: "",
  company_id: "",
  company_link_category: "debtor",
  person_id: "",
  person_link_category: "contractor",
  identifier_type: "",
  identifier_value: "",
  identifier_is_primary: false,
  signed_at: "",
  started_at: "",
  assignee_user_id: "",
};

function labelOf(opts: Opt[], val: string, fallback = "（未設定）") {
  if (!val) return fallback;
  return opts.find((o) => o.value === val)?.label ?? val;
}

export default function ContractCreateWizard({
  open,
  onClose,
  onDone,
  categoryOptions,
  companyOptions,
  personOptions,
  userOptions,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (contractId: string) => void;
  categoryOptions: Opt[];
  companyOptions: Opt[];
  personOptions: Opt[];
  userOptions: Opt[];
}) {
  const s = useStyles();
  const [step, setStep] = useState(0);
  const [v, setV] = useState<WizardValues>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep(0);
      setV(INITIAL);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  function set<K extends keyof WizardValues>(k: K, val: WizardValues[K]) {
    setV((prev) => ({ ...prev, [k]: val }));
  }

  function validateStep(i: number): string | null {
    if (i === 0 && !v.contract_category) {
      return "契約区分を選んでください。";
    }
    if (i === 1 && !v.company_id.trim() && !v.person_id.trim()) {
      return "会社または名義を1件以上選んでください。";
    }
    if (i === 2 && v.identifier_value.trim() && !v.identifier_type) {
      return "外部管理番号の種別を選んでください。";
    }
    return null;
  }

  function next() {
    const msg = validateStep(step);
    if (msg) {
      setError(msg);
      return;
    }
    setError(null);
    setStep((x) => Math.min(x + 1, STEPS.length - 1));
  }

  function back() {
    setError(null);
    setStep((x) => Math.max(x - 1, 0));
  }

  async function submit() {
    // 念のため全ステップを再検証
    for (let i = 0; i < STEPS.length - 1; i++) {
      const msg = validateStep(i);
      if (msg) {
        setError(msg);
        setStep(i);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createContract({
        contract_category: v.contract_category,
        contract_summary: v.contract_summary.trim() || null,
        signed_at: v.signed_at.trim() || null,
        started_at: v.started_at.trim() || null,
        assignee_user_id: v.assignee_user_id.trim() || null,
        company_id: v.company_id.trim() || null,
        company_link_category: v.company_link_category || "debtor",
        person_id: v.person_id.trim() || null,
        person_link_category: v.person_link_category || "contractor",
        identifier_type: v.identifier_value.trim()
          ? v.identifier_type || "other"
          : null,
        identifier_value: v.identifier_value.trim() || null,
        identifier_is_primary: v.identifier_is_primary,
      });
      onDone(res.id);
    } catch (e: any) {
      setError(e?.message ?? "登録に失敗しました");
      setBusy(false);
    }
  }

  const summaryText = useMemo(() => {
    if (v.contract_summary.trim()) return v.contract_summary.trim();
    const parts = [
      labelOf(companyOptions, v.company_id, ""),
      labelOf(personOptions, v.person_id, ""),
    ].filter(Boolean);
    return parts.join(" ") || "（会社名・名義から自動作成）";
  }, [v.contract_summary, v.company_id, v.person_id, companyOptions, personOptions]);

  return (
    <Dialog
      open={open}
      onOpenChange={(_, d) => {
        if (!d.open && !busy) onClose();
      }}
    >
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>新規契約の登録</DialogTitle>
          <DialogContent>
            <div className={s.stepper}>
              {STEPS.map((label, i) => (
                <div key={label} className={s.stepItem} style={{ flexGrow: i < STEPS.length - 1 ? 1 : 0 }}>
                  <div
                    className={`${s.circle} ${
                      i === step ? s.circleActive : i < step ? s.circleDone : ""
                    }`}
                  >
                    {i < step ? <Checkmark12Filled /> : i + 1}
                  </div>
                  <span className={`${s.stepLabel} ${i === step ? s.stepLabelActive : ""}`}>
                    {label}
                  </span>
                  {i < STEPS.length - 1 && <span className={s.connector} />}
                </div>
              ))}
            </div>

            {error && (
              <MessageBar intent="error" style={{ marginBottom: 12 }}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}

            {step === 0 && (
              <div className={s.fields}>
                <Field label="契約区分" required>
                  <Dropdown
                    placeholder="区分を選択してください"
                    value={labelOf(categoryOptions, v.contract_category, "")}
                    selectedOptions={[v.contract_category]}
                    onOptionSelect={(_, d) => set("contract_category", d.optionValue ?? "")}
                  >
                    {categoryOptions.map((o) => (
                      <Option key={o.value} value={o.value}>
                        {o.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="概要" hint="空欄の場合は会社名・名義から自動作成します">
                  <Input
                    value={v.contract_summary}
                    onChange={(_, d) => set("contract_summary", d.value)}
                    placeholder="例）○○ローン 延滞債権"
                  />
                </Field>
              </div>
            )}

            {step === 1 && (
              <div className={s.fields}>
                <div className={s.hint}>会社または名義を1件以上選んでください。</div>
                <Field label="会社">
                  <Dropdown
                    placeholder="（会社を選択しない）"
                    value={labelOf(companyOptions, v.company_id, "")}
                    selectedOptions={[v.company_id]}
                    onOptionSelect={(_, d) => set("company_id", d.optionValue ?? "")}
                  >
                    {companyOptions.map((o) => (
                      <Option key={o.value || "none"} value={o.value}>
                        {o.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="会社の区分">
                  <Dropdown
                    value={labelOf(COMPANY_LINK_OPTIONS, v.company_link_category, "債務者")}
                    selectedOptions={[v.company_link_category]}
                    onOptionSelect={(_, d) => set("company_link_category", d.optionValue ?? "debtor")}
                  >
                    {COMPANY_LINK_OPTIONS.map((o) => (
                      <Option key={o.value} value={o.value}>
                        {o.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="名義（個人）">
                  <Dropdown
                    placeholder="（名義を選択しない）"
                    value={labelOf(personOptions, v.person_id, "")}
                    selectedOptions={[v.person_id]}
                    onOptionSelect={(_, d) => set("person_id", d.optionValue ?? "")}
                  >
                    {personOptions.map((o) => (
                      <Option key={o.value || "none"} value={o.value}>
                        {o.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="名義の区分">
                  <Dropdown
                    value={labelOf(PERSON_LINK_OPTIONS, v.person_link_category, "契約者")}
                    selectedOptions={[v.person_link_category]}
                    onOptionSelect={(_, d) => set("person_link_category", d.optionValue ?? "contractor")}
                  >
                    {PERSON_LINK_OPTIONS.map((o) => (
                      <Option key={o.value} value={o.value}>
                        {o.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
            )}

            {step === 2 && (
              <div className={s.fields}>
                <div className={s.hint}>
                  他システムの管理番号・証券番号など、この契約に紐づく外部の番号があれば入力します。
                  なければ空欄のまま「次へ」で構いません。
                </div>
                <Field label="種別">
                  <Dropdown
                    placeholder="種別を選択してください"
                    value={labelOf(IDENT_TYPE_OPTIONS, v.identifier_type, "")}
                    selectedOptions={[v.identifier_type]}
                    onOptionSelect={(_, d) => set("identifier_type", d.optionValue ?? "")}
                  >
                    {IDENT_TYPE_OPTIONS.map((o) => (
                      <Option key={o.value} value={o.value}>
                        {o.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="外部管理番号">
                  <Input
                    value={v.identifier_value}
                    onChange={(_, d) => set("identifier_value", d.value)}
                    placeholder="例）A-123456"
                  />
                </Field>
                <Field label="主番号にする" hint="複数の番号がある場合、代表として使う番号に設定します">
                  <Switch
                    checked={v.identifier_is_primary}
                    onChange={(_, d) => set("identifier_is_primary", d.checked)}
                  />
                </Field>
              </div>
            )}

            {step === 3 && (
              <div className={s.fields}>
                <Field label="契約日">
                  <Input
                    type="date"
                    value={v.signed_at}
                    onChange={(_, d) => set("signed_at", d.value)}
                  />
                </Field>
                <Field label="取引開始日">
                  <Input
                    type="date"
                    value={v.started_at}
                    onChange={(_, d) => set("started_at", d.value)}
                  />
                </Field>
                <Field label="社内担当">
                  <Dropdown
                    placeholder="（未定）"
                    value={labelOf(userOptions, v.assignee_user_id, "")}
                    selectedOptions={[v.assignee_user_id]}
                    onOptionSelect={(_, d) => set("assignee_user_id", d.optionValue ?? "")}
                  >
                    {userOptions.map((o) => (
                      <Option key={o.value || "none"} value={o.value}>
                        {o.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
            )}

            {step === 4 && (
              <div>
                <Text weight="semibold">入力内容の確認</Text>
                <Divider style={{ marginTop: 8, marginBottom: 12 }} />
                <div className={s.review}>
                  <span className={s.reviewKey}>契約区分</span>
                  <span className={s.reviewVal}>{labelOf(categoryOptions, v.contract_category)}</span>
                  <span className={s.reviewKey}>概要</span>
                  <span className={s.reviewVal}>{summaryText}</span>
                  <span className={s.reviewKey}>会社</span>
                  <span className={s.reviewVal}>
                    {labelOf(companyOptions, v.company_id, "（なし）")}
                    {v.company_id ? `（${labelOf(COMPANY_LINK_OPTIONS, v.company_link_category)}）` : ""}
                  </span>
                  <span className={s.reviewKey}>名義</span>
                  <span className={s.reviewVal}>
                    {labelOf(personOptions, v.person_id, "（なし）")}
                    {v.person_id ? `（${labelOf(PERSON_LINK_OPTIONS, v.person_link_category)}）` : ""}
                  </span>
                  <span className={s.reviewKey}>外部管理番号</span>
                  <span className={s.reviewVal}>
                    {v.identifier_value.trim()
                      ? `${v.identifier_value.trim()}（${labelOf(IDENT_TYPE_OPTIONS, v.identifier_type, "その他")}${
                          v.identifier_is_primary ? "・主番号" : ""
                        }）`
                      : "（なし）"}
                  </span>
                  <span className={s.reviewKey}>契約日</span>
                  <span className={s.reviewVal}>{v.signed_at || "（未設定）"}</span>
                  <span className={s.reviewKey}>取引開始日</span>
                  <span className={s.reviewVal}>{v.started_at || "（未設定）"}</span>
                  <span className={s.reviewKey}>社内担当</span>
                  <span className={s.reviewVal}>{labelOf(userOptions, v.assignee_user_id, "（未定）")}</span>
                </div>
                <div className={s.hint} style={{ marginTop: 12 }}>
                  「登録する」を押すと審査待ちの状態で登録されます。
                </div>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>
              キャンセル
            </Button>
            <div className={s.spacer} />
            {step > 0 && (
              <Button appearance="secondary" onClick={back} disabled={busy}>
                戻る
              </Button>
            )}
            {step < STEPS.length - 1 ? (
              <Button appearance="primary" onClick={next}>
                次へ
              </Button>
            ) : (
              <Button appearance="primary" onClick={submit} disabled={busy}>
                {busy ? <Spinner size="tiny" /> : "登録する（審査待ちへ）"}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
