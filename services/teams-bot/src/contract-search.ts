import type { App, IActivityContext } from "@microsoft/teams.apps";
import { isGuid, type ContractSearchConfig } from "./config.js";
import { MountainApiError, MountainContractsClient, validateContractQuery } from "./contracts.js";

export type ContractCommand =
  | { kind: "search"; query: string }
  | { kind: "signout" };

export function parseContractCommand(text: string): ContractCommand | undefined {
  const trimmed = text.trim().replace(/^\//, "");
  if (/^(?:ログアウト|signout)$/i.test(trimmed)) return { kind: "signout" };
  const match = /^(?:契約検索|search)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  return match ? { kind: "search", query: match[1]?.trim() ?? "" } : undefined;
}

const errorMessages = {
  unauthorized: "MOUNTAIN のサインインを確認できませんでした。「ログアウト」後、Teams と同じアカウントで検索し直してください。",
  forbidden: "このアカウントには MOUNTAIN の契約を閲覧する権限がありません。管理者にお問い合わせください。",
  timeout: "MOUNTAIN の応答がタイムアウトしました。時間をおいて検索し直してください。",
  unavailable: "MOUNTAIN に接続できませんでした。時間をおいて検索し直してください。",
  invalid_response: "MOUNTAIN から想定外の応答がありました。管理者にお問い合わせください。",
  unsafe_configuration: "検索先の Entra 認証またはテナント設定が一致しないため、検索を停止しました。管理者にお問い合わせください。",
} as const;

export function createContractSearchHandler(app: App, config?: ContractSearchConfig) {
  const client = config ? new MountainContractsClient(config) : undefined;
  const flow = config ? app.addOAuthFlow(config.connectionName, {
    oauthCardText: "契約を検索するには、MOUNTAIN にサインインしてください。",
    signInButtonText: "MOUNTAIN にサインイン",
  }) : undefined;
  flow?.onSignInComplete(async (context) => {
    if (context.activity.conversation.conversationType === "personal") {
      await context.send({
        type: "message", textFormat: "plain",
        text: "MOUNTAIN にサインインしました。もう一度「契約検索 キーワード」を送信してください。",
      });
    }
  });
  flow?.onSignInFailure(async (context) => {
    context.log.error("MOUNTAIN sign-in failed.");
    if (context.activity.conversation.conversationType === "personal") {
      await context.send({
        type: "message", textFormat: "plain",
        text: "MOUNTAIN にサインインできませんでした。時間をおいて検索し直してください。",
      });
    }
  });

  return async (context: IActivityContext, text: string): Promise<boolean> => {
    const command = parseContractCommand(text);
    if (!command) return false;
    const send = async (message: string) => {
      await context.send({ type: "message", textFormat: "plain", text: message });
    };
    if (context.activity.conversation.conversationType !== "personal") {
      await send("契約検索とサインアウトは、業務情報の保護のため Bot との個人チャットで利用してください。");
      return true;
    }
    if (command.kind === "search") {
      try {
        validateContractQuery(command.query);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        await send("「契約検索 キーワード」で検索します。契約番号・概要・会社名・契約者名を、1〜200文字で入力してください。");
        return true;
      }
    }
    if (!flow || !client) {
      await send("契約検索の接続設定が未完了です。管理者に MOUNTAIN API と OAuth 接続の設定を依頼してください。");
      return true;
    }
    if (!isGuid(context.activity.from.aadObjectId)) {
      await send("Teams のユーザーを確認できないため検索を停止しました。職場アカウントの個人チャットで利用してください。");
      return true;
    }
    try {
      if (command.kind === "signout") {
        await flow.signOut(context);
        await send("MOUNTAIN 連携からサインアウトしました。");
        return true;
      }
      const token = await flow.signIn(context);
      if (!token) return true;
      const result = await client.search(command.query, token, context.activity.from.aadObjectId);
      await send(client.format(result));
      return true;
    } catch (error) {
      if (error instanceof MountainApiError) {
        context.log.error("Contract search failed:", error.code);
        await send(errorMessages[error.code]);
        return true;
      }
      context.log.error("MOUNTAIN OAuth or search failed:", error instanceof Error ? error.name : "Unknown error");
      await send("MOUNTAIN 連携でエラーが発生しました。解消しない場合は管理者にお問い合わせください。");
      return true;
    }
  };
}
