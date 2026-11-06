import type { ReactNode } from "react";

// Shared page shell primitives. Every page composes the same blocks; these
// components are the single DOM shape for each so CSS can lean on them.
// Visual styling lives in style.css (.page-heading, .notice, .section-title, ...).

/** Standard page header: small caps eyebrow, h1 title, optional lede, optional right-side actions (wrapped in .heading-actions unless actionsWrap is false and the caller renders its own wrapper). actionsLive puts aria-live on the actions wrapper. */
export function PageHeading({
  id,
  eyebrow,
  title,
  lede,
  actions,
  actionsWrap = true,
  actionsLive,
}: {
  id: string;
  eyebrow: string;
  title: string;
  lede?: ReactNode;
  actions?: ReactNode;
  actionsWrap?: boolean;
  actionsLive?: "polite" | "assertive";
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 id={id}>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {actions && (actionsWrap
        ? <div className="heading-actions" {...(actionsLive ? { "aria-live": actionsLive } : {})}>{actions}</div>
        : actions)}
    </div>
  );
}

/** Standalone section header outside a panel: h2 + muted note + optional action. */
export function SectionTitle({
  title,
  note,
  action,
  className,
}: {
  title: string;
  note?: ReactNode;
  /** Right-side control, e.g. a show/hide disclosure button. */
  action?: ReactNode;
  className?: string;
}) {
  const noteNode = note !== undefined
    && (typeof note === "string" || typeof note === "number" ? <span>{note}</span> : note);
  return (
    <div className={`section-title${className ? ` ${className}` : ""}`}>
      <h2>{title}</h2>
      {action !== undefined
        ? <div className="section-title-end">{noteNode}{action}</div>
        : noteNode}
    </div>
  );
}

/** Header inside a panel: h2 + muted note, baseline aligned. */
export function PanelTitle({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <div className="panel-title">
      <h2>{title}</h2>
      {note && <span>{note}</span>}
    </div>
  );
}

type NoticeKind = "error" | "warning" | "info";

/** Inline message banner. Errors are role="alert", everything else role="status". */
export function Notice({
  kind,
  children,
  className,
}: {
  kind: NoticeKind;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`notice notice-${kind}${className ? ` ${className}` : ""}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

/** Dashed-border placeholder with icon, bold title, muted body. */
export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty-state${className ? ` ${className}` : ""}`}>
      {icon}
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/** Centered spinner line while data loads. */
export function LoadingState({ children }: { children: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" />
      {children}
    </div>
  );
}

export type StatItem = {
  /** Small muted label above the value. */
  label: ReactNode;
  /** Primary stat value. */
  value: ReactNode;
  /** Muted annotation rendered after the value inside the same dd. */
  small?: ReactNode;
  /** Extra row under the value (styled by the variant, e.g. <em>). */
  note?: ReactNode;
  /** Span the full strip width (meta params rows). */
  wide?: boolean;
  /** Tone classes for value coloring (count-warn / count-bad style hooks live with the variant). */
  tone?: "warn" | "bad";
  /** Extra class on the item wrapper. */
  className?: string;
  /** Extra class on the dd element (e.g. "time-value"). */
  valueClassName?: string;
};

/**
 * Horizontal stat strip. Replaces the five hand-rolled variants
 * (summary-strip, meta-strip, traffic-tiles, pdes-summary-grid, attack-metrics)
 * with one DOM shape; `variant` keeps each page's original look via CSS modifiers.
 */
export function StatStrip({
  items,
  variant,
  className,
  extra,
  live,
}: {
  items: StatItem[];
  variant: "summary" | "meta" | "tiles" | "pdes" | "soc";
  className?: string;
  /** Trailing node inside the strip (e.g. the cluster refresh-state chip). */
  extra?: ReactNode;
  live?: boolean;
}) {
  return (
    <dl
      className={`stat-strip stat-strip--${variant}${className ? ` ${className}` : ""}`}
      {...(live ? { "aria-live": "polite" as const } : {})}
    >
      {items.map((item, index) => (
        <div
          className={`stat-item${item.wide ? " stat-wide" : ""}${item.tone ? ` tone-${item.tone}` : ""}${item.className ? ` ${item.className}` : ""}`}
          key={index}
        >
          <dt>{item.label}</dt>
          <dd className={item.valueClassName}>
            {item.value}
            {item.small !== undefined && <small>{item.small}</small>}
          </dd>
          {item.note !== undefined && item.note}
        </div>
      ))}
      {extra}
    </dl>
  );
}
