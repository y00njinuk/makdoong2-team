// agent-stage-config.ts — stage → agent metadata + permission deltas.
// Replaces oh-my-openagent's per-agent permission/tool config by encoding
// it here so we can both (a) emit agent markdown files and (b) validate
// runtime permissions inside the plugin hook.

export type Stage =
  | "1_planning.jira"
  | "1_planning.requirements"
  | "2_implementation.analysis"
  | "2_implementation.dev"
  | "2_implementation.test"
  | "3_delivery.commit"
  | "3_delivery.pr"
  | "3_delivery.review";

export interface PermissionRule {
  bash: Record<string, "allow" | "deny" | "ask">;
}

export interface AgentSpec {
  id: string;                    // matches POLICIES key in model-router
  stage: Stage | "all";
  primary_only: boolean;         // 6_commit, 7_pr — never delegated
  permissions: PermissionRule;
  tools: string[];                // skill names + opencode built-ins allowed
  skills: string[];               // skill loads (lazy MCP)
}

// Locked-down default: deny everything risky, allow only stage-specific tools.
const RO_PERM: PermissionRule = {
  bash: {
    "*": "allow",
    "git commit*": "deny",
    "git push*": "deny",
    "git reset --hard*": "deny",
    "git branch -D*": "deny",
    "git worktree add*": "deny",
    "git worktree remove*": "deny",
    "rm -rf*": "deny",
  },
};

// Engineer delta: worktree creation allowed, but commit/push still denied.
// Allows engineer to create worktrees for isolated development.
const ENG_PERM: PermissionRule = {
  bash: {
    "*": "allow",
    "git commit*": "deny",
    "git push*": "deny",
    "git reset --hard*": "deny",
    "git branch -D*": "deny",
    "git worktree add*": "allow",
    "git worktree remove*": "allow",
    "rm -rf*": "deny",
  },
};

// Orchestrator delta: commit/push allowed (PRIMARY-only stages),
// destructive still requires APPROVED_DESTRUCTIVE marker (enforced by guard-bash.sh).
const ORCH_PERM: PermissionRule = {
  bash: {
    "*": "allow",
    "git commit*": "allow",
    "git push*": "allow",
    "git push --force*": "ask",
    "git push --force-with-lease*": "ask",
    "git reset --hard*": "ask",
    "git branch -D*": "ask",
    "git worktree add*": "ask",
    "git worktree remove*": "ask",
    "rm -rf*": "ask",
  },
};

export const AGENTS: Record<string, AgentSpec> = {
  "makdoong2-team-leader": {
    id: "makdoong2-team-leader",
    stage: "all",
    primary_only: true,
    permissions: ORCH_PERM,
    tools: ["task", "bash", "read", "edit", "write", "skill"],
    skills: ["makdoong2-team"],
  },
  "makdoong2-planner": {
    id: "makdoong2-planner",
    stage: "all",
    primary_only: false,
    permissions: RO_PERM,
    tools: ["bash", "read", "grep", "glob", "task", "skill"],
    skills: ["jira-research", "confluence-research", "bitbucket-research", "github-oss-research"],
  },
  "makdoong2-analyzer": {
    id: "makdoong2-analyzer",
    stage: "all",
    primary_only: false,
    permissions: RO_PERM,
    tools: ["bash", "read", "grep", "glob", "write"],
    skills: [],
  },
  "makdoong2-engineer": {
    id: "makdoong2-engineer",
    stage: "all",
    primary_only: false,
    permissions: ENG_PERM,
    tools: ["bash", "read", "edit", "write", "grep", "glob"],
    skills: [],
  },
  "makdoong2-publisher": {
    id: "makdoong2-publisher",
    stage: "all",
    primary_only: false,
    permissions: RO_PERM,
    tools: ["bash", "read", "skill"],
    skills: ["bitbucket-research"],
  },
  "makdoong2-verifier": {
    id: "makdoong2-verifier",
    stage: "all",
    primary_only: false,
    permissions: RO_PERM,
    tools: ["bash", "read"],
    skills: [],
  },
};

export const STAGE_SPEC_FILES: Record<Stage, string> = {
  "1_planning.jira":            "01-planning.md",
  "1_planning.requirements":    "02-requirements.md",
  "2_implementation.analysis":  "04-analysis.md",
  "2_implementation.dev":       "05-worktree-dev.md",
  "2_implementation.test":      "06-test.md",
  "3_delivery.commit":          "07-commit.md",
  "3_delivery.pr":              "08-pr.md",
  "3_delivery.review":          "09-review-comments.md",
};

export function agentForStage(stage: Stage): AgentSpec {
  if (stage.startsWith("1_planning.")) return AGENTS["makdoong2-planner"];
  if (stage === "2_implementation.analysis") return AGENTS["makdoong2-analyzer"];
  if (stage.startsWith("2_implementation.")) return AGENTS["makdoong2-engineer"];
  if (stage.startsWith("3_delivery.")) return AGENTS["makdoong2-publisher"];
  throw new Error(`no agent registered for stage ${stage}`);
}
