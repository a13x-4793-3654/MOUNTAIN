import { FormEvent, useState } from "react";
import {
  Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Field, Input, Select,
} from "@fluentui/react-components";
import {
  CalendarFeed, createCalendarFeed, deleteCalendarFeed, updateCalendarFeed,
} from "../../api/calendar";
import { calendarError, FEED_COLOR, formatCalendarTime, readIcsFile, validColor } from "./calendarUtils";

interface Props {
  feeds: CalendarFeed[];
  onSaved: (feed: CalendarFeed) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}

export default function FeedSettings({ feeds, onSaved, onDeleted, onClose }: Props) {
  const [editing, setEditing] = useState<CalendarFeed | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"url" | "file">("url");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [color, setColor] = useState(FEED_COLOR);
  const [visible, setVisible] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<CalendarFeed | null>(null);

  const reset = () => {
    setEditing(null); setName(""); setKind("url"); setUrl(""); setFile(null);
    setFileKey((value) => value + 1); setColor(FEED_COLOR); setVisible(true); setError("");
  };
  const edit = (feed: CalendarFeed) => {
    setEditing(feed); setName(feed.name); setKind(feed.kind); setColor(validColor(feed.color));
    setVisible(feed.visible); setError(""); setNotice(""); setUrl(""); setFile(null);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(""); setNotice(""); setBusy(true);
    try {
      const metadata = { name: name.trim(), color, visible };
      if (!metadata.name) throw new Error("カレンダー名を入力してください。");
      let result: CalendarFeed;
      if (editing) result = await updateCalendarFeed(editing.id, metadata);
      else if (kind === "url") {
        let parsed: URL;
        try { parsed = new URL(url.trim()); } catch { throw new Error("有効な購読URLを入力してください。"); }
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("http または https の購読URLを入力してください。");
        result = await createCalendarFeed({ ...metadata, kind, url: url.trim() });
      } else {
        if (!file) throw new Error(".ics ファイルを選択してください。");
        result = await createCalendarFeed({ ...metadata, kind, content: await readIcsFile(file), filename: file.name });
      }
      onSaved(result);
      reset(); setNotice("カレンダーを保存しました。");
    } catch (error) {
      setError(calendarError(error));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!deleting || busy) return;
    setError(""); setNotice(""); setBusy(true);
    try {
      await deleteCalendarFeed(deleting.id);
      onDeleted(deleting.id);
      if (editing?.id === deleting.id) reset();
      setDeleting(null); setNotice("カレンダーを削除しました。");
    } catch (error) {
      setError(calendarError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(_, data) => { if (!data.open && !busy) onClose(); }}>
      <DialogSurface className="calendar-settings" aria-label="個人用ICSカレンダー設定">
        <DialogBody>
          <DialogTitle>個人用ICSカレンダー設定</DialogTitle>
          <DialogContent>
            <p>この設定と予定は自分だけに表示されます。表示専用で、Outlookへの登録・インポートは行いません。</p>
            <p>URLは画面を開き直すと自動再取得します。ファイルは保存時の内容を表示します。URLやファイル内容を変更する場合は、削除して追加し直してください。</p>
            {error && <p role="alert" className="calendar-error">{error}</p>}
            {notice && <p role="status">{notice}</p>}
            {deleting ? (
              <section aria-label="ICSカレンダーの削除確認">
                <h3>「{deleting.name}」を削除しますか？</h3>
                <p>保存した購読設定・ファイルを削除します。元のカレンダーやOutlookの予定は変更しません。</p>
                <div className="calendar-actions">
                  <Button disabled={busy} onClick={() => { setDeleting(null); setError(""); }}>削除をキャンセル</Button>
                  <Button appearance="primary" disabled={busy} onClick={() => void remove()}>削除する</Button>
                </div>
              </section>
            ) : <>
              <ul className="calendar-feed-list" aria-label="保存済みICSカレンダー">
                {feeds.map((feed) => (
                  <li key={feed.id}>
                    <div className="calendar-feed-summary">
                      <span className="calendar-swatch" style={{ backgroundColor: validColor(feed.color) }} />
                      <strong>{feed.name}</strong>
                      <span>{feed.kind === "url" ? "URL購読" : `ファイル: ${feed.filename ?? "ICS"}`}</span>
                      <span>{feed.visible ? "表示" : "非表示"}</span>
                    </div>
                    <p>最終取得: {feed.last_fetched_at ? `${formatCalendarTime(feed.last_fetched_at)}（日本時間）` : "未取得"}</p>
                    {feed.last_error && <p className="calendar-error">最終エラー: {feed.last_error}</p>}
                    <div className="calendar-actions">
                      <Button size="small" disabled={busy} aria-label={`${feed.name} の表示設定を編集`} onClick={() => edit(feed)}>表示設定を編集</Button>
                      <Button size="small" disabled={busy} aria-label={`${feed.name} を削除`} onClick={() => { setDeleting(feed); setError(""); }}>削除</Button>
                    </div>
                  </li>
                ))}
              </ul>
              {!feeds.length && <p>保存済みのICSカレンダーはありません。</p>}
              <form onSubmit={(event) => void save(event)} aria-label={editing ? "ICS表示設定の編集" : "ICSカレンダーを追加"}>
                <fieldset disabled={busy} className="calendar-feed-form">
                  <legend>{editing ? `「${editing.name}」の表示設定` : "カレンダーを追加"}</legend>
                  <Field label="カレンダー名" required><Input value={name} maxLength={200} required onChange={(_, data) => setName(data.value)} /></Field>
                  {!editing && <>
                    <Field label="追加方法">
                      <Select value={kind} onChange={(_, data) => setKind(data.value as "url" | "file")}>
                        <option value="url">URLを購読</option>
                        <option value="file">ICSファイルをアップロード</option>
                      </Select>
                    </Field>
                    {kind === "url"
                      ? <Field label="購読URL" required hint="URLはサーバーに保存され、保存後は画面に再表示されません。">
                        <Input type="url" required value={url} autoComplete="off" onChange={(_, data) => setUrl(data.value)} placeholder="https://example.invalid/calendar.ics" />
                      </Field>
                      : <Field label="ICSファイル" required hint="UTF-8形式・1 MiB以下。内容はサーバーでも検証します。">
                        <input key={fileKey} type="file" aria-label="ICSファイル" accept=".ics,text/calendar" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
                      </Field>}
                  </>}
                  <Field label="表示色"><input type="color" aria-label="表示色" value={color} onChange={(event) => setColor(event.target.value)} /></Field>
                  <Checkbox label="カレンダーに表示" checked={visible} onChange={(_, data) => setVisible(data.checked === true)} />
                  <div className="calendar-actions">
                    <Button type="submit" appearance="primary" disabled={busy}>{busy ? "保存中…" : editing ? "表示設定を保存" : "追加する"}</Button>
                    {editing && <Button disabled={busy} onClick={reset}>編集をキャンセル</Button>}
                  </div>
                </fieldset>
              </form>
            </>}
          </DialogContent>
          <DialogActions><Button disabled={busy} onClick={onClose}>閉じる</Button></DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
