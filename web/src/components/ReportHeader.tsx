import type { ReactNode } from "react";
import { PageHeading } from "./PagePrimitives";

export function ReportHeader({
  id,
  eyebrow,
  title,
  batchId,
  coordinator,
  seed,
  ledePrefix,
  actions,
}: {
  id: string;
  eyebrow: string;
  title: string;
  batchId: string;
  coordinator: string;
  seed?: number;
  ledePrefix?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <PageHeading
      id={id}
      eyebrow={eyebrow}
      title={title}
      lede={<>
        {ledePrefix}
        {batchId}
        {" · coordinated by "}
        {coordinator}
        {seed !== undefined && <> · seed {seed}</>}
      </>}
      actions={actions}
    />
  );
}
