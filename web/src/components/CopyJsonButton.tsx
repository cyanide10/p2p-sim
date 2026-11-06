import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** Ghost button that copies a JSON payload to the clipboard and flashes "Copied". Shared by all report screens. */
export function CopyJsonButton({
  value,
  label = "Copy JSON",
  className,
}: {
  value: unknown;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); setCopied("copied"); }
    catch { setCopied("failed"); }
    window.setTimeout(() => setCopied("idle"), 2000);
  };
  return (
    <button className={`ghost-button${className ? ` ${className}` : ""}`} type="button" onClick={() => void copy()} aria-live="polite">
      {copied === "copied" ? <Check size={15} /> : <Copy size={15} />}
      {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : label}
    </button>
  );
}
