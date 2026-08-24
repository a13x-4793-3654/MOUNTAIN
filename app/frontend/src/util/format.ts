import type { BadgeProps } from "@fluentui/react-components";

export function statusAppearance(code: string | null): BadgeProps["color"] {
  switch (code) {
    case "active":
      return "success";
    case "delinquent":
      return "warning";
    case "litigation":
      return "danger";
    case "closed":
      return "informative";
    default:
      return "subtle";
  }
}

export function reviewAppearance(code: string | null): BadgeProps["color"] {
  switch (code) {
    case "approved":
      return "success";
    case "pending":
      return "warning";
    case "rejected":
      return "danger";
    default:
      return "subtle";
  }
}

export function claimAppearance(code: string | null | undefined): BadgeProps["color"] {
  switch (code) {
    case "paid":
      return "success";
    case "open":
      return "warning";
    case "delinquent":
      return "danger";
    default:
      return "subtle";
  }
}

export function allocAppearance(label: string | null | undefined): BadgeProps["color"] {
  switch (label) {
    case "消込済":
      return "success";
    case "一部充当":
      return "warning";
    case "預り金":
      return "brand";
    case "返金":
      return "danger";
    default:
      return "subtle";
  }
}

export function claimStatusLabel(code: string | null | undefined): string {
  switch (code) {
    case "paid":
      return "入金済";
    case "open":
      return "未入金";
    case "delinquent":
      return "延滞";
    case "partial":
      return "一部入金";
    case "canceled":
      return "取消";
    default:
      return code ?? "—";
  }
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  return String(d).slice(0, 10);
}

export function boolLabel(v: unknown): string {
  return v ? "あり" : "なし";
}

export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d).slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}/${p(dt.getMonth() + 1)}/${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

export function fmtYen(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (isNaN(n)) return "—";
  return "¥" + n.toLocaleString("ja-JP");
}

export function fmtFileSize(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function directionLabel(d: string | null | undefined): string {
  if (d === "in") return "受信";
  if (d === "out") return "発信";
  return d ?? "—";
}

export function companyStatusLabel(v: number | null | undefined): string {
  switch (v) {
    case 0:
      return "通常";
    case 1:
      return "注意";
    case 2:
      return "取引停止";
    default:
      return "—";
  }
}

export function companyStatusAppearance(
  v: number | null | undefined,
): BadgeProps["color"] {
  switch (v) {
    case 0:
      return "success";
    case 1:
      return "warning";
    case 2:
      return "danger";
    default:
      return "subtle";
  }
}

export function accountCategoryLabel(v: string | null | undefined): string {
  if (v === "bank") return "銀行口座";
  if (v === "credit") return "クレジットカード";
  return v ?? "—";
}

export function accountTypeLabel(v: string | null | undefined): string {
  switch (v) {
    case "ordinary":
      return "普通預金";
    case "current":
      return "当座預金";
    case "savings":
      return "貯蓄預金";
    case "visa":
      return "VISA";
    case "master":
      return "Mastercard";
    case "jcb":
      return "JCB";
    case "amex":
      return "American Express";
    case "diners":
      return "Diners Club";
    default:
      return v ?? "—";
  }
}

export function phoneTypeLabel(v: string | null | undefined): string {
  switch (v) {
    case "main":
      return "代表";
    case "fax":
      return "FAX";
    case "mobile":
      return "携帯";
    case "direct":
      return "直通";
    case "other":
      return "その他";
    default:
      return v ?? "—";
  }
}

export function callDirectionLabel(d: string | null | undefined): string {
  if (d === "in") return "着信";
  if (d === "out") return "発信";
  return d ?? "—";
}

export function callResultLabel(v: string | null | undefined): string {
  switch (v) {
    case "answered":
      return "応答";
    case "missed":
      return "不応答";
    case "voicemail":
      return "留守電";
    case "transferred":
      return "転送";
    case "rejected":
      return "着信拒否";
    default:
      return v ?? "—";
  }
}

export function callResultAppearance(
  v: string | null | undefined,
): BadgeProps["color"] {
  switch (v) {
    case "answered":
      return "success";
    case "transferred":
      return "brand";
    case "voicemail":
      return "warning";
    case "missed":
      return "danger";
    case "rejected":
      return "danger";
    default:
      return "subtle";
  }
}

export function operationTypeLabel(v: string | null | undefined): string {
  switch (v) {
    case "start":
      return "開始";
    case "connected":
      return "接続";
    case "hold":
      return "保留";
    case "resume":
      return "保留解除";
    case "transfer":
      return "転送";
    case "dtmf":
      return "プッシュ操作";
    case "hangup":
      return "通話終了";
    default:
      return v ?? "—";
  }
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "0秒";
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}秒`;
  return `${m}分${r}秒`;
}

export function fmtClock(sec: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(sec ?? 0)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function presenceLabel(v: string | null | undefined): string {
  switch (v) {
    case "available":
      return "在席中";
    case "busy":
      return "取り込み中";
    case "dnd":
      return "通話中（応答不可）";
    case "away":
      return "離席中";
    default:
      return v ?? "—";
  }
}

export function presenceColor(
  v: string | null | undefined
): "success" | "warning" | "danger" | "subtle" {
  switch (v) {
    case "available":
      return "success";
    case "busy":
      return "warning";
    case "dnd":
      return "danger";
    default:
      return "subtle";
  }
}

export function mailboxLabel(v: string | null | undefined): string {
  switch (v) {
    case "INBOX":
      return "受信箱";
    case "Old":
      return "保存済み";
    default:
      return v ?? "—";
  }
}

export function announcementLabel(key: string | null | undefined): string {
  switch (key) {
    case "busy":
      return "取り込み中ガイダンス";
    case "dnd":
      return "通話中（応答不可）ガイダンス";
    case "unavail":
      return "離席中ガイダンス";
    default:
      return key ?? "—";
  }
}

export function claimCategoryLabel(v: string | null | undefined): string {
  switch (v) {
    case "monthly":
      return "月次";
    case "lump":
      return "一括";
    case "installment":
      return "分割";
    case "first":
      return "初回";
    case "dunning":
      return "督促";
    default:
      return v ?? "—";
  }
}

export function reviewActionLabel(v: string | null | undefined): string {
  switch (v) {
    case "submitted":
      return "申請";
    case "approved":
      return "承認";
    case "returned":
      return "差し戻し";
    case "rejected":
      return "否決";
    default:
      return v ?? "—";
  }
}

export function reviewActionAppearance(
  v: string | null | undefined,
): BadgeProps["color"] {
  switch (v) {
    case "approved":
      return "success";
    case "submitted":
      return "brand";
    case "returned":
      return "warning";
    case "rejected":
      return "danger";
    default:
      return "subtle";
  }
}

export function lawsuitStatusAppearance(
  v: string | null | undefined,
): BadgeProps["color"] {
  switch (v) {
    case "係争中":
      return "warning";
    case "和解":
    case "取下げ":
      return "informative";
    case "判決":
    case "確定":
    case "完了":
      return "success";
    default:
      return "brand";
  }
}

export function originalStatusAppearance(
  v: string | null | undefined,
): BadgeProps["color"] {
  switch (v) {
    case "保管中":
      return "success";
    case "貸出中":
      return "warning";
    case "返却済":
      return "informative";
    case "廃棄済":
      return "subtle";
    default:
      return "subtle";
  }
}

export function denyApprovalLabel(v: string | null | undefined): string {
  switch (v) {
    case "1":
      return "申請中";
    case "2":
      return "承認済";
    case "3":
      return "却下";
    default:
      return v ?? "—";
  }
}

export function denyApprovalAppearance(v: string | null | undefined): BadgeProps["color"] {
  switch (v) {
    case "1":
      return "warning";
    case "2":
      return "success";
    case "3":
      return "danger";
    default:
      return "subtle";
  }
}

export function denyReasonLabel(v: string | null | undefined): string {
  switch (v) {
    case "1":
      return "総合";
    case "2":
      return "間違い電話";
    case "3":
      return "一時";
    default:
      return v ?? "—";
  }
}

export function entryTypeLabel(v: string | null | undefined): string {
  if (v === "income") return "収入";
  if (v === "expense") return "支出";
  return v ?? "—";
}

export function entryTypeAppearance(
  v: string | null | undefined,
): BadgeProps["color"] {
  if (v === "income") return "success";
  if (v === "expense") return "danger";
  return "subtle";
}

export function userStatusLabel(v: number | null | undefined): string {
  switch (v) {
    case 0:
      return "有効";
    case 1:
      return "停止";
    case 2:
      return "退職";
    default:
      return "—";
  }
}

export function userStatusAppearance(
  v: number | null | undefined,
): BadgeProps["color"] {
  switch (v) {
    case 0:
      return "success";
    case 1:
      return "warning";
    case 2:
      return "subtle";
    default:
      return "subtle";
  }
}

export function notifyChannelLabel(v: string | null | undefined): string {
  switch (v) {
    case "teams":
      return "Teams";
    case "discord":
      return "Discord";
    case "both":
      return "Teams・Discord";
    default:
      return v ?? "—";
  }
}

// MIME タイプ（application/pdf など）を、はみ出さない短い日本語ラベルに変換する。
// 例: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet → 「Excel ファイル」
export function fileTypeLabel(mime: string | null | undefined): string {
  if (!mime) return "—";
  const m = mime.toLowerCase().trim();

  const exact: Record<string, string> = {
    "application/pdf": "PDF ファイル",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel ファイル",
    "application/vnd.ms-excel": "Excel ファイル",
    "application/vnd.ms-excel.sheet.macroenabled.12": "Excel ファイル",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word ファイル",
    "application/msword": "Word ファイル",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      "PowerPoint ファイル",
    "application/vnd.ms-powerpoint": "PowerPoint ファイル",
    "application/zip": "ZIP ファイル",
    "application/x-zip-compressed": "ZIP ファイル",
    "application/x-rar-compressed": "RAR ファイル",
    "application/vnd.rar": "RAR ファイル",
    "application/x-7z-compressed": "7z ファイル",
    "application/x-tar": "TAR ファイル",
    "application/gzip": "GZIP ファイル",
    "text/csv": "CSV ファイル",
    "text/plain": "テキストファイル",
    "text/html": "HTML ファイル",
    "application/json": "JSON ファイル",
    "application/xml": "XML ファイル",
    "text/xml": "XML ファイル",
  };
  if (exact[m]) return exact[m];

  // 画像・音声・動画はグループでまとめる
  if (m.startsWith("image/")) return "画像ファイル";
  if (m.startsWith("audio/")) return "音声ファイル";
  if (m.startsWith("video/")) return "動画ファイル";
  if (m.startsWith("text/")) return "テキストファイル";

  // 未知の MIME は末尾の種別名だけを取り出して短く表示する
  const sub = m.split("/")[1] ?? m;
  let token = sub.split(/[.+]/).pop() ?? sub;
  if (token.length > 10) token = token.slice(0, 10) + "…";
  return `${token.toUpperCase()} ファイル`;
}
