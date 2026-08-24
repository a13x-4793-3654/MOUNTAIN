import { FormField, FormValues } from "../components/FormDialog";
import { CompanyIn, PersonIn, AccountIn } from "../api/client";

const str = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

// ===== 会社 =====
export const COMPANY_FIELDS: FormField[] = [
  {
    key: "corporate_number",
    label: "法人番号",
    placeholder: "13桁（例）1234567890123",
    hint: "法人番号を入れて「企業情報を取得」を押すと、会社名・住所を自動入力します",
    assist: "corporate",
  },
  { key: "company_name", label: "会社名", required: true, placeholder: "例）株式会社アルパイン商事" },
  { key: "company_name_kana", label: "会社名（カナ）", placeholder: "カブシキガイシャアルパインショウジ" },
  { key: "phone", label: "電話番号（代表）", placeholder: "03-1234-5678" },
  {
    key: "postal_code",
    label: "郵便番号",
    placeholder: "1000001（ハイフンなし）",
    hint: "郵便番号を入れて「住所を検索」を押すと、住所を自動入力します",
    assist: "postal",
  },
  { key: "prefecture", label: "都道府県", placeholder: "東京都" },
  { key: "city", label: "市区町村", placeholder: "千代田区" },
  { key: "address1", label: "住所1", placeholder: "丸の内1-1-1" },
  { key: "address2", label: "住所2（建物名など）" },
  {
    key: "status_flag",
    label: "取引状態",
    type: "select",
    options: [
      { value: "0", label: "通常" },
      { value: "1", label: "注意" },
      { value: "2", label: "取引停止" },
    ],
  },
  { key: "status_reason", label: "状態理由", type: "textarea", hint: "「注意」「取引停止」の場合に理由を記入" },
];

export function toCompanyIn(v: FormValues): CompanyIn {
  return {
    company_name: String(v.company_name ?? "").trim(),
    company_name_kana: str(v.company_name_kana),
    corporate_number: str(v.corporate_number),
    phone: str(v.phone),
    postal_code: str(v.postal_code),
    prefecture: str(v.prefecture),
    city: str(v.city),
    address1: str(v.address1),
    address2: str(v.address2),
    status_flag: Number(v.status_flag ?? 0) || 0,
    status_reason: str(v.status_reason),
  };
}

export function companyToForm(
  co: Record<string, any>,
  phone: string | null
): FormValues {
  return {
    company_name: co.company_name ?? "",
    company_name_kana: co.company_name_kana ?? "",
    corporate_number: co.corporate_number ?? "",
    phone: phone ?? "",
    postal_code: co.postal_code ?? "",
    prefecture: co.prefecture ?? "",
    city: co.city ?? "",
    address1: co.address1 ?? "",
    address2: co.address2 ?? "",
    status_flag: String(co.status_flag ?? 0),
    status_reason: co.status_reason ?? "",
  };
}

// ===== 名義 =====
export const PERSON_FIELDS: FormField[] = [
  { key: "full_name", label: "氏名", required: true, placeholder: "山田 太郎" },
  { key: "full_name_kana", label: "氏名（カナ）", placeholder: "ヤマダ タロウ" },
  { key: "birth_date", label: "生年月日", type: "date" },
  {
    key: "postal_code",
    label: "郵便番号",
    placeholder: "1000001（ハイフンなし）",
    hint: "郵便番号を入れて「住所を検索」を押すと、住所を自動入力します",
    assist: "postal",
  },
  { key: "prefecture", label: "都道府県" },
  { key: "city", label: "市区町村" },
  { key: "address1", label: "住所1" },
  { key: "address2", label: "住所2（建物名など）" },
];

export function toPersonIn(v: FormValues): PersonIn {
  return {
    full_name: String(v.full_name ?? "").trim(),
    full_name_kana: str(v.full_name_kana),
    birth_date: str(v.birth_date),
    postal_code: str(v.postal_code),
    prefecture: str(v.prefecture),
    city: str(v.city),
    address1: str(v.address1),
    address2: str(v.address2),
  };
}

export function personToForm(pe: Record<string, any>): FormValues {
  return {
    full_name: pe.full_name ?? "",
    full_name_kana: pe.full_name_kana ?? "",
    birth_date: pe.birth_date ?? "",
    postal_code: pe.postal_code ?? "",
    prefecture: pe.prefecture ?? "",
    city: pe.city ?? "",
    address1: pe.address1 ?? "",
    address2: pe.address2 ?? "",
  };
}

// ===== 口座・カード =====
export const ACCOUNT_FIELDS: FormField[] = [
  {
    key: "account_category",
    label: "区分",
    type: "select",
    required: true,
    options: [
      { value: "bank", label: "銀行口座" },
      { value: "credit", label: "クレジットカード" },
    ],
  },
  {
    key: "account_role",
    label: "名義区分",
    type: "select",
    options: [
      { value: "self", label: "本人" },
      { value: "other", label: "他人" },
    ],
  },
  {
    key: "account_type",
    label: "種別",
    type: "select",
    required: true,
    // 区分に応じてラベルと選択肢を切り替える（銀行→口座種別／クレジット→ブランド）
    labelWhen: {
      field: "account_category",
      labels: { bank: "口座種別", credit: "ブランド" },
    },
    optionsWhen: {
      field: "account_category",
      options: {
        bank: [
          { value: "ordinary", label: "普通預金" },
          { value: "current", label: "当座預金" },
          { value: "savings", label: "貯蓄預金" },
        ],
        credit: [
          { value: "visa", label: "VISA" },
          { value: "master", label: "Mastercard" },
          { value: "jcb", label: "JCB" },
          { value: "amex", label: "American Express" },
          { value: "diners", label: "Diners Club" },
          { value: "other", label: "その他" },
        ],
      },
    },
  },
  {
    key: "bank_name",
    label: "銀行名",
    placeholder: "みずほ銀行",
    showWhen: { field: "account_category", in: ["bank"] },
  },
  {
    key: "branch_name",
    label: "支店",
    placeholder: "新宿支店",
    showWhen: { field: "account_category", in: ["bank"] },
  },
  {
    key: "bank_code",
    label: "銀行コード",
    placeholder: "0001（任意）",
    hint: "「銀行・支店を検索」で銀行名・支店名からコードを自動入力できます",
    assist: "bank",
    showWhen: { field: "account_category", in: ["bank"] },
  },
  {
    key: "branch_code",
    label: "支店コード",
    placeholder: "001（任意）",
    showWhen: { field: "account_category", in: ["bank"] },
  },
  {
    key: "account_no",
    label: "口座番号・カード番号",
    // 区分に応じてラベルを切り替える
    labelWhen: {
      field: "account_category",
      labels: { bank: "口座番号", credit: "カード番号" },
    },
    placeholder: "数字のみ（編集時は変更する場合だけ入力）",
    hint: "クレジットカードの場合、番号の先頭からブランド（種別）を自動判定します",
    assist: "cardBrand",
  },
  { key: "account_holder_kana", label: "名義（カナ）", placeholder: "ヤマダ タロウ" },
  {
    key: "expiry_mm_yy",
    label: "有効期限（MM/YY）",
    placeholder: "03/28",
    showWhen: { field: "account_category", in: ["credit"] },
  },
  { key: "is_active", label: "有効", type: "switch" },
];

export function toAccountIn(v: FormValues): AccountIn {
  return {
    account_category: String(v.account_category ?? "bank") || "bank",
    account_role: String(v.account_role ?? "self") || "self",
    account_type: String(v.account_type ?? "").trim() || "ordinary",
    bank_name: str(v.bank_name),
    branch_name: str(v.branch_name),
    bank_code: str(v.bank_code),
    branch_code: str(v.branch_code),
    account_no: str(v.account_no),
    account_holder_kana: str(v.account_holder_kana),
    expiry_mm_yy: str(v.expiry_mm_yy),
    incident_code: "00",
    is_active: v.is_active !== false,
  };
}

export function accountToForm(a: Record<string, any>): FormValues {
  return {
    account_category: a.account_category ?? "bank",
    account_role: a.account_role ?? "self",
    account_type: a.account_type ?? "",
    bank_name: a.bank_name ?? "",
    branch_name: a.branch_name ?? "",
    bank_code: a.bank_code ?? "",
    branch_code: a.branch_code ?? "",
    account_no: "",
    account_holder_kana: a.account_holder_kana ?? "",
    expiry_mm_yy: a.expiry_mm_yy ?? "",
    is_active: a.is_active !== false,
  };
}
