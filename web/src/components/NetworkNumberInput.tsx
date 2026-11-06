import { useEffect, useId, useState } from "react";

/** Number input that lets users edit freely and commits only valid values. */
export function NetworkNumberInput({
  value,
  onChange,
  min = 0,
  step = "any",
  label,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  step?: string;
  label: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const hintId = useId();
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const empty = text.trim() === "";
  const invalid = empty || !Number.isFinite(Number(text)) || Number(text) < min;
  return (
    <label className="net-field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={text}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={invalid ? hintId : undefined}
        onChange={(event) => {
          setText(event.target.value);
          const next = Number(event.target.value);
          if (event.target.value.trim() !== "" && Number.isFinite(next) && next >= min) onChange(next);
        }}
      />
      {invalid && <span className="field-help" id={hintId}>{empty ? "Enter a number." : `Enter a number ≥ ${min}.`}</span>}
    </label>
  );
}
