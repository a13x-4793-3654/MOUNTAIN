// クレジットカード番号の先頭（BIN/IIN）からブランドを判定する。
// 判定結果は口座・カードフォームの「種別(account_type)」に自動セットする用途。
// 参考：一般的な発行者識別番号（IIN）の割り当て。

export interface CardBrand {
  value: string; // account_type のコード
  label: string; // 表示名
}

export function detectCardBrand(cardNo: string): CardBrand | null {
  const n = (cardNo || "").replace(/\D/g, "");
  if (n.length < 2) return null;

  const p2 = parseInt(n.slice(0, 2), 10);
  const p3 = parseInt(n.slice(0, 3), 10);
  const p4 = parseInt(n.slice(0, 4), 10);

  // Visa: 4 で始まる
  if (n[0] === "4") return { value: "visa", label: "VISA" };

  // American Express: 34, 37
  if (p2 === 34 || p2 === 37) return { value: "amex", label: "American Express" };

  // Diners Club: 36, 38, 300-305, 3095
  if (p2 === 36 || p2 === 38) return { value: "diners", label: "Diners Club" };
  if (n.length >= 3 && ((p3 >= 300 && p3 <= 305) || p3 === 309))
    return { value: "diners", label: "Diners Club" };
  if (n.length >= 4 && p4 === 3095) return { value: "diners", label: "Diners Club" };

  // JCB: 3528-3589
  if (n.length >= 4 && p4 >= 3528 && p4 <= 3589) return { value: "jcb", label: "JCB" };

  // Mastercard: 51-55, または 2221-2720
  if (p2 >= 51 && p2 <= 55) return { value: "master", label: "Mastercard" };
  if (n.length >= 4 && p4 >= 2221 && p4 <= 2720) return { value: "master", label: "Mastercard" };

  return { value: "other", label: "その他" };
}
