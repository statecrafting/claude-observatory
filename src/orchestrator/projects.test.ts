import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  PROJECT_KINDS,
  createProcessProjectProbe,
  defaultProjectName,
  foldProjects,
  isValidProjectName,
  openProjectsChain,
  projectStateRoot,
  projectsFromChain,
  qualifyProject,
  registerProject,
  removeProject,
  requalifyProject,
  setProjectArmed,
  slugifyProjectName,
  verifyProjectsChain,
  type ProjectProbe,
  type QualificationVerdict,
} from "./projects";

// --- fixtures (real git, never a real spec-spine) ---------------------------

function git(dir: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "projects-home-"));
}

interface RepoFixtureOptions {
  readonly gitignoreData?: boolean;
  readonly specs?: boolean;
}

// A governed target: a clone, so origin and refs/remotes/origin/HEAD are
// genuine rather than hand-written refs.
function governedRepo(options: RepoFixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "projects-repo-"));
  const origin = join(root, "origin");
  mkdirSync(origin);
  seedRepo(origin, options);
  const clone = join(root, "target");
  git(root, ["clone", "-q", origin, clone]);
  return clone;
}

// A target that is a git repo but was never cloned from anywhere: no origin,
// and so no resolvable default branch either.
function repoWithoutOrigin(options: RepoFixtureOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "projects-noorigin-"));
  seedRepo(dir, options);
  return dir;
}

function seedRepo(dir: string, options: RepoFixtureOptions): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  if (options.gitignoreData !== false) writeFileSync(join(dir, ".gitignore"), "data/\n");
  if (options.specs !== false) {
    mkdirSync(join(dir, "specs", "001-fixture"), { recursive: true });
    writeFileSync(join(dir, "specs", "001-fixture", "spec.md"), "# fixture spec\n");
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
}

function nonRepo(): string {
  return mkdtempSync(join(tmpdir(), "projects-nonrepo-"));
}

// The production probe with only `spec-spine compile` scripted: every git and
// filesystem answer below is the real one, computed against the fixture repo
// (FR-002), so no test needs a governed corpus of its own.
function probeWith(compileExitCode = 0, stderrTail = ""): ProjectProbe {
  return { ...createProcessProjectProbe(), compile: () => ({ exitCode: compileExitCode, stderrTail }) };
}

function checkOf(verdict: QualificationVerdict, id: string): { ok: boolean; detail: string } {
  const check = verdict.checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check "${id}" in verdict`);
  return { ok: check.ok, detail: check.detail };
}

// A hand-written verdict for the fold tests, which are about the chain, not
// about the preflight.
function verdict(qualified: boolean, warnings: readonly string[] = []): QualificationVerdict {
  return {
    qualified,
    checks: [
      { id: "git-repo", ok: true, detail: "git work tree root" },
      { id: "compile-green", ok: qualified, detail: qualified ? "spec-spine compile exited 0" : "spec-spine compile exited 1: boom" },
    ],
    warnings: [...warnings],
  };
}

// --- names (D-1) ------------------------------------------------------------

test("project names are lowercase slugs; anything else is refused", () => {
  expect(isValidProjectName("claude-observatory")).toBe(true);
  expect(isValidProjectName("025")).toBe(true);
  expect(isValidProjectName("Claude")).toBe(false);
  expect(isValidProjectName("-leading")).toBe(false);
  expect(isValidProjectName("has spaces")).toBe(false);
  expect(isValidProjectName("has/slash")).toBe(false);
  expect(isValidProjectName("")).toBe(false);
});

test("slugifyProjectName folds a directory basename into a slug", () => {
  expect(slugifyProjectName("Claude.Observatory")).toBe("claude-observatory");
  expect(slugifyProjectName("__weird__name__")).toBe("weird-name");
  expect(defaultProjectName("/Users/x/DevWork/spec-spine")).toBe("spec-spine");
  expect(() => defaultProjectName("/Users/x/---")).toThrow(/cannot derive a project name/);
});

// --- two roots (B-3) --------------------------------------------------------

test("a project's state root is data/orchestrator inside the target", () => {
  expect(projectStateRoot("/Users/x/DevWork/enrahitu")).toBe("/Users/x/DevWork/enrahitu/data/orchestrator");
});

// --- registration (B-1, B-2) ------------------------------------------------

test("registerProject defaults the name to the repoDir basename and registers armed", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    const { record, project } = registerProject({
      chain,
      repoDir: "/Users/x/DevWork/enrahitu/",
      qualification: verdict(true),
      source: "cli",
    });

    expect(record.kind).toBe(PROJECT_KINDS.registered);
    expect(project?.name).toBe("enrahitu");
    // resolve() normalizes the trailing slash away before it is journaled.
    expect(project?.repoDir).toBe("/Users/x/DevWork/enrahitu");
    expect(project?.armed).toBe(true);
    expect(project?.qualification.qualified).toBe(true);
    // The verdict's timestamp is the recording record's own (one clock).
    expect(project?.qualification.checkedAt).toBe(record.ts);
  } finally {
    chain.close();
  }
});

test("registerProject accepts an explicit name, a disarmed start, and an unqualified verdict", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    const { project } = registerProject({
      chain,
      repoDir: "/Users/x/DevWork/chancery",
      name: "chancery-main",
      armed: false,
      qualification: verdict(false),
      source: "api",
    });

    expect(project?.name).toBe("chancery-main");
    expect(project?.armed).toBe(false);
    // B-4: unqualified targets stay visible with their reasons.
    expect(project?.qualification.qualified).toBe(false);
    expect(checkOf(project!.qualification, "compile-green").detail).toMatch(/exited 1/);
  } finally {
    chain.close();
  }
});

test("registerProject refuses a duplicate name, a duplicate repoDir, and a non-absolute path", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    registerProject({ chain, repoDir: "/Users/x/DevWork/enrahitu", qualification: verdict(true), source: "cli" });

    expect(() =>
      registerProject({
        chain,
        repoDir: "/Users/x/elsewhere/enrahitu",
        name: "enrahitu",
        qualification: verdict(true),
        source: "cli",
      })
    ).toThrow(/already registered/);

    expect(() =>
      registerProject({
        chain,
        repoDir: "/Users/x/DevWork/enrahitu",
        name: "second-name",
        qualification: verdict(true),
        source: "cli",
      })
    ).toThrow(/already registered as "enrahitu"/);

    expect(() =>
      registerProject({ chain, repoDir: "relative/path", qualification: verdict(true), source: "cli" })
    ).toThrow(/must be an absolute path/);

    expect(() =>
      registerProject({
        chain,
        repoDir: "/Users/x/DevWork/enrahitu",
        name: "Not A Slug",
        qualification: verdict(true),
        source: "cli",
      })
    ).toThrow(/not a valid project name/);

    // A refusal appends nothing: the chain still holds only the one
    // registration, and it verifies. That registration is two records since
    // 032 B-2, the registration and the posture it consented to, so the head
    // sits at seq 1 with nothing from the four refusals above.
    expect(chain.headSeq).toBe(1);
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    chain.close();
  }
});

// --- the fold (FR-001, AC-2) ------------------------------------------------

test("the fold carries register, disarm, arm, requalify, remove and re-register through one history", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    registerProject({ chain, repoDir: "/Users/x/DevWork/enrahitu", qualification: verdict(true), source: "cli" });
    registerProject({ chain, repoDir: "/Users/x/DevWork/chancery", qualification: verdict(false), source: "ui" });

    setProjectArmed({ chain, name: "enrahitu", armed: false, source: "api" });
    expect(projectsFromChain(chain.fold()).get("enrahitu")?.armed).toBe(false);

    setProjectArmed({ chain, name: "enrahitu", armed: true, source: "cli" });
    expect(projectsFromChain(chain.fold()).get("enrahitu")?.armed).toBe(true);

    const requalified = requalifyProject({
      chain,
      name: "chancery",
      qualification: verdict(true, ["data/ is tracked"]),
      source: "cli",
    });
    expect(requalified.record.kind).toBe(PROJECT_KINDS.requalified);
    expect(requalified.project?.qualification.qualified).toBe(true);
    expect(requalified.project?.qualification.warnings).toEqual(["data/ is tracked"]);
    // Requalification replaces the verdict only; arm state and path are kept.
    expect(requalified.project?.armed).toBe(true);
    expect(requalified.project?.repoDir).toBe("/Users/x/DevWork/chancery");

    const removed = removeProject({ chain, name: "enrahitu", source: "ui" });
    expect(removed.record.kind).toBe(PROJECT_KINDS.removed);
    expect(removed.project).toBeNull();
    expect(projectsFromChain(chain.fold()).has("enrahitu")).toBe(false);

    // D-2: re-registering the same path resumes the same state root, and the
    // project takes the newest position in registration order.
    const reregistered = registerProject({
      chain,
      repoDir: "/Users/x/DevWork/enrahitu",
      qualification: verdict(true),
      source: "cli",
    });
    expect(reregistered.project?.armed).toBe(true);
    expect(projectStateRoot(reregistered.project!.repoDir)).toBe("/Users/x/DevWork/enrahitu/data/orchestrator");

    const projects = projectsFromChain(chain.fold());
    expect([...projects.keys()]).toEqual(["chancery", "enrahitu"]);

    // AC-2: the chain verifies over the whole history. Ten records, not
    // seven: each of the three registrations appends its posture beside
    // itself (032 B-2), and the four mutations are one record each.
    const verified = verifyProjectsChain(home);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.count).toBe(10);
  } finally {
    chain.close();
  }
});

test("a mutation record naming a removed project is inert (removal is a tombstone)", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    registerProject({ chain, repoDir: "/Users/x/DevWork/enrahitu", qualification: verdict(true), source: "cli" });
    removeProject({ chain, name: "enrahitu", source: "cli" });
    // A stale control that raced the removal, appended raw the way a crashed
    // or concurrent writer would have left it.
    chain.append(PROJECT_KINDS.armed, { name: "enrahitu", source: "api" });
    chain.append(PROJECT_KINDS.requalified, {
      name: "enrahitu",
      qualification: { qualified: true, checks: [], warnings: [] },
      source: "api",
    });

    expect(projectsFromChain(chain.fold()).size).toBe(0);
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    chain.close();
  }
});

test("foldProjects ignores kinds this chain does not own", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    chain.append("run.started", { runId: "r-1" });
    registerProject({ chain, repoDir: "/Users/x/DevWork/enrahitu", qualification: verdict(true), source: "cli" });
    expect(foldProjects(chain.fold().records).size).toBe(1);
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    chain.close();
  }
});

test("the registry is recovered from the chain alone across a reopen", () => {
  const home = freshHome();
  const first = openProjectsChain(home);
  registerProject({ chain: first, repoDir: "/Users/x/DevWork/enrahitu", qualification: verdict(true), source: "cli" });
  setProjectArmed({ chain: first, name: "enrahitu", armed: false, source: "cli" });
  first.close();

  const second = openProjectsChain(home);
  try {
    const projects = projectsFromChain(second.fold());
    expect(projects.get("enrahitu")?.armed).toBe(false);
    expect(projects.get("enrahitu")?.qualification.qualified).toBe(true);
    expect(verifyProjectsChain(home).ok).toBe(true);
  } finally {
    second.close();
  }
});

test("arm, requalify and remove refuse a project that is not registered", () => {
  const home = freshHome();
  const chain = openProjectsChain(home);
  try {
    expect(() => setProjectArmed({ chain, name: "ghost", armed: true, source: "cli" })).toThrow(/no registered project/);
    expect(() => requalifyProject({ chain, name: "ghost", qualification: verdict(true), source: "cli" })).toThrow(
      /no registered project/
    );
    expect(() => removeProject({ chain, name: "ghost", source: "cli" })).toThrow(/no registered project/);
    expect(chain.headSeq).toBe(-1);
  } finally {
    chain.close();
  }
});

// --- qualification (B-4, FR-002) --------------------------------------------

test("a governed repo qualifies with no warnings", () => {
  const repoDir = governedRepo();
  const result = qualifyProject(probeWith(0), repoDir);

  expect(result.qualified).toBe(true);
  expect(result.warnings).toEqual([]);
  expect(checkOf(result, "git-repo").ok).toBe(true);
  expect(checkOf(result, "origin-remote").detail).toMatch(/origin is /);
  expect(checkOf(result, "default-branch").detail).toBe('default branch is "main"');
  expect(checkOf(result, "specs-present").detail).toBe("1 spec(s) under specs/");
});

test("a repo without an origin remote is unqualified, with both reasons", () => {
  const repoDir = repoWithoutOrigin();
  const result = qualifyProject(probeWith(0), repoDir);

  expect(result.qualified).toBe(false);
  expect(checkOf(result, "git-repo").ok).toBe(true);
  expect(checkOf(result, "origin-remote")).toEqual({ ok: false, detail: 'no "origin" remote' });
  expect(checkOf(result, "default-branch").ok).toBe(false);
  expect(checkOf(result, "default-branch").detail).toMatch(/no default branch/);
});

test("a directory that is not a git repository is unqualified, with the reason", () => {
  const result = qualifyProject(probeWith(0), nonRepo());

  expect(result.qualified).toBe(false);
  expect(checkOf(result, "git-repo").ok).toBe(false);
  expect(checkOf(result, "git-repo").detail).toMatch(/is not a git work tree/);
  // No git, so no data/ warning to make: the verdict is already damning.
  expect(result.warnings).toEqual([]);
});

test("a subdirectory of a governed repo is unqualified: the root is the target, not a path inside it", () => {
  const repoDir = governedRepo();
  const sub = join(repoDir, "specs");
  const result = qualifyProject(probeWith(0), sub);

  expect(result.qualified).toBe(false);
  expect(checkOf(result, "git-repo").detail).toMatch(/is "specs\/" inside a git work tree, not its root/);
});

test("a governed repo that does not gitignore data/ qualifies, with the warning recorded", () => {
  const repoDir = governedRepo({ gitignoreData: false });
  const result = qualifyProject(probeWith(0), repoDir);

  expect(result.qualified).toBe(true);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toMatch(/does not gitignore data\//);
  expect(result.warnings[0]).toContain(projectStateRoot(repoDir));
});

test("a red spec-spine compile disqualifies the target, carrying the exit code and stderr", () => {
  const repoDir = governedRepo();
  const result = qualifyProject(probeWith(2, "specs/001-fixture/spec.md: missing frontmatter"), repoDir);

  expect(result.qualified).toBe(false);
  expect(checkOf(result, "compile-green").detail).toBe(
    "spec-spine compile exited 2: specs/001-fixture/spec.md: missing frontmatter"
  );
});

test("a governed repo with no specs is unqualified", () => {
  const repoDir = governedRepo({ specs: false });
  const result = qualifyProject(probeWith(0), repoDir);

  expect(result.qualified).toBe(false);
  expect(checkOf(result, "specs-present")).toEqual({ ok: false, detail: "specs/ is missing or holds no spec.md" });
});

// --- qualify, then register (B-1, B-2, B-4) ---------------------------------

test("an unqualified target registers with its reasons and requalifies in place once fixed", () => {
  const home = freshHome();
  const repoDir = repoWithoutOrigin();
  const chain = openProjectsChain(home);
  try {
    const registered = registerProject({
      chain,
      repoDir,
      name: "target",
      qualification: qualifyProject(probeWith(0), repoDir),
      source: "cli",
    });
    expect(registered.project?.qualification.qualified).toBe(false);
    expect(checkOf(registered.project!.qualification, "origin-remote").ok).toBe(false);

    // The operator adds the remote and fetches; requalification is a new
    // record, not an edit of the old one. The preflight asks whether origin
    // and a default branch resolve locally, never whether origin is
    // reachable, so the URL here is never dialed.
    git(repoDir, ["remote", "add", "origin", "git@example.com:x/target.git"]);
    git(repoDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const requalified = requalifyProject({
      chain,
      name: "target",
      qualification: qualifyProject(probeWith(0), repoDir),
      source: "cli",
    });
    expect(requalified.project?.qualification.qualified).toBe(true);
    expect(checkOf(requalified.project!.qualification, "default-branch").detail).toBe('default branch is "main"');

    // Three records: the registration, the posture it recorded beside itself
    // (032 B-2), and this requalification.
    const verified = verifyProjectsChain(home);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.count).toBe(3);
  } finally {
    chain.close();
  }
});
