"use client";

/**
 * 24h request-volume chart (DESIGN.md §3: gradient area fills, low-opacity
 * grid).
 *
 * Client component because recharts renders to SVG in the browser.
 *
 * Accessibility: an SVG chart is not readable by a screen reader, so the same
 * data is ALSO rendered as a real <table> in the page, and this chart is marked
 * aria-hidden. That is the reliable pattern — an aria-label on a chart conveys
 * nothing about the values.
 */

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TimeseriesPoint } from "../lib/schemas";

export function TrafficChart({ series }: { series: TimeseriesPoint[] }) {
  const data = series.map((point) => ({
    hour: point.at.slice(11, 16),
    requests: point.requests,
    errors: point.errors,
  }));

  return (
    <>
      <div className="chart-wrap" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              {/* Fade from --info toward transparent, per DESIGN.md §3. */}
              <linearGradient id="fillRequests" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#21d4fd" stopOpacity={0.55} />
                <stop offset="100%" stopColor="#0075ff" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="fillErrors" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#e31a1a" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#e31a1a" stopOpacity={0.02} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke="rgba(255,255,255,0.07)" vertical={false} />
            <XAxis
              dataKey="hour"
              stroke="#718096"
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              interval={3}
            />
            <YAxis
              stroke="#718096"
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={44}
            />
            <Tooltip
              contentStyle={{
                background: "#060b28",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 12,
                fontSize: 12,
              }}
              labelStyle={{ color: "#a0aec0" }}
            />
            <Area
              type="monotone"
              dataKey="requests"
              stroke="#21d4fd"
              strokeWidth={2}
              fill="url(#fillRequests)"
              name="Requests"
            />
            <Area
              type="monotone"
              dataKey="errors"
              stroke="#e31a1a"
              strokeWidth={2}
              fill="url(#fillErrors)"
              name="Errors"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="legend" aria-hidden="true">
        <span>
          <span className="legend-swatch" style={{ background: "#21d4fd" }} />
          Requests
        </span>
        <span>
          <span className="legend-swatch" style={{ background: "#e31a1a" }} />
          Errors
        </span>
      </div>
    </>
  );
}
