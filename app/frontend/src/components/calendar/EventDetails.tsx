import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Link,
} from "@fluentui/react-components";
import type { CalendarEvent } from "../../api/calendar";
import { calendarDescriptionParts, eventPeriod, safeCalendarLink } from "./calendarUtils";

export interface DisplayCalendarEvent { event: CalendarEvent; sourceName: string }
export default function EventDetails({ selected, onClose }: { selected: DisplayCalendarEvent | null; onClose: () => void }) {
  const link = safeCalendarLink(selected?.event.web_url ?? null);
  return (
    <Dialog open={!!selected} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
      <DialogSurface aria-label={selected?.event.title || "予定の詳細"}>
        <DialogBody>
          <DialogTitle>{selected?.event.title || "予定の詳細"}</DialogTitle>
          <DialogContent>
            {selected && <>
              <p>読み取り専用</p>
              <dl className="calendar-details">
                <dt>カレンダー</dt><dd>{selected.sourceName}</dd>
                <dt>日時</dt><dd>{eventPeriod(selected.event)}</dd>
                <dt>場所</dt><dd>{selected.event.location || "未設定"}</dd>
                <dt>説明</dt><dd className="calendar-description">
                  {calendarDescriptionParts(selected.event.description || "なし").map((part, index) => part.href
                    ? <Link key={index} href={part.href} target="_blank" rel="noopener noreferrer" title="新しいタブで開く">{part.text}</Link>
                    : part.text)}
                </dd>
              </dl>
              {link && <Link href={link} target="_blank" rel="noopener noreferrer">外部ページを開く（新しいタブ）</Link>}
            </>}
          </DialogContent>
          <DialogActions><Button appearance="primary" onClick={onClose}>閉じる</Button></DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
