/** 与后端 API 对应的数据类型。 */

export interface Project {
  name: string;
  display_name: string;
  description: string;
  envs: Record<string, string[]>;
  default_timesteps: number;
}

export interface ProjectDetail extends Project {
  xmls: string[];
  entry_xmls: string[];
  jobs: Job[];
}

export type JobStatus = "running" | "stopping" | "finished" | "failed" | "stopped";

export interface Job {
  id: string;
  project: string;
  env: string;
  task: string;
  num_timesteps: number;
  command: string;
  status: JobStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  output_dir: string;
}

export interface JobLog {
  status: JobStatus;
  log: string;
}

export interface Metrics {
  [tag: string]: { steps: number[]; values: number[] };
}

export interface Artifacts {
  checkpoints: { name: string; mtime: number; n_files: number }[];
  onnx: { name: string; size: number; mtime: number }[];
}

export interface GenerateResult {
  env_name: string;
  code: string;
  file: string;
  check_ok: boolean;
  check_output: string;
  diff: string;
  registered: boolean;
}

export interface GeneratedEnv {
  env_name: string;
  file: string;
  mtime: number;
  size: number;
}

export interface PolicyRun {
  run: string;
  env: string;
  files: { name: string; size: number; mtime: number }[];
}

/** 模型广场：聚合全部项目的策略 run */
export interface CheckpointRun extends PolicyRun {
  project: string;
  display_name: string;
  num_timesteps: number;
}

export interface PhasePeriod {
  nb_steps_in_period: number;
}
