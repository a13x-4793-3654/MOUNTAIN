import { useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Text,
  Textarea,
} from "@fluentui/react-components";
import { addCommunication, updateCommunication, retryCommunicationCalendar, ApiError } from "../api/client";
import type { CalendarRegistration, Communication, CommunicationCreated, CommunicationIn } from "../api/client";
import { getRuntimeConfig } from "../auth/runtimeConfig";
import { calendarDateTimeToJst } from "../util/calendarDateTime";
import type { SelectOption } from "./FormDialog";
import CalendarRegistrationStatus from "./CalendarRegistrationStatus";

type Values = {
  occurred_at: string;
  direction: string;
  channel: string;
  summary: string;
  details: string;
  starts_at: string;
  ends_at: string;
};
type FieldErrors = Partial<Record<keyof Values, string>>;

export default function CommunicationCreateDialog({
  contractId,
  communication,
  channels,
  directions,
  onSaved,
  onCalendarUpdated,
  onClose,
}: {
  contractId: string;
  communication?: Communication;
  channels: string[];
  directions: SelectOption[];
  onSaved: (result: CommunicationCreated, calendarRequested: boolean) => void;
  onCalendarUpdated?: (calendar: CalendarRegistration) => void;
  onClose: (uncertain: boolean) => void;
}) {
  const calendar = getRuntimeConfig().calendar;
  const initialDate = (communication?.occurred_at ?? "").slice(0, 10);
  const [values, setValues] = useState<Values>(() => ({
    occurred_at: initialDate,
    direction: communication?.direction ?? "in",
    channel: communication?.channel ?? "",
    summary: communication?.summary ?? "",
    details: communication?.details ?? "",
    starts_at: "", ends_at: "",
  }));
  const [registeredCalendar, setRegisteredCalendar] = useState(communication?.calendar ?? null);
  const [retryingCalendar, setRetryingCalendar] = useState(false);
  const [calendarRetried, setCalendarRetried] = useState(false);
  const [retryUncertain, setRetryUncertain] = useState(false);
  const [withCalendar, setWithCalendar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [registrationConflict, setRegistrationConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const busyRef = useRef(false);
  const requestId = useRef<string | null>(null);
  const submitted = useRef<CommunicationIn | null>(null);
  const disabled = busy || locked;
  const canRetry = locked && !registrationConflict && (!!communication || !!submitted.current?.calendar);

  function set(key: keyof Values, value: string) {
    if (busyRef.current || locked) return;
    setValues((previous) => ({ ...previous, [key]: value }));
    setFieldErrors((previous) => ({ ...previous, [key]: undefined }));
  }

  function close() {
    if (!busyRef.current) onClose(locked || retryUncertain);
  }

  async function retryCalendar() {
    if (!communication || !registeredCalendar || registeredCalendar.status === "created" || busyRef.current || locked) return;
    busyRef.current = true;
    setBusy(true);
    setRetryingCalendar(true);
    setError(null);
    let result: CalendarRegistration;
    try {
      result = await retryCommunicationCalendar(communication.id);
    } catch (e: unknown) {
      const forbidden = e instanceof ApiError && e.status === 403;
      if (!forbidden) setRetryUncertain(true);
      setError(forbidden
        ? "予定の再試行は、最初に予定登録を依頼した本人のみ行えます。履歴の編集内容は保存していません。"
        : `予定の再試行結果を確認できませんでした。履歴の編集内容は保存していません。 ${e instanceof Error ? e.message : "予定登録の再試行に失敗しました。"}`);
      return;
    } finally {
      busyRef.current = false;
      setBusy(false);
      setRetryingCalendar(false);
    }
    setRegisteredCalendar(result);
    setCalendarRetried(true);
    setRetryUncertain(false);
    onCalendarUpdated?.(result);
  }

  async function submit() {
    if (busyRef.current || (locked && !canRetry)) return;
    let body = locked ? submitted.current : null;
    if (!body) {
      const errors: FieldErrors = {};
      const summary = values.summary.trim();
      if (!summary) errors.summary = "概要（結果・要点）を入力してください。";
      else if (Array.from(summary).length > 255) errors.summary = "概要（結果・要点）は255文字以内で入力してください。";
      const startsAt = calendarDateTimeToJst(values.starts_at);
      const endsAt = calendarDateTimeToJst(values.ends_at);
      if (withCalendar) {
        if (registeredCalendar) {
          setError("この履歴には予定の登録情報があるため、追加登録はできません。");
          return;
        }
        if (!calendar.enabled) {
          setError(calendar.unavailable_reason ?? "予定登録は利用できません。");
          return;
        }
        if (!startsAt) errors.starts_at = "実在する開始日時を分単位で入力してください。";
        if (!endsAt) errors.ends_at = "実在する終了日時を分単位で入力してください。";
        if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
          errors.ends_at = "終了日時は開始日時より後にしてください。";
        }
      }
      setFieldErrors(errors);
      setError(null);
      if (Object.keys(errors).length) return;
      body = {
        occurred_at: communication && values.occurred_at === initialDate
          ? communication.occurred_at : values.occurred_at || null,
        direction: values.direction || null,
        channel: values.channel || null,
        summary,
        details: values.details.trim() || null,
      };
      if (withCalendar && startsAt && endsAt) {
        try {
          requestId.current ??= crypto.randomUUID();
        } catch {
          setError("安全な送信 ID を生成できません。HTTPS で開き直してください。入力内容は保持しています。");
          return;
        }
        body.calendar = {
          request_id: requestId.current,
          starts_at: startsAt,
          ends_at: endsAt,
        };
      }
      submitted.current = body;
    }

    busyRef.current = true;
    setBusy(true);
    setError(null);
    let result: CommunicationCreated;
    try {
      result = communication
        ? await updateCommunication(communication.id, body)
        : await addCommunication(contractId, body);
    } catch (e: unknown) {
      // 保存前と断定できる応答以外では、同じ ID・同じ本文だけを再送する。
      const rejectedBeforeSave = e instanceof ApiError && [400, 401, 403, 404, 422].includes(e.status);
      if (!rejectedBeforeSave) setLocked(true);
      const conflict = e instanceof ApiError && e.status === 409 && !!body.calendar;
      if (conflict) setRegistrationConflict(true);
      const message = conflict
        ? "予定の追加登録はできません。閉じて履歴の最新の登録状態を確認してください。"
        : locked || !rejectedBeforeSave
          ? "送信結果を確認できませんでした。"
          : "保存できませんでした。入力内容は保持しています。";
      setError(`${message} ${e instanceof Error ? e.message : "送信に失敗しました。"}`);
      return;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    onSaved(result, !!body.calendar);
  }

  return (
    <Dialog open onOpenChange={(_, data) => { if (!data.open && !locked) close(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{communication ? "やり取りを編集" : "やり取りを記録"}</DialogTitle>
          <DialogContent>
            {error && (
              <MessageBar intent="error" style={{ marginBottom: 12 }}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            {locked && (
              <MessageBar intent="warning" style={{ marginBottom: 12 }}>
                <MessageBarBody>
                  保存結果や予定の登録状態を確認するまで、入力内容を固定しています。
                  {canRetry
                    ? submitted.current?.calendar
                      ? "「同じ内容で再試行」は、同じ送信 ID と内容で保存結果を確認します。閉じるとこの再試行情報は失われます。"
                      : "「同じ内容で再試行」は同じ履歴変更だけを再送します。新しい履歴・予定は登録しません。"
                    : registrationConflict
                      ? "新しい送信 ID で予定を登録し直さないでください。"
                      : "予定を付けない新規記録は安全な再試行ができません。"}
                  閉じた後は、履歴を確認するまで新しく記録しないでください。
                </MessageBarBody>
              </MessageBar>
            )}
            <div style={{ display: "grid", rowGap: 12, paddingTop: 4 }}>
              <Field label="日時" hint={communication
                ? "やり取りが発生した日です。変更しなければ元の日時を保持します。予定の日時とは別の項目です。"
                : "やり取りが発生した日です。空欄の場合は登録時の日時で記録します。予定の開始・終了日時とは別に入力します。"}>
                <Input type="date" value={values.occurred_at} disabled={disabled} onChange={(_, data) => set("occurred_at", data.value)} />
              </Field>
              <Field label="区分">
                <Dropdown
                  value={directions.find((option) => option.value === values.direction)?.label ?? ""}
                  selectedOptions={[values.direction]}
                  disabled={disabled}
                  onOptionSelect={(_, data) => set("direction", data.optionValue ?? "")}
                >
                  {directions.map((option) => <Option key={option.value} value={option.value}>{option.label}</Option>)}
                </Dropdown>
              </Field>
              <Field label="手段">
                <Dropdown
                  placeholder="選択してください"
                  value={values.channel}
                  selectedOptions={values.channel ? [values.channel] : []}
                  disabled={disabled}
                  onOptionSelect={(_, data) => set("channel", data.optionValue ?? "")}
                >
                  {channels.map((channel) => <Option key={channel} value={channel}>{channel}</Option>)}
                </Dropdown>
              </Field>
              <Field label="概要（結果・要点）" required hint="255文字以内" validationMessage={fieldErrors.summary}>
                <Input value={values.summary} disabled={disabled} onChange={(_, data) => set("summary", data.value)} />
              </Field>
              <Field label="詳細メモ">
                <Textarea value={values.details} disabled={disabled} onChange={(_, data) => set("details", data.value)} />
              </Field>
              {registeredCalendar ? (
                <>
                  <Text weight="semibold">予定の追加登録不可</Text>
                  <Text size={200}>
                    この履歴には予定の登録情報があります。履歴の編集は Outlook の予定を変更しません。
                    確認待ち・失敗した予定は「予定を再登録」から既存の登録内容だけを再試行できます。
                    この画面の未保存の変更は予定に反映されません。
                  </Text>
                  <CalendarRegistrationStatus
                    calendar={registeredCalendar}
                    summary={communication?.summary ?? values.summary}
                    busy={retryingCalendar}
                    disabled={disabled}
                    onRetry={() => void retryCalendar()}
                  />
                  {calendarRetried && <Text size={200}>予定の登録状態を更新しました。履歴の編集内容は「保存」を押すまで保存されません。</Text>}
                </>
              ) : (
                <Field hint={!calendar.enabled ? calendar.unavailable_reason ?? "管理者による予定表の設定が必要です。" : undefined}>
                  <Checkbox
                    label="Microsoft 365 グループ（Teams）の予定表にも予定を登録する"
                    checked={withCalendar}
                    disabled={disabled || !calendar.enabled}
                    onChange={(_, data) => {
                      if (!busyRef.current && !locked) {
                        setWithCalendar(data.checked === true);
                        setFieldErrors({});
                        setError(null);
                      }
                    }}
                  />
                </Field>
              )}
              <Text size={200}>
                登録先：{calendar.name || "未設定"}（管理者指定の Microsoft 365 グループの予定表）。
                個人用・共有メールボックスの予定表には登録しません。
                概要と詳細メモはこのグループにコピーされ、予定表を閲覧できるメンバーに共有されます。
                予定にはこの履歴へのリンクも追加されます。
                履歴を後で編集・削除しても、Outlook の予定は自動更新・削除されません。
              </Text>
              {withCalendar && !registeredCalendar && (
                <>
                  <Text size={200}>予定の日時は日本時間（JST / UTC+09:00）です。端末のタイムゾーンに関係なく、日本時間として登録します。</Text>
                  <Field label="予定の開始日時（日本時間）" required validationMessage={fieldErrors.starts_at}>
                    <Input type="datetime-local" step={60} required value={values.starts_at} disabled={disabled} onChange={(_, data) => set("starts_at", data.value)} />
                  </Field>
                  <Field label="予定の終了日時（日本時間）" required validationMessage={fieldErrors.ends_at}>
                    <Input type="datetime-local" step={60} required value={values.ends_at} disabled={disabled} onChange={(_, data) => set("ends_at", data.value)} />
                  </Field>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={busy} onClick={close}>
              {locked ? "閉じて履歴を確認" : "キャンセル"}
            </Button>
            <Button appearance="primary" disabled={busy || (locked && !canRetry)} onClick={submit}>
              {busy ? <Spinner size="tiny" label="送信中…" /> : locked ? "同じ内容で再試行" : communication ? "保存" : "記録する"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
