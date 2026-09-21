import { useEffect, useState } from "react";
import { Button, MessageBar, MessageBarBody, Spinner } from "@fluentui/react-components";
import { CompanyDetail, CompanyIn, fetchMaster, MasterItem } from "../api/client";
import { COMPANY_FIELDS, companyToForm, toCompanyIn } from "../util/formSchemas";
import FormDialog from "./FormDialog";
import { companyCategoryLabel } from "./CompanyCategories";

interface Props {
  open: boolean;
  company?: CompanyDetail["company"];
  onSubmit: (body: CompanyIn) => Promise<void>;
  onClose: () => void;
}

type MasterState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: MasterItem[] };

export default function CompanyFormDialog({ open, company, onSubmit, onClose }: Props) {
  const [masters, setMasters] = useState<MasterState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setMasters({ status: "loading" });
    if (!open) return;
    let current = true;
    fetchMaster("company_category")
      .then((items) => {
        if (current) setMasters({ status: "ready", items });
      })
      .catch((error: unknown) => {
        if (current) setMasters({
          status: "error",
          message: error instanceof Error ? error.message : "読み込みに失敗しました",
        });
      });
    return () => { current = false; };
  }, [open, attempt, company?.id]);

  const active = masters.status === "ready" ? masters.items : [];
  const existing = company?.categories ?? [];
  const options = [
    ...active.map((item) => ({ value: item.code, label: item.label })),
    ...existing.filter((item) => !active.some((master) => master.code === item.code))
      .map((item) => ({
        value: item.code,
        label: masters.status === "ready"
          ? companyCategoryLabel({ ...item, is_active: false })
          : companyCategoryLabel(item),
      })),
  ];
  const fields = COMPANY_FIELDS.filter((field) => !company || field.key !== "phone")
    .map((field) => field.key === "category_codes"
      ? { ...field, options, disabled: masters.status !== "ready" }
      : field);

  return (
    <FormDialog
      open={open}
      title={company ? "会社情報の編集" : "会社の新規登録"}
      fields={fields}
      initial={company ? companyToForm(company, null) : { status_flag: "0", category_codes: [] }}
      submitLabel={company ? "保存" : "登録"}
      submitDisabled={masters.status !== "ready"}
      contentBefore={
        <div style={{ marginBottom: 12 }}>
          {masters.status === "loading" && <Spinner size="tiny" label="会社分類を読み込み中…" />}
          {masters.status === "error" && (
            <MessageBar intent="error">
              <MessageBarBody>
                会社分類を読み込めませんでした。分類を保護するため、再試行が成功するまで保存できません。
                <div>{masters.message}</div>
                <Button size="small" onClick={() => {
                  setMasters({ status: "loading" });
                  setAttempt((value) => value + 1);
                }}>再試行</Button>
              </MessageBarBody>
            </MessageBar>
          )}
          {masters.status === "ready" && existing.some((item) => !active.some((master) => master.code === item.code)) && (
            <MessageBar intent="info">
              <MessageBarBody>
                無効・未登録の分類は、この会社に設定済みのものだけ保持・解除できます。他の会社への新規設定はできません。
              </MessageBarBody>
            </MessageBar>
          )}
        </div>
      }
      onSubmit={async (values) => {
        if (masters.status !== "ready") throw new Error("会社分類の読み込み完了後に保存してください");
        await onSubmit(toCompanyIn(values));
      }}
      onClose={onClose}
    />
  );
}
