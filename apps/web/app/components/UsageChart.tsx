/**
 * Recent weighted-token burn (§10).
 *
 * Hand-rolled SVG rather than a charting library: the whole figure is a few
 * rectangles, and a dependency here would ship a large client bundle for
 * something that renders fine on the server with no JS at all.
 *
 * Accessibility: the bars are aria-hidden decoration and the real content is a
 * data table in a <details>. A bar chart no screen reader can read is not a
 * chart, and the table is also the honest fallback when styles fail to load.
 *
 * §16: buckets carry token COUNTS only. There is no prompt or response text
 * anywhere in this payload, and none may be added.
 */

import { formatTokensCompact, formatTokensExact, formatUtc } from "../lib/format";
import type { UsageSeries } from "../lib/schemas";

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 160;
const BAR_GAP = 2;

export function UsageChart({ usage }: { usage: UsageSeries }) {
  const { buckets, bucketMinutes } = usage;

  if (buckets.length === 0) {
    return <p className="muted">No usage recorded yet.</p>;
  }

  const peak = buckets.reduce((max, bucket) => Math.max(max, bucket.weightedTokens), 0);
  const total = buckets.reduce((sum, bucket) => sum + bucket.weightedTokens, 0);
  const barWidth = VIEW_WIDTH / buckets.length;

  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="muted" style={{ marginBottom: 10 }}>
        {`${buckets.length} buckets of ${bucketMinutes} minutes — ${formatTokensCompact(total)} weighted tokens total, peak ${formatTokensCompact(peak)}.`}
      </figcaption>

      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        width="100%"
        height={VIEW_HEIGHT}
        role="presentation"
        aria-hidden="true"
        focusable="false"
        preserveAspectRatio="none"
      >
        {buckets.map((bucket, index) => {
          // Guard against a zero peak: an all-idle window must not divide by 0.
          const scale = peak > 0 ? bucket.weightedTokens / peak : 0;
          const height = Math.max(scale > 0 ? 2 : 0, scale * (VIEW_HEIGHT - 4));
          return (
            <rect
              key={bucket.at}
              x={index * barWidth}
              y={VIEW_HEIGHT - height}
              width={Math.max(1, barWidth - BAR_GAP)}
              height={height}
              rx={2}
              fill="url(#usage-grad)"
            />
          );
        })}
        <defs>
          <linearGradient id="usage-grad" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#1a73e8" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#49a3f1" />
          </linearGradient>
        </defs>
      </svg>

      <details style={{ marginTop: 12 }}>
        <summary className="muted">Usage as a table</summary>
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="data">
            <caption>Weighted tokens per {bucketMinutes}-minute bucket, UTC.</caption>
            <thead>
              <tr>
                <th scope="col">Bucket start</th>
                <th scope="col" className="num">
                  Weighted tokens
                </th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.at}>
                  <td>{formatUtc(bucket.at)}</td>
                  <td className="num">{formatTokensExact(bucket.weightedTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
