import type { Server } from "node:http";
import { stripMentionsText } from "@microsoft/teams.api";
import { App, ExpressAdapter } from "@microsoft/teams.apps";
import { ConsoleLogger } from "@microsoft/teams.common";
import type { BotConfig, ContractSearchConfig } from "./config.js";
import { createContractSearchHandler } from "./contract-search.js";
import { createReply } from "./responses.js";

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body><h1>${title}</h1>${content}<p><a href="/">MOUNTAIN Teams Bot</a></p></body></html>`;
}

export function configureRoutes(app: App, adapter: ExpressAdapter, searchConfig?: ContractSearchConfig): void {
  const handleContractSearch = createContractSearchHandler(app, searchConfig);
  adapter.use((_request, response, next) => {
    response.removeHeader("X-Powered-By");
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    next();
  });
  adapter.get("/healthz", (_request, response) => {
    response.json({ status: "ok" });
  });
  adapter.get("/", (_request, response) => {
    response.type("html").send(page("MOUNTAIN Teams Bot",
      "<p>Teams 接続確認・契約検索用 Bot です。Teams のチャットから ping または help を送信してください。</p>" +
      '<p><a href="/privacy">プライバシー</a> / <a href="/terms">利用条件</a></p>'));
  });
  adapter.get("/privacy", (_request, response) => {
    response.type("html").send(page("プライバシー",
      "<p>この Bot は、Teams から受信したテキストに応答し、設定済みの場合は本人の権限で契約を検索します。" +
      "メッセージは Microsoft Teams と Bot 接続サービスを経由します。</p>" +
      "<p>Bot 自体には会話本文を保存する機能はありません。" +
      "契約の検索語・結果・アクセストークンを Bot のアプリログに記録しません。" +
      "Teams 側の履歴と、SDK・Cloudflare・配信基盤の診断ログは各サービスの運用設定に従います。</p>" +
      "<p>パスワード・シークレット・口座番号・カード番号をチャットに入力しないでください。" +
      "お問い合わせは社内の運用管理者へ連絡してください。</p>"));
  });
  adapter.get("/terms", (_request, response) => {
    response.type("html").send(page("利用条件",
      "<p>社内の接続確認と、本人の閲覧権限に基づく個人チャットでの契約検索に対応します。</p>" +
      "<p>業務データの登録・変更・削除、ALPS 通知、業務判断の代行は行いません。" +
      "認証情報・口座番号・カード番号を入力しないでください。利用範囲は社内の運用管理者の案内に従ってください。</p>"));
  });

  app.on("message", async (context) => {
    const { activity, send } = context;
    const text = activity.text
      ? stripMentionsText(activity, { accountId: activity.recipient.id })
      : "";
    if (await handleContractSearch(context, text)) return;
    await send({ type: "message", textFormat: "plain", text: createReply(text) });
  });
  app.event("error", ({ error }) => {
    app.log.error("Activity processing failed:", error instanceof Error ? error.name : "Unknown error");
  });
}

export function createBot(config: BotConfig, server?: Server): App {
  const logger = new ConsoleLogger("mountain-teams-bot", { level: "info" });
  const adapter = new ExpressAdapter(server, { logger });
  const app = new App({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tenantId: config.tenantId,
    dangerouslyAllowUnauthenticatedRequests: false,
    httpServerAdapter: adapter,
    logger,
  });

  app.use(async ({ activity, log, next }) => {
    const tenantIds = [
      activity.channelData?.tenant?.id,
      activity.conversation?.tenantId,
    ].filter((value) => value !== undefined);
    if (activity.channelId !== "msteams" || tenantIds.length === 0 ||
        !tenantIds.every((id) => typeof id === "string" && id.toLowerCase() === config.tenantId)) {
      log.warn("Rejected activity outside the configured Teams tenant.");
      return { status: 403 };
    }
    await next();
  });
  configureRoutes(app, adapter, config.contractSearch);
  return app;
}
