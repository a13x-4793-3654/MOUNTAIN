import { Badge, Button, Caption1, Spinner } from "@fluentui/react-components";
import type { CalendarRegistration } from "../api/client";
import { getRuntimeConfig } from "../auth/runtimeConfig";
import { formatCalendarDateTime } from "../util/calendarDateTime";

export default function CalendarRegistrationStatus({
  calendar,
  summary,
  busy,
  disabled,
  onRetry,
}: {
  calendar: CalendarRegistration | null;
  summary: string;
  busy: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  if (!calendar) return <Caption1>予定登録なし</Caption1>;
  const config = getRuntimeConfig().calendar;
  const created = calendar.status === "created";
  const pending = calendar.status === "pending";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, padding: "4px 0" }}>
      <Badge appearance="tint" color={created ? "success" : pending ? "warning" : "danger"}>
        {created ? "予定登録済み" : pending ? "予定登録の確認待ち" : "予定登録に失敗"}
      </Badge>
      <Caption1>登録先：{calendar.calendar_name}</Caption1>
      <Caption1>開始：{formatCalendarDateTime(calendar.starts_at)}</Caption1>
      <Caption1>終了：{formatCalendarDateTime(calendar.ends_at)}（JST / UTC+09:00）</Caption1>
      {!created && (
        <>
          <Caption1>履歴は保存済みです。{pending ? "予定の登録結果は未確認です。" : "予定の登録が完了していません。"}</Caption1>
          {calendar.error && <Caption1>{calendar.error}</Caption1>}
          <Button
            size="small"
            disabled={busy || disabled || !config.enabled}
            aria-label={`「${summary}」の予定を再登録`}
            onClick={onRetry}
          >
            {busy ? <Spinner size="tiny" label="予定を確認中…" /> : "予定を再登録"}
          </Button>
          <Caption1>最初に予定登録を依頼した本人のみ再試行できます。履歴は追加されません。</Caption1>
          {!config.enabled && <Caption1>{config.unavailable_reason ?? "予定登録は現在利用できません。"}</Caption1>}
        </>
      )}
    </div>
  );
}
