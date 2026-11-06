import { partitionBarWidths, type PartitionBreakdown } from "../lib/pdes";

/**
 * Stacked compute/barrier-wait bars per partition. The label column and the
 * trailing detail are shared; `messagesDetail` swaps the compact "x s / y s"
 * for the report layout with messages and KiB, `legend` adds the compute/wait
 * totals line used on the live screens.
 */
export function PartitionTimingList({
  breakdown,
  messagesDetail = false,
  legend = false,
}: {
  breakdown: PartitionBreakdown;
  messagesDetail?: boolean;
  legend?: boolean;
}) {
  return (
    <div className="partition-timing-list">
      {breakdown.rows.map((row, index) => {
        const widths = partitionBarWidths(row.compute, row.wait, breakdown.maxTotal);
        return (
          <div className="partition-timing-row" key={row.id}>
            <strong>{row.id}</strong>
            <div className="partition-time-track" aria-label={`${row.id}: ${row.compute.toFixed(3)} seconds compute, ${row.wait.toFixed(3)} seconds wait`}>
              <span className={`partition-time-compute peer-${index % 6}`} style={{ width: `${widths.compute}%` }} />
              <span className="partition-time-wait" style={{ width: `${widths.wait}%` }} />
            </div>
            <span>
              {row.compute.toFixed(2)}s / {row.wait.toFixed(2)}s
              {messagesDetail && <> · {row.messages.toLocaleString()} msgs · {(row.bytes / 1024).toFixed(1)} KiB</>}
            </span>
          </div>
        );
      })}
      {!breakdown.rows.length && <p className="muted">Partition timing will appear after the first coordination window.</p>}
      {legend && (
        <p className="partition-legend"><i className="partition-time-compute peer-0" /> Compute <i className="partition-time-wait" /> Barrier wait · {breakdown.totalCompute.toFixed(2)}s total compute / {breakdown.totalWait.toFixed(2)}s total wait</p>
      )}
    </div>
  );
}
