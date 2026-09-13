import { fetchAccounts, fetchCompanies, fetchPersons } from "../api/client";
import { accountCategoryLabel, accountTypeLabel, boolLabel, fmtDate } from "../util/format";
import type { RecordSearchConfig } from "./RecordLinkDialog";

export type ContractRecordKind = "company" | "person" | "account";

function location(item: { prefecture: string | null; city: string | null }): string {
  return [item.prefecture, item.city].filter(Boolean).join(" ") || "—";
}

export const contractRecordSearch: Record<ContractRecordKind, RecordSearchConfig> = {
  company: {
    title: "会社を紐付け",
    searchHint: "会社名・カナ・市区町村で検索",
    roleLabel: "この契約での立場",
    columns: ["会社名", "カナ", "所在地", "電話"],
    search: async (params) => {
      const result = await fetchCompanies(params);
      return {
        total: result.total,
        items: result.items.map((item) => ({
          id: item.id,
          label: item.company_name,
          cells: [item.company_name, item.company_name_kana || "—", location(item), item.phone || "—"],
        })),
      };
    },
  },
  person: {
    title: "名義を紐付け",
    searchHint: "氏名・カナ・市区町村で検索",
    roleLabel: "この契約での立場",
    columns: ["氏名", "カナ", "生年月日", "所在地"],
    search: async (params) => {
      const result = await fetchPersons(params);
      return {
        total: result.total,
        items: result.items.map((item) => ({
          id: item.id,
          label: item.full_name,
          cells: [item.full_name, item.full_name_kana || "—", fmtDate(item.birth_date), location(item)],
        })),
      };
    },
  },
  account: {
    title: "口座・カードを紐付け",
    searchHint: "銀行名・支店名・名義カナで検索",
    roleLabel: "紐づけ種別",
    allowDefault: true,
    columns: ["区分・種別", "銀行", "支店", "名義（カナ）", "番号（マスク）", "有効"],
    search: async (params) => {
      const result = await fetchAccounts(params);
      return {
        total: result.total,
        items: result.items.map((item) => ({
          id: item.id,
          label: [accountCategoryLabel(item.account_category), item.account_holder_kana, item.account_no_masked]
            .filter(Boolean).join(" ／ "),
          cells: [
            `${accountCategoryLabel(item.account_category)}・${accountTypeLabel(item.account_type)}`,
            item.bank_name || "—",
            item.account_category === "credit" ? "—" : item.branch_name || "—",
            item.account_holder_kana || "—",
            item.account_no_masked || "—",
            boolLabel(item.is_active),
          ],
        })),
      };
    },
  },
};
