// A4印刷ユーティリティ：自己完結したHTMLを別ウィンドウで開いて印刷する。
// （SPA本体のDOMを汚さないよう、印刷は独立ウィンドウで行う）

const PRINT_CSS = `
  @page{size:A4 portrait;margin:14mm;}
  *{box-sizing:border-box;}
  body{margin:0;font-family:'Segoe UI','Yu Gothic UI','Meiryo',sans-serif;color:#111;}
  .a4{font-family:'Segoe UI','Yu Gothic UI','Meiryo',sans-serif;color:#111;}
  .a4-lb{border:2px solid #111;border-radius:8px;padding:22px 24px;text-align:center;}
  .a4-lb .lb-head{font-size:13px;letter-spacing:2px;color:#444;border-bottom:1px solid #bbb;padding-bottom:8px;margin-bottom:16px;}
  .a4-lb .lb-code{font-size:64px;font-weight:800;letter-spacing:3px;line-height:1.1;}
  .a4-lb .lb-title{font-size:22px;font-weight:700;margin:10px 0 20px;}
  .lb-tbl{width:100%;border-collapse:collapse;font-size:15px;}
  .lb-tbl th,.lb-tbl td{border:1px solid #999;padding:8px 12px;text-align:left;}
  .lb-tbl th{background:#f0f0f0;width:32%;}
  .a4-lb .lb-note{margin-top:18px;font-size:12px;color:#555;text-align:left;}
  .a4-h{font-size:22px;margin:0 0 4px;}
  .a4-sub{font-size:12px;color:#444;margin-bottom:12px;}
  .a4-tbl{width:100%;border-collapse:collapse;font-size:12px;}
  .a4-tbl th,.a4-tbl td{border:1px solid #999;padding:5px 7px;text-align:left;vertical-align:top;}
  .a4-tbl th{background:#f0f0f0;}
  .a4-foot{margin-top:12px;font-size:12px;color:#444;text-align:right;}
`;

/** HTMLエスケープ（印刷HTMLへ値を差し込む前に必ず通す）。 */
export function escHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 本日の日付を YYYY-MM-DD で返す。 */
export function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A4用のHTML本体を別ウィンドウで開いて印刷する。 */
export function printA4(title: string, bodyHtml: string): void {
  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) {
    alert(
      "印刷用の画面を開けませんでした。ブラウザのポップアップ許可をご確認ください。"
    );
    return;
  }
  w.document.write(
    `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">` +
      `<title>${escHtml(title)}</title><style>${PRINT_CSS}</style></head>` +
      `<body>${bodyHtml}</body></html>`
  );
  w.document.close();
  w.focus();
  // 描画完了を待ってから印刷ダイアログを表示
  setTimeout(() => {
    try {
      w.print();
    } catch {
      /* ユーザーが閉じた場合など */
    }
  }, 300);
}
