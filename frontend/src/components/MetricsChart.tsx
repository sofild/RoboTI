import { useMemo, useState } from "react";
import { Checkbox, Empty, Row, Col } from "antd";
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { Metrics } from "../types";

const PALETTE = ["#13c2c2", "#f5a623", "#b37feb", "#ff7a45", "#5cdbd3", "#ff85c0", "#a0d911"];

/** 训练指标多曲线图，tag 通过勾选框选择（默认选中 reward 主指标）。 */
export default function MetricsChart({ metrics }: { metrics: Metrics }) {
  const tags = useMemo(() => Object.keys(metrics).sort(), [metrics]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 首次加载时默认选中 reward 相关 tag
  const active = useMemo(() => {
    if (selected.size > 0) return selected;
    const defaults = tags.filter((t) => /reward/.test(t) && !/std|clip|ratio/.test(t));
    return new Set(defaults.length ? defaults : tags.slice(0, 1));
  }, [tags, selected]);

  const data = useMemo(() => {
    // 以步数最多的选中 tag 为 x 轴基准，合并各 tag
    const useTags = tags.filter((t) => active.has(t));
    if (!useTags.length) return [];
    const base = useTags.reduce((a, b) =>
      metrics[a].steps.length >= metrics[b].steps.length ? a : b,
    );
    const rows: Record<string, number>[] = metrics[base].steps.map((s, i) => ({ step: s, [base]: metrics[base].values[i] }));
    for (const t of useTags) {
      if (t === base) continue;
      let j = 0;
      for (let i = 0; i < rows.length; i++) {
        while (j < metrics[t].steps.length && metrics[t].steps[j] < rows[i].step) j++;
        if (j < metrics[t].steps.length && metrics[t].steps[j] === rows[i].step) {
          rows[i][t] = metrics[t].values[j];
        }
      }
    }
    return rows;
  }, [metrics, tags, active]);

  if (!tags.length) return <Empty description="暂无指标数据（训练尚未产生事件）" />;

  const toggle = (t: string) => {
    const s = new Set(selected.size ? selected : active);
    if (s.has(t)) s.delete(t); else s.add(t);
    setSelected(s);
  };

  return (
    <div>
      <Row gutter={[8, 8]} style={{ marginBottom: 12, maxHeight: 120, overflow: "auto" }}>
        {tags.map((t) => (
          <Col key={t}>
            <Checkbox
              checked={active.has(t)}
              onChange={() => toggle(t)}
              style={{ color: "#ccc" }}
            >
              {t}
            </Checkbox>
          </Col>
        ))}
      </Row>
      <div style={{ width: "100%", height: 360 }}>
        <ResponsiveContainer>
          <LineChart data={data}>
            <CartesianGrid stroke="#333" strokeDasharray="3 3" />
            <XAxis dataKey="step" stroke="#999" tick={{ fontSize: 11 }} />
            <YAxis stroke="#999" tick={{ fontSize: 11 }} />
            <Tooltip
              contentStyle={{ background: "#1f1f1f", border: "1px solid #444" }}
              labelStyle={{ color: "#ccc" }}
            />
            <Legend />
            {tags.filter((t) => active.has(t)).map((t, i) => (
              <Line
                key={t}
                type="monotone"
                dataKey={t}
                dot={false}
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth={1.6}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
