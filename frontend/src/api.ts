import type {
  Artifacts, CheckpointRun, GenerateResult, GeneratedEnv, Job, JobLog, Metrics, PhasePeriod, PolicyRun,
  Project, ProjectDetail,
} from "./types";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) msg = body.detail;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  listProjects: () => json<Project[]>("/api/projects"),
  listAllCheckpoints: () => json<CheckpointRun[]>("/api/checkpoints"),
  getProject: (name: string) => json<ProjectDetail>(`/api/projects/${name}`),
  startTraining: (name: string, body: { env: string; task: string; num_timesteps: number }) =>
    json<Job>(`/api/projects/${name}/train`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  listJobs: (project?: string) =>
    json<Job[]>(`/api/jobs${project ? `?project=${project}` : ""}`),
  getJob: (id: string) => json<Job>(`/api/jobs/${id}`),
  getJobLog: (id: string, tail = 300) => json<JobLog>(`/api/jobs/${id}/log?tail=${tail}`),
  stopJob: (id: string) => json<Job>(`/api/jobs/${id}/stop`, { method: "POST" }),
  getJobMetrics: (id: string) => json<Metrics>(`/api/jobs/${id}/metrics`),
  getJobArtifacts: (id: string) => json<Artifacts>(`/api/jobs/${id}/artifacts`),
  copilotGenerate: (name: string, body: { requirement: string; env_name_hint?: string }) =>
    json<GenerateResult>(`/api/projects/${name}/copilot/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  copilotList: (name: string) => json<GeneratedEnv[]>(`/api/projects/${name}/copilot/generated`),
  copilotRead: (name: string, env: string) =>
    json<{ env_name: string; code: string }>(`/api/projects/${name}/copilot/generated/${env}`),
  copilotDelete: (name: string, env: string) =>
    json<{ ok: boolean }>(`/api/projects/${name}/copilot/generated/${env}`, { method: "DELETE" }),
  listPolicyRuns: (name: string) =>
    json<PolicyRun[]>(`/api/projects/${name}/policy/checkpoints`),
  policyOnnxUrl: (name: string, run: string, file: string) =>
    `/api/projects/${name}/policy/onnx/${run}/${file}`,
  getPhasePeriod: (name: string) =>
    json<PhasePeriod>(`/api/projects/${name}/policy/phase-period`),
  uploadPolicyOnnx: (name: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return json<{ ok: boolean; run: string; file: string }>(
      `/api/projects/${name}/policy/upload`,
      { method: "POST", body: fd },
    );
  },
};
