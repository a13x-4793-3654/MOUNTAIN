const help = [
  "MOUNTAIN Teams Bot の接続確認用 Bot です。",
  "ping: 接続確認（pong を返します）",
  "help: この案内を表示",
  "その他のテキスト: 受信した内容を返信",
  "ALPS 通知・業務データの検索・操作にはまだ対応していません。",
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
