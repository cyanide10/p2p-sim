import { useState } from "react";
import { parseRateSchedule } from "../lib/network";

type SchedulePoint = { t: number; rate: number };

function scheduleText(points: SchedulePoint[]) {
  return points.map((point) => `${point.t}:${point.rate}`).join(", ");
}

export function NetworkScheduleInput({
  points,
  onChange,
}: {
  points: SchedulePoint[];
  onChange: (points: SchedulePoint[]) => void;
}) {
  const [text, setText] = useState(scheduleText(points));
  const valid = parseRateSchedule(text) !== null;
  return (
    <label className="net-field net-field-wide">
      <span>Schedule (time:rate, …)</span>
      <input
        value={text}
        aria-invalid={!valid}
        placeholder="0:10, 60:40, 120:10"
        onChange={(event) => {
          setText(event.target.value);
          const parsed = parseRateSchedule(event.target.value);
          if (parsed) onChange(parsed);
        }}
      />
    </label>
  );
}
