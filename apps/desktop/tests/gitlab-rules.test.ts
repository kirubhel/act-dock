import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { evaluateCondition, parseCondition } from "../src/runner/gitlab-rules";
import { parseGitLabPipeline, selectPipelineJobs, type PipelineContext } from "../src/runner/gitlab";
import { analyzeWorkflow } from "../src/runner/workflow-analysis";
import { commandArgs, discover, validateRun } from "../src/runner/workflows";
import { runRequestSchema, type Project } from "../src/shared/contracts";

const check = (expression: string, vars: Record<string, string | null>) => evaluateCondition(parseCondition(expression), vars);

describe("rules:if expressions", () => {
  test.each([
    ['$CI_COMMIT_BRANCH == "main"', { CI_COMMIT_BRANCH: "main" }, true],
    ['$CI_COMMIT_BRANCH == "main"', { CI_COMMIT_BRANCH: "dev" }, false],
    ["$CI_COMMIT_BRANCH == 'main'", { CI_COMMIT_BRANCH: "main" }, true],
    ['$CI_COMMIT_BRANCH != "main"', { CI_COMMIT_BRANCH: "dev" }, true],
    ["$CI_COMMIT_BRANCH =~ /^dev/", { CI_COMMIT_BRANCH: "dev-v0.2.0" }, true],
    ["$CI_COMMIT_BRANCH =~ /^dev/", { CI_COMMIT_BRANCH: "feature/dev" }, false],
    ["$CI_COMMIT_BRANCH !~ /^dev/", { CI_COMMIT_BRANCH: "main" }, true],
    ["$CI_COMMIT_BRANCH =~ /^DEV/i", { CI_COMMIT_BRANCH: "dev-1" }, true],
    ["$CI_COMMIT_BRANCH =~ /^feature\\/x$/", { CI_COMMIT_BRANCH: "feature/x" }, true],
    ["$CI_COMMIT_BRANCH", { CI_COMMIT_BRANCH: "main" }, true],
    ["$CI_COMMIT_BRANCH", { CI_COMMIT_BRANCH: null }, false],
    ["$CI_COMMIT_BRANCH", { CI_COMMIT_BRANCH: "" }, false],
    ["$CI_COMMIT_BRANCH == null", { CI_COMMIT_BRANCH: null }, true],
    ["$CI_COMMIT_BRANCH == null", { CI_COMMIT_BRANCH: "" }, true],
    ["$CI_COMMIT_BRANCH != null", { CI_COMMIT_BRANCH: "main" }, true],
    ['$CI_COMMIT_BRANCH == "main"', { CI_COMMIT_BRANCH: null }, false],
    ['$CI_COMMIT_BRANCH =~ /^dev/', { CI_COMMIT_BRANCH: null }, false],
    ['$A == $B', { A: "x", B: "x" }, true],
    ['$A =~ /^dev/ || $A == "test"', { A: "test" }, true],
    ['($A == "a" || $A == "b") && $B == "1"', { A: "b", B: "1" }, true],
    ['($A == "a" || $A == "b") && $B == "1"', { A: "b", B: "2" }, false],
  ])("%s with %j is %p", (expression, vars, expected) => {
    expect(check(expression, vars)).toBe(expected);
  });

  test("&& binds tighter than ||, as in GitLab", () => {
    // true || (false && false) is true; (true || false) && false would be false.
    expect(check('$A == "1" || $B == "1" && $C == "1"', { A: "1", B: "0", C: "0" })).toBe(true);
  });

  test.each([
    ["$A =~ $B", "regex"],
    ['$A == "x" &&', "expected"],
    ['$A == "x', "unterminated"],
    ["!$A", "unsupported syntax"],
    ['$A == "x" "y"', "unexpected"],
    ["($A == 'x'", "missing )"],
    ["$A =~ /(/", "invalid regular expression"],
    ["", "expected"],
  ])("rejects %j", (expression, message) => {
    expect(() => parseCondition(expression)).toThrow(message);
  });
});

const PIPELINE = `stages: [.pre, build, deploy]
variables:
  APP: demo
validate:branch-flow:
  stage: .pre
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
  script: echo "$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME into $CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
build:image:
  stage: build
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      variables:
        TAG: latest
    - if: '$CI_COMMIT_BRANCH =~ /^dev/'
      variables:
        TAG: dev
  script: echo build $TAG
deploy:production:
  stage: deploy
  needs: [build:image]
  when: manual
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
  script: echo prod
notify:
  stage: deploy
  needs: [deploy:production]
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
  script: echo notify
`;
const select = (ctx: Partial<PipelineContext> & { event: string }, jobId?: string, yaml = PIPELINE) =>
  selectPipelineJobs(parseGitLabPipeline(yaml), ctx, jobId);
const ids = (r: { jobs: { id: string }[] }) => r.jobs.map((j) => j.id);

describe("rule selection", () => {
  test("a push on main runs build with its rule variables, and leaves manual work for a manual run", () => {
    const r = select({ event: "push", branch: "main" });
    expect(ids(r)).toEqual(["build_image"]);
    expect(r.jobs[0].env).toMatchObject({ TAG: "latest", APP: "demo", CI_COMMIT_BRANCH: "main", CI_PIPELINE_SOURCE: "push" });
    expect(r.skipped).toEqual([
      { name: "validate:branch-flow", reason: "no rule matches a push on main" },
      { name: "deploy:production", reason: "manual job; run it by itself to play it" },
      { name: "notify", reason: "waits for a manual job" },
    ]);
  });

  test("the first matching rule decides, so another branch gets its own variables", () => {
    expect(select({ event: "push", branch: "dev-v0.2.0" }).jobs[0].env.TAG).toBe("dev");
  });

  test("a merge request run sees merge request variables and no CI_COMMIT_BRANCH", () => {
    const r = select({ event: "merge_request", sourceBranch: "feature/x", targetBranch: "dev-v0.2.0", branch: "feature/x" });
    expect(ids(r)).toEqual(["validate_branch-flow"]);
    expect(r.jobs[0].env).toMatchObject({
      CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature/x", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev-v0.2.0",
    });
    expect(r.jobs[0].env).not.toHaveProperty("CI_COMMIT_BRANCH");
  });

  test("running one manual job plays it with the jobs it needs", () => {
    const r = select({ event: "push", branch: "main" }, "deploy_production");
    expect(ids(r)).toEqual(["build_image", "deploy_production"]);
    expect(r.jobs[1].needs).toEqual(["build_image"]);
  });

  test("running a job its rules exclude is explained, not run anyway", () => {
    expect(() => select({ event: "push", branch: "dev-1" }, "deploy_production")).toThrow("excluded by its rules for a push on dev-1");
  });

  test("a needed job that the rules exclude is an error, as in GitLab", () => {
    const yaml = `build:
  rules: [{if: '$CI_COMMIT_BRANCH == "main"'}]
  script: make
deploy:
  needs: [build]
  rules: [{if: '$CI_COMMIT_BRANCH == "test"'}]
  script: make deploy
`;
    expect(() => select({ event: "push", branch: "test" }, undefined, yaml)).toThrow("deploy needs build, but its rules exclude it");
    const optional = yaml.replace("needs: [build]", "needs:\n    - job: build\n      optional: true");
    expect(ids(select({ event: "push", branch: "test" }, undefined, optional))).toEqual(["deploy"]);
  });

  test("when never, a rule without if, and a rule-level manual", () => {
    const yaml = `skipme:
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      when: never
    - when: on_success
  script: echo a
play:
  rules:
    - when: manual
  script: echo b
always:
  rules:
    - if: '$CI_COMMIT_BRANCH'
  script: echo c
`;
    expect(ids(select({ event: "push", branch: "main" }, undefined, yaml))).toEqual(["always"]);
    expect(ids(select({ event: "push", branch: "dev" }, undefined, yaml))).toEqual(["skipme", "always"]);
    expect(select({ event: "push", branch: "dev" }, undefined, yaml).skipped).toEqual([
      { name: "play", reason: "manual job; run it by itself to play it" },
    ]);
  });

  test("manual jobs do not hold up later stages", () => {
    const yaml = `stages: [build, deploy]
gate:
  stage: build
  when: manual
  script: echo gate
ship:
  stage: deploy
  script: echo ship
`;
    expect(ids(select({ event: "push", branch: "main" }, undefined, yaml))).toEqual(["ship"]);
    expect(select({ event: "push", branch: "main" }, undefined, yaml).jobs[0].needs).toEqual([]);
  });

  test("a variable Act Dock cannot know is an error instead of a guess", () => {
    const yaml = "job:\n  rules: [{if: '$SECRET_FLAG == \"1\"'}]\n  script: echo hi\n";
    expect(() => select({ event: "push", branch: "main" }, undefined, yaml)).toThrow("$SECRET_FLAG");
    const defined = "variables:\n  SECRET_FLAG: '1'\n" + yaml;
    expect(ids(select({ event: "push", branch: "main" }, undefined, defined))).toEqual(["job"]);
  });

  test("when every job is excluded the run says why", () => {
    expect(() => select({ event: "merge_request", sourceBranch: "a", targetBranch: "b" }, undefined,
      "job:\n  rules: [{if: '$CI_COMMIT_BRANCH == \"main\"'}]\n  script: echo hi\n")).toThrow("No job runs for a merge request from a into b");
  });

  test.each([
    ["changes", "rules: [{if: '$CI_COMMIT_BRANCH', changes: ['src/**']}]"],
    ["exists", "rules: [{exists: ['Dockerfile']}]"],
    ["allow_failure", "rules: [{if: '$CI_COMMIT_BRANCH', allow_failure: true}]"],
  ])("rule key %s is rejected because it cannot be ignored", (key, rules) => {
    expect(() => parseGitLabPipeline(`job:\n  script: echo hi\n  ${rules}\n`)).toThrow(`rules[0].${key} is not supported yet`);
  });

  test("an unsupported expression names the job and the text", () => {
    expect(() => parseGitLabPipeline("deploy:\n  script: x\n  rules: [{if: '!$A'}]\n")).toThrow('deploy.rules[0].if is not supported yet');
    expect(() => parseGitLabPipeline("deploy:\n  script: x\n  rules: [{if: '!$A'}]\n")).toThrow('"!$A"');
  });
});

describe("rules through discovery, validation and the Act command", () => {
  let dir: string;
  let project: Project;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ad-gitlab-rules-"));
    project = { id: "p1", path: dir, name: "demo" } as unknown as Project;
    await writeFile(join(dir, ".gitlab-ci.yml"), PIPELINE);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const request = (event: string, inputs: Record<string, string> = {}, jobId?: string) =>
    runRequestSchema.parse({ projectId: "p1", workflowPath: ".gitlab-ci.yml", event, inputs, jobId });

  test("a pipeline with rules is a valid workflow that offers the branches its rules read", async () => {
    const [w] = await discover(project);
    expect(w.diagnostic).toBeUndefined();
    expect(w.jobs.map((j) => j.id)).toEqual(["validate_branch-flow", "build_image", "deploy_production", "notify"]);
    expect(w.inputs.map((i) => [i.name, i.events])).toEqual([
      ["CI_COMMIT_BRANCH", ["push", "manual"]],
      ["CI_MERGE_REQUEST_SOURCE_BRANCH_NAME", ["merge_request"]],
      ["CI_MERGE_REQUEST_TARGET_BRANCH_NAME", ["merge_request"]],
    ]);
  });

  test("the generated workflow holds only the jobs this run selects, and Act never sees the context inputs", async () => {
    const args = commandArgs(project, request("push", { CI_COMMIT_BRANCH: "main" }), "run-1");
    const jobs = parseDocument(await Bun.file(args[2]).text()).toJS().jobs as Record<string, { env: Record<string, string> }>;
    expect(Object.keys(jobs)).toEqual(["build_image"]);
    expect(jobs.build_image.env.TAG).toBe("latest");
    expect(args.join(" ")).not.toContain("CI_COMMIT_BRANCH");
    const mr = commandArgs(project, request("merge_request", { CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature/a", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev-v1" }), "run-2");
    expect(mr[0]).toBe("pull_request");
    expect(Object.keys(parseDocument(await Bun.file(mr[2]).text()).toJS().jobs)).toEqual(["validate_branch-flow"]);
    expect(mr[2]).not.toBe(args[2]);
  });

  test("validation checks only the jobs that run and explains an excluded one", async () => {
    await expect(validateRun(project, request("push", { CI_COMMIT_BRANCH: "main" }))).resolves.toBeDefined();
    await expect(validateRun(project, request("push", { CI_COMMIT_BRANCH: "dev" }, "deploy_production"))).rejects.toThrow("excluded by its rules");
    await expect(analyzeWorkflow(project, request("push", { CI_COMMIT_BRANCH: "main" }, "deploy_production"))).resolves.toBeDefined();
  });

  test("the current git branch is the default context", async () => {
    Bun.spawnSync(["git", "init", "-q", "-b", "dev-v0.3.0"], { cwd: dir });
    const args = commandArgs(project, request("push"), "run-3");
    const jobs = parseDocument(await Bun.file(args[2]).text()).toJS().jobs as Record<string, { env: Record<string, string> }>;
    expect(jobs.build_image.env).toMatchObject({ TAG: "dev", CI_COMMIT_BRANCH: "dev-v0.3.0" });
  });
});
