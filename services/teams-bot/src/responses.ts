const help = [
  "MOUNTAIN Teams Bot（接続確認用 Bot・個人チャットの契約検索）です。",
  "ping: 接続確認（pong を返します）",
  "help: この案内を表示",
  "契約検索 キーワード / search キーワード: MOUNTAIN の契約検索（個人チャット・サインイン必須）",
  "ログアウト / signout: MOUNTAIN 連携からサインアウト（個人チャットのみ）",
  "その他のテキスト: 受信した内容を返信",
  "契約検索には管理者による接続設定が必要です。ALPS 通知・業務データの操作にはまだ対応していません。",
].join("\n");

export function createReply(text: string): string {
  const trimmed = text.trim();
  const command = trimmed.toLowerCase().replace(/^\//, "");
  if (command === "help" || !trimmed) {
    return help;
  }
  if (command === "ping") {
    return "pong";
  }

  const characters = Array.from(trimmed);
  const echo = characters.slice(0, 2000).join("");
  const suffix = characters.length > 2000 ? "\n（先頭 2,000 文字のみ表示）" : "";
  return `受信しました:\n${echo}${suffix}`;
}
