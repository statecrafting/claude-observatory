// What a project's backlog says about itself (spec 029 B-2), derived from the
// one route that carries it: that project's own `/api/projects/<name>/dag`.
//
// This is a pure reading of a served fold, not a second scheduler. The four
// states below are the four the standby view has to be able to say out loud,
// and the hardest of them is the first: "complete" has to be a stated fact,
// because a daemon whose backlog is done is alive and correct, and a dashboard
// that renders that as an empty panel is the exact confusion 010 A-1 names.
//
// "Pending" is spelled the way the scheduler spells it (spec 012's nextReady
// walks specs whose registry `implementation` is pending, over a snapshot in
// which a shipped or operator-skipped spec has already been rewritten out). So
// a spec the registry still calls pending but the journal has shipped is not
// counted here either, and this view cannot disagree with the daemon about how
// much work is left.
import type { ApiMeta, DagView, ProjectView, SpecBlockerView } from "./api";

export type BacklogState =
  // Nothing is pending: the backlog is done and the daemon is idle by success.
  | "complete"
  // At least one pending spec has every dependency satisfied.
  | "ready"
  // Pending work exists and none of it can be picked up.
  | "blocked"
  // A dependency cycle refuses scheduling outright (012 B-5).
  | "refused"
  // No fold has been read for this project yet.
  | "unknown";

export interface BacklogSummary {
  readonly state: BacklogState;
  // The specs the scheduler would still consider, in the fold's own order.
  readonly pending: readonly string[];
  readonly nextReady: string | null;
  readonly blockers: readonly SpecBlockerView[];
  readonly cycle: readonly string[] | null;
  readonly invalidated: readonly string[];
  readonly headline: string;
}

export function summarizeBacklog(dag: DagView | null): BacklogSummary {
  if (dag === null) {
    return {
      state: "unknown",
      pending: [],
      nextReady: null,
      blockers: [],
      cycle: null,
      invalidated: [],
      headline: "this project's DAG has not been folded yet",
    };
  }

  const pending = dag.specs.filter((spec) => spec.implementation === "pending" && !spec.shipped && !spec.skipped).map((spec) => spec.id);
  const base = {
    pending,
    nextReady: dag.nextReady,
    blockers: dag.blockers,
    cycle: dag.cycle,
    invalidated: dag.invalidated,
  };

  if (pending.length === 0) {
    return { ...base, state: "complete", headline: "backlog complete: no spec is pending" };
  }
  if (dag.nextReady !== null) {
    return {
      ...base,
      state: "ready",
      headline: `${countSpecs(pending.length)} pending, ${dag.nextReady} ready`,
    };
  }
  // Pending work with neither a pick nor a blocker list is the one shape the
  // cycle refusal takes: spec 012 B-5 throws instead of scheduling, and the
  // route reports the cycle rather than an unexplained empty schedule.
  if (dag.cycle !== null && dag.blockers.length === 0) {
    return { ...base, state: "refused", headline: `scheduling is refused: ${dag.cycle.join(" -> ")} is a dependency cycle` };
  }
  return { ...base, state: "blocked", headline: `${countSpecs(pending.length)} pending, none ready` };
}

function countSpecs(n: number): string {
  return `${n} spec${n === 1 ? "" : "s"}`;
}

// Why that backlog is or is not being taken (029 B-2: "the armed flag
// explaining why it is or is not being taken").
//
// Every clause is read off something served: the flight slot from
// /api/meta's activeProject, armed and qualified from the registry row. The one
// thing deliberately not claimed is that a ready, armed project will be picked
// on the next scan: spec 026 D-4 holds a project back until its own corpus says
// something new, and that memory is transient scheduler state no route serves.
// Saying so is better than a confident schedule this page cannot back.
export function explainScheduling(summary: BacklogSummary, project: ProjectView, meta: ApiMeta | null): string {
  const daemon = meta?.daemon ?? null;
  if (daemon !== null && daemon.activeProject === project.name) {
    return daemon.state === "parked"
      ? "this project holds the daemon's one flight slot and is parked on the quota horizon"
      : "this project holds the daemon's one flight slot";
  }

  if (summary.state === "unknown") {
    return "nothing is claimed about scheduling until this project's DAG has been folded";
  }

  if (summary.state === "complete") {
    return project.armed
      ? "armed, with nothing pending to take: the daemon stays up in standby rather than treating a finished backlog as an ending"
      : "disarmed, and nothing is pending anyway";
  }

  if (!project.qualification.qualified) {
    return "unqualified: the registry refuses to drive this target, whatever its backlog says (025 B-4). The failed checks are under qualification.";
  }
  if (!project.armed) {
    return "disarmed: this work is observed and reported, never driven (026 D-2). Arming it is what puts it in the scheduler's rotation.";
  }
  if (summary.state === "ready") {
    return "armed and qualified: this is what the scheduler takes when the flight slot frees, unless its last run already concluded on this same backlog (026 D-4, which no route serves).";
  }
  if (summary.state === "refused") {
    return "armed and qualified, and still not schedulable: a dependency cycle refuses the whole fold.";
  }
  return "armed and qualified, but nothing is ready: the blockers below are what the scheduler refuses on.";
}
