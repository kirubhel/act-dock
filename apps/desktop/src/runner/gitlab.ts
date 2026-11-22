import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { AppError } from "../shared/contracts";
import { conditionVariables, evaluateCondition, parseCondition, type Expr, type Variables } from "./gitlab-rules";

/**
 * GitLab CI support. A GitLab pipeline is normalized once into a small model
 * (jobs with resolved scripts, stages turned into explicit `needs`), and that
 * model is turned into a GitHub-style workflow that Act can execute. Discovery,
 * validation, analysis and execution all read the same normalized result, so
 * they cannot disagree about which jobs exist or what they depend on.
 */

/** Events offered for GitLab pipelines, and the Act event each one runs as. */
export const GITLAB_EVENTS: Record<string, string> = {
  push: "push",
  merge_request: "pull_request",
  manual: "workflow_dispatch",
};

export function actEventFor(event: string): string {
  return GITLAB_EVENTS[event] ?? event;
}

/** GitLab's built-in stages, used when a pipeline does not declare `stages`. */
const DEFAULT_STAGES = [".pre", "build", "test", "deploy", ".post"];
const DEFAULT_STAGE = "test";
const RESERVED = new Set([
  "stages",
  "variables",
  "default",
  "include",
  "workflow",
  "image",
  "services",
  "before_script",
  "after_script",
  "cache",
]);
const DEFAULT_KEYS = [
  "before_script",
  "after_script",
  "image",
  "tags",
  "variables",
] as const;
export const DEFAULT_RUNNER = "ubuntu-latest";

type Obj = Record<string, unknown>;

/** One entry of a job's `rules`. `when` unset means "inherit the job's when". */
export type GitLabRule = {
  condition?: Expr;
  text?: string;
  when?: "on_success" | "manual" | "never";
  variables: Record<string, string>;
};

export type GitLabJob = {
  /** Stable id: the job name with characters Act does not accept replaced. */
  id: string;
  /** The job name as written in the pipeline. */
  name: string;
  needs: string[];
  runsOn: string;
  env: Record<string, string>;
  script: string[];
  afterScript: string[];
  allowFailure: boolean;
  container: boolean;
  image?: string;
  /** Conditions evaluated per run by selectPipelineJobs; discovery lists every job. */
  rules?: GitLabRule[];
  when: "on_success" | "manual";
  stageIndex: number;
  /** Declared `needs`, kept apart from stage ordering because an excluded job is an error only for the former. */
  explicitNeeds?: { id: string; optional: boolean }[];
};

export type GitLabPipeline = {
  stages: string[];
  jobs: GitLabJob[];
  /** Pipeline-level `variables`, which rules may read. */
  variables: Record<string, string>;
};

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const SCALARS = ["string", "number", "boolean"];
/** Script-like values: a string or a list of strings. Anything else is an error, never coerced. */
const lines = (v: unknown, key: string): string[] => {
  if (v === undefined || v === null) return [];
  const items = Array.isArray(v) ? v.flat(Infinity) : [v];
  if (!items.every((item) => SCALARS.includes(typeof item)))
    throw new Error(
      `${key} must be a string or a list of strings. Quote commands that contain ": ".`,
    );
  return items.map(String);
};

/** Preserve image identity; unsupported Docker options must never be silently lost. */
function imageName(value: unknown, jobName: string): string | undefined {
  if (value === undefined) return undefined;
  const name = isObj(value) ? value.name : value;
  if (isObj(value) && Object.keys(value).some((key) => key !== "name"))
    throw new Error(`${jobName}.image options are not supported yet. Use an image name only.`);
  if (typeof name !== "string" || !name.trim() || /\$/.test(name))
    throw new Error(`${jobName}.image must be a non-empty literal image name; variable expansion is not supported yet.`);
  return name;
}

const RULE_KEYS = new Set(["if", "when", "variables"]);
function parseRules(name: string, value: unknown): GitLabRule[] {
  if (!Array.isArray(value)) throw new Error(`${name}.rules must be a list.`);
  return value.map((entry, index) => {
    const where = `${name}.rules[${index}]`;
    if (!isObj(entry)) throw new Error(`${where} must be a mapping.`);
    for (const key of Object.keys(entry))
      if (!RULE_KEYS.has(key))
        throw new Error(`${where}.${key} is not supported yet. Rule conditions cannot be ignored; Act Dock supports if, when and variables.`);
    let condition: Expr | undefined;
    if (entry.if !== undefined) {
      if (typeof entry.if !== "string") throw new Error(`${where}.if must be a string.`);
      try { condition = parseCondition(entry.if); }
      catch (e) { throw new Error(`${where}.if is not supported yet: ${e instanceof Error ? e.message : e} (in "${entry.if}").`); }
    }
    if (entry.when !== undefined && !["on_success", "manual", "never"].includes(String(entry.when)))
      throw new Error(`${where}.when=${String(entry.when)} is not supported yet. Job conditions cannot be ignored.`);
    const variables: Record<string, string> = {};
    if (entry.variables !== undefined) {
      if (!isObj(entry.variables)) throw new Error(`${where}.variables must be a mapping.`);
      for (const [k, v] of Object.entries(entry.variables)) {
        if (!SCALARS.includes(typeof v)) throw new Error(`${where}.variables.${k} must be a string, number or boolean.`);
        variables[k] = String(v);
      }
    }
    return { condition, text: typeof entry.if === "string" ? entry.if : undefined, when: entry.when as GitLabRule["when"], variables };
  });
}

/** Child values replace parent values; plain mappings (such as variables) merge. */
function mergeConfig(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] =
      isObj(value) && isObj(base[key])
        ? { ...(base[key] as Obj), ...value }
        : value;
  }
  return out;
}

function resolveJob(
  key: string,
  raw: Obj,
  templates: Map<string, Obj>,
  defaults: Obj,
  chain: string[] = [],
): Obj {
  if (chain.includes(key))
    throw new Error(
      `${[...chain, key].join(" → ")} extends itself. Remove the cycle.`,
    );
  const parents =
    raw.extends === undefined
      ? []
      : Array.isArray(raw.extends)
        ? raw.extends.map(String)
        : [String(raw.extends)];
  let inherited: Obj = {};
  for (const parent of parents) {
    const template = templates.get(parent);
    if (!template)
      throw new Error(`${key} extends ${parent}, which is not defined.`);
    inherited = mergeConfig(
      inherited,
      resolveJob(parent, template, templates, defaults, [...chain, key]),
    );
  }
  const { extends: _extends, ...own } = raw;
  return mergeConfig(mergeConfig(defaults, inherited), own);
}

/** Parse GitLab CI YAML into a normalized pipeline. Throws with a readable reason. */
export function parseGitLabPipeline(raw: string): GitLabPipeline {
  const doc = parseDocument(raw, { uniqueKeys: false });
  if (doc.errors.length)
    throw new Error(doc.errors.map((e) => e.message).join("; "));
  const root = doc.toJS() as unknown;
  if (!isObj(root)) throw new Error("GitLab CI file must contain a mapping.");
  if ("include" in root)
    throw new Error(
      "include is not supported yet. Inline the included jobs into this file.",
    );

  if (isObj(root.workflow) && root.workflow.rules !== undefined)
    throw new Error("workflow.rules is not supported yet. Pipeline conditions cannot be ignored.");

  const stages =
    root.stages === undefined
      ? DEFAULT_STAGES
      : lines(root.stages, "stages");
  if (stages.length === 0) throw new Error("stages must not be empty.");

  const defaults: Obj = {};
  if (isObj(root.default))
    for (const k of DEFAULT_KEYS)
      if (root.default[k] !== undefined) defaults[k] = root.default[k];
  for (const k of ["before_script", "after_script", "image"] as const)
    if (root[k] !== undefined && defaults[k] === undefined)
      defaults[k] = root[k];
  const globalVariables = isObj(root.variables) ? root.variables : {};

  const templates = new Map<string, Obj>();
  const declared = new Map<string, Obj>();
  for (const [key, value] of Object.entries(root)) {
    if (RESERVED.has(key) || !isObj(value)) continue;
    if (key.startsWith(".")) templates.set(key, value);
    else declared.set(key, value);
  }

  const ids = new Map<string, string>(); // id -> job name
  const resolved = new Map<string, Obj>();
  for (const [name, raw] of declared) {
    const job = resolveJob(name, raw, templates, defaults);
    if (job.trigger !== undefined)
      throw new Error(`${name} is a trigger job, which is not supported yet.`);
    for (const key of ["only", "except"])
      if (job[key] !== undefined)
        throw new Error(`${name}.${key} is not supported yet. Job conditions cannot be ignored. Use rules instead.`);
    if (job.when !== undefined && job.when !== "on_success" && job.when !== "manual")
      throw new Error(`${name}.when=${String(job.when)} is not supported yet. Job conditions cannot be ignored.`);
    const id = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (ids.has(id))
      throw new Error(
        `Jobs "${ids.get(id)}" and "${name}" map to the same id. Rename one of them.`,
      );
    ids.set(id, name);
    resolved.set(name, job);
  }

  const stageIndex = (name: string, job: Obj) => {
    const stage = job.stage === undefined ? DEFAULT_STAGE : String(job.stage);
    const index = stages.indexOf(stage);
    if (index < 0)
      throw new Error(
        `${name} uses stage "${stage}", which is not listed in stages.`,
      );
    return index;
  };

  const jobs: GitLabJob[] = [];
  for (const [name, job] of resolved) {
    const script = lines(job.script, `${name}.script`);
    if (script.length === 0)
      throw new Error(`${name} has no script. Add script to the job or its parent.`);
    const needs: string[] = [];
    let explicitNeeds: GitLabJob["explicitNeeds"];
    if (job.needs !== undefined) {
      explicitNeeds = [];
      // An explicit `needs` replaces stage ordering for this job, as in GitLab.
      const list = Array.isArray(job.needs) ? job.needs : [job.needs];
      for (const item of list) {
        const dep = typeof item === "string" ? item : isObj(item) ? item.job : undefined;
        if (typeof dep !== "string")
          throw new Error(`${name} has an invalid needs entry.`);
        if (isObj(item) && (item.project || item.pipeline))
          throw new Error(`${name} needs a job from another pipeline, which is not supported yet.`);
        const optional = isObj(item) && item.optional === true;
        if (!resolved.has(dep)) {
          if (optional) continue;
          throw new Error(`${name} needs ${dep}, which is not a job in this pipeline.`);
        }
        needs.push(dep.replace(/[^a-zA-Z0-9_-]/g, "_"));
        explicitNeeds.push({ id: dep.replace(/[^a-zA-Z0-9_-]/g, "_"), optional });
      }
    } else {
      const mine = stageIndex(name, job);
      for (const [other, otherJob] of resolved)
        if (other !== name && stageIndex(other, otherJob) < mine)
          needs.push(other.replace(/[^a-zA-Z0-9_-]/g, "_"));
    }
    const tags = lines(job.tags, `${name}.tags`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({
      ...globalVariables,
      ...(isObj(job.variables) ? job.variables : {}),
    }))
      if (["string", "number", "boolean"].includes(typeof v)) env[k] = String(v);
    jobs.push({
      id: name.replace(/[^a-zA-Z0-9_-]/g, "_"),
      name,
      needs: [...new Set(needs)],
      runsOn: tags[0] || DEFAULT_RUNNER,
      env,
      script: [...lines(job.before_script, `${name}.before_script`), ...script],
      afterScript: lines(job.after_script, `${name}.after_script`),
      allowFailure: job.allow_failure === true,
      container: job.image !== undefined,
      image: imageName(job.image, name),
      ...(job.rules !== undefined ? { rules: parseRules(name, job.rules) } : {}),
      when: job.when === "manual" ? "manual" : "on_success",
      stageIndex: stageIndex(name, job),
      ...(explicitNeeds ? { explicitNeeds } : {}),
    });
  }

  const byId = new Map(jobs.map((j) => [j.id, j]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting")
      throw new Error(`Job ${id} depends on itself through needs. Remove the cycle.`);
    state.set(id, "visiting");
    for (const dep of byId.get(id)!.needs) visit(dep);
    state.set(id, "done");
  };
  jobs.forEach((j) => visit(j.id));

  const variables: Record<string, string> = {};
  for (const [k, v] of Object.entries(globalVariables)) if (SCALARS.includes(typeof v)) variables[k] = String(v);
  return { stages, jobs, variables };
}

/** What GitLab would know when it creates the pipeline: the event, branches and the variables derived from them. */
export type PipelineContext = {
  event: string;
  branch?: string;
  sourceBranch?: string;
  targetBranch?: string;
};

/** Inputs a run can set to choose which rules match. They are never passed to Act as workflow inputs. */
export const CI_CONTEXT_INPUTS = [
  "CI_COMMIT_BRANCH",
  "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME",
  "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
] as const;
export const DEFAULT_TARGET_BRANCH = "main";

/** The checked-out branch, or undefined on a detached HEAD or outside a repository. */
export function currentBranch(projectPath: string): string | undefined {
  try {
    // symbolic-ref also works before the first commit, and fails (empty) on a detached HEAD.
    const r = Bun.spawnSync(["git", "symbolic-ref", "--short", "-q", "HEAD"], { cwd: projectPath, stdout: "pipe", stderr: "ignore" });
    return (r.exitCode === 0 ? r.stdout.toString().trim() : "") || undefined;
  } catch {
    return undefined;
  }
}

export function pipelineContext(projectPath: string, event: string, inputs: Record<string, string> = {}): PipelineContext {
  const branch = currentBranch(projectPath);
  const pick = (key: string, fallback?: string) => inputs[key]?.trim() || fallback;
  return {
    event,
    branch: pick("CI_COMMIT_BRANCH", branch),
    sourceBranch: pick("CI_MERGE_REQUEST_SOURCE_BRANCH_NAME", branch),
    targetBranch: pick("CI_MERGE_REQUEST_TARGET_BRANCH_NAME", DEFAULT_TARGET_BRANCH),
  };
}

/** Predefined variables for the context. Merge request pipelines have no CI_COMMIT_BRANCH, as in GitLab. */
export function contextVariables(ctx: PipelineContext): Variables {
  const v = (value: string | undefined) => value ?? null;
  if (ctx.event === "merge_request")
    return {
      CI_PIPELINE_SOURCE: "merge_request_event", CI_COMMIT_BRANCH: null, CI_COMMIT_TAG: null,
      CI_COMMIT_REF_NAME: v(ctx.sourceBranch),
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: v(ctx.sourceBranch),
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: v(ctx.targetBranch),
    };
  return {
    CI_PIPELINE_SOURCE: ctx.event === "manual" ? "web" : "push",
    CI_COMMIT_BRANCH: v(ctx.branch), CI_COMMIT_REF_NAME: v(ctx.branch), CI_COMMIT_TAG: null,
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: null, CI_MERGE_REQUEST_TARGET_BRANCH_NAME: null,
  };
}

const describeContext = (ctx: PipelineContext) =>
  ctx.event === "merge_request"
    ? `a merge request from ${ctx.sourceBranch || "?"} into ${ctx.targetBranch || "?"}`
    : `${ctx.event === "manual" ? "a manual run" : "a push"} on ${ctx.branch || "no branch"}`;

export type SelectedPipeline = {
  jobs: GitLabJob[];
  skipped: { name: string; reason: string }[];
};

/**
 * Applies `rules` and `when: manual` for one run, as GitLab does when it creates a pipeline:
 * the first matching rule decides, a job with rules that none match is not added, and rule variables
 * override job variables. A whole-pipeline run leaves out manual jobs, and jobs that explicitly need one,
 * because nobody has played them. Running one job by id runs it with everything it needs, manual or not.
 * Throws a readable reason when the answer cannot be trusted (an unknown variable, a needed job that is excluded).
 */
export function selectPipelineJobs(pipeline: GitLabPipeline, ctx: PipelineContext, jobId?: string): SelectedPipeline {
  const predefined = contextVariables(ctx);
  const vars: Variables = { ...pipeline.variables, ...predefined };
  const known = new Set([...Object.keys(pipeline.variables), ...Object.keys(predefined)]);
  const where = describeContext(ctx);
  type Decision = { job: GitLabJob; included: boolean; manual: boolean; env: Record<string, string>; reason?: string };
  const injected = Object.fromEntries(Object.entries(predefined).filter((e): e is [string, string] => e[1] !== null && e[1] !== ""));
  const decide = (job: GitLabJob): Decision => {
    const base = { job, env: { ...injected, ...job.env } };
    if (!job.rules) return { ...base, included: true, manual: job.when === "manual" };
    for (const rule of job.rules) {
      if (rule.condition) {
        for (const name of conditionVariables(rule.condition))
          if (!known.has(name))
            throw new Error(`${job.name}: the rule "${rule.text}" uses $${name}, which Act Dock cannot know when running locally. Define it under variables: in the file.`);
        if (!evaluateCondition(rule.condition, vars)) continue;
      }
      const when = rule.when ?? job.when;
      if (when === "never") return { ...base, included: false, manual: false, reason: `a rule says never for ${where}` };
      return { ...base, env: { ...base.env, ...rule.variables }, included: true, manual: when === "manual" };
    }
    return { ...base, included: false, manual: false, reason: `no rule matches ${where}` };
  };
  const decisions = pipeline.jobs.map(decide);
  const byId = new Map(decisions.map((d) => [d.job.id, d]));
  const active = decisions.filter((d) => d.included);

  /** Dependencies of an included job among the included ones. Stage ordering ignores manual jobs, which do not hold up later stages. */
  const needsOf = (d: Decision): string[] => {
    if (d.job.explicitNeeds) {
      const ids: string[] = [];
      for (const need of d.job.explicitNeeds) {
        const dep = byId.get(need.id);
        if (dep?.included) ids.push(need.id);
        else if (!need.optional)
          throw new Error(`${d.job.name} needs ${dep?.job.name ?? need.id}, but its rules exclude it for ${where}. Choose an event or branch where both run.`);
      }
      return ids;
    }
    return active.filter((o) => o.job.id !== d.job.id && !o.manual && o.job.stageIndex < d.job.stageIndex).map((o) => o.job.id);
  };

  const skipped: SelectedPipeline["skipped"] = decisions.filter((d) => !d.included).map((d) => ({ name: d.job.name, reason: d.reason! }));
  let run: Set<string>;
  if (jobId) {
    const target = byId.get(jobId);
    if (!target) throw new Error(`Job ${jobId} is not in this pipeline.`);
    if (!target.included) throw new Error(`${target.job.name} is excluded by its rules for ${where}. Choose an event or branch where it runs.`);
    run = new Set();
    const visit = (d: Decision) => {
      if (run.has(d.job.id)) return;
      run.add(d.job.id);
      for (const id of needsOf(d)) visit(byId.get(id)!);
    };
    visit(target);
  } else {
    run = new Set(active.filter((d) => !d.manual).map((d) => d.job.id));
    // A job that explicitly needs a manual job waits for it, and so does everything that needs that job.
    for (let changed = true; changed;) {
      changed = false;
      for (const d of active) {
        if (!run.has(d.job.id)) continue;
        if (needsOf(d).some((id) => !run.has(id))) { run.delete(d.job.id); changed = true; }
      }
    }
    for (const d of active) if (!run.has(d.job.id))
      skipped.push({ name: d.job.name, reason: d.manual ? "manual job; run it by itself to play it" : "waits for a manual job" });
  }
  const jobs = decisions.filter((d) => run.has(d.job.id)).map((d) => ({
    ...d.job, env: d.env, needs: needsOf(d).filter((id) => run.has(id)),
  }));
  if (jobs.length === 0) throw new Error(`No job runs for ${where}: every job is excluded by its rules or waits for a manual run.`);
  return { jobs, skipped };
}

/** The GitHub-style workflow Act runs for a normalized GitLab pipeline. */
export function buildGitLabWorkflow(pipeline: GitLabPipeline, name: string) {
  const jobs: Obj = {};
  for (const job of pipeline.jobs) {
    const steps: Obj[] = [
      { name: job.name, shell: job.image ? "sh" : "bash", run: job.script.join("\n") },
    ];
    if (job.afterScript.length > 0)
      steps.push({
        name: `${job.name} (after_script)`,
        if: "always()",
        "continue-on-error": true,
        shell: job.image ? "sh" : "bash",
        run: job.afterScript.join("\n"),
      });
    jobs[job.id] = {
      name: job.name,
      "runs-on": job.runsOn,
      ...(job.image ? { container: { image: job.image } } : {}),
      ...(job.needs.length > 0 ? { needs: job.needs } : {}),
      ...(job.allowFailure ? { "continue-on-error": true } : {}),
      ...(Object.keys(job.env).length > 0 ? { env: job.env } : {}),
      steps,
    };
  }
  return {
    name: `GitLab CI: ${name}`,
    on: { push: {}, pull_request: {}, workflow_dispatch: {} },
    jobs,
  };
}

/** Read a GitLab CI file from disk and normalize it. The path must already be validated. */
export function readGitLabPipeline(fullPath: string): GitLabPipeline {
  return parseGitLabPipeline(readFileSync(fullPath, "utf8"));
}

/**
 * Write the normalized pipeline for `relPath` into the project's `.act-dock`
 * folder and return that file, which is what Act is pointed at. The file name
 * is derived from the source path so several GitLab files never overwrite
 * each other.
 */
export function materializeGitLabWorkflow(
  projectPath: string,
  relPath: string,
  run: { event: string; inputs?: Record<string, string>; jobId?: string } = { event: "push" },
): string {
  let pipeline: GitLabPipeline;
  try {
    const parsed = readGitLabPipeline(join(projectPath, relPath));
    pipeline = { ...parsed, jobs: selectPipelineJobs(parsed, pipelineContext(projectPath, run.event, run.inputs), run.jobId).jobs };
  } catch (e) {
    throw new AppError(
      "INVALID_WORKFLOW",
      e instanceof Error ? e.message : String(e),
    );
  }
  const name = relPath.split("/").pop() || relPath;
  const digest = createHash("sha256").update(relPath).digest("hex").slice(0, 12);
  const outDir = join(projectPath, ".act-dock/workflows");
  mkdirSync(outDir, { recursive: true });
  // Different events and branches select different jobs, so each selection gets its own file.
  const selection = createHash("sha256").update(JSON.stringify(pipeline.jobs)).digest("hex").slice(0, 8);
  const out = join(outDir, `gitlab-${digest}-${selection}.yml`);
  writeFileSync(
    out,
    stringify(buildGitLabWorkflow(pipeline, name), { lineWidth: 0 }),
    "utf8",
  );
  return out;
}
