import { useEffect, useState } from "react";
import { Button } from "@fluentui/react-components";
import { ChevronLeft20Regular, ChevronRight20Regular } from "@fluentui/react-icons";
import { DateTime } from "luxon";
import { CALENDAR_ZONE, jstNow } from "./calendarUtils";

export default function MiniCalendar({ date, onSelect }: { date: string; onSelect: (date: string) => void }) {
  const [month, setMonth] = useState(() => DateTime.fromISO(date, { zone: CALENDAR_ZONE }).startOf("month"));
  useEffect(() => { setMonth(DateTime.fromISO(date, { zone: CALENDAR_ZONE }).startOf("month")); }, [date]);
  const start = month.minus({ days: month.weekday % 7 });
  return (
    <section aria-label="ミニカレンダー" className="calendar-mini">
      <div className="calendar-mini-toolbar">
        <Button appearance="subtle" size="small" icon={<ChevronLeft20Regular />} aria-label="ミニカレンダー 前の月" onClick={() => setMonth(month.minus({ months: 1 }))} />
        <strong aria-live="polite">{month.toFormat("yyyy年M月")}</strong>
        <Button appearance="subtle" size="small" icon={<ChevronRight20Regular />} aria-label="ミニカレンダー 次の月" onClick={() => setMonth(month.plus({ months: 1 }))} />
      </div>
      <div className="calendar-mini-grid">
        {["日", "月", "火", "水", "木", "金", "土"].map((day) => <span key={day} aria-hidden="true">{day}</span>)}
        {Array.from({ length: 42 }, (_, index) => {
          const day = start.plus({ days: index });
          const iso = day.toISODate()!;
          return (
            <button key={iso} type="button" aria-label={day.toFormat("yyyy年M月d日")}
              aria-pressed={date === iso} aria-current={iso === jstNow().toISODate() ? "date" : undefined}
              className={day.month !== month.month ? "calendar-mini-outside" : ""}
              onClick={() => onSelect(iso)}>{day.day}</button>
          );
        })}
      </div>
    </section>
  );
}
