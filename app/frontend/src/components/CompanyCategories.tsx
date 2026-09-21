import { CompanyCategory } from "../api/client";

export function companyCategoryLabel(category: CompanyCategory): string {
  return `${category.label || category.code}${category.is_active ? "" : "（無効・未登録）"}`;
}

export default function CompanyCategories({ categories = [] }: { categories?: CompanyCategory[] }) {
  return <span>{categories.length ? categories.map(companyCategoryLabel).join("、") : "未分類"}</span>;
}
