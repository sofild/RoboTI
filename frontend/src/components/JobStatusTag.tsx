import { Tag } from "antd";
import type { JobStatus } from "../types";

const conf: Record<JobStatus, { color: string; text: string }> = {
  running: { color: "processing", text: "运行中" },
  stopping: { color: "processing", text: "停止中" },
  finished: { color: "success", text: "已完成" },
  failed: { color: "error", text: "失败" },
  stopped: { color: "warning", text: "已停止" },
};

export default function JobStatusTag({ status }: { status: JobStatus }) {
  const c = conf[status] ?? { color: "default", text: status };
  return <Tag color={c.color}>{c.text}</Tag>;
}
