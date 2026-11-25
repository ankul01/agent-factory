import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    plannerWorkflow: text("planner_workflow").notNull().default("planner.yml"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("projects_owner_repo_idx").on(table.repoOwner, table.repoName)],
);

export const requirements = pgTable(
  "requirements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    promptText: text("prompt_text").notNull(),
    status: text("status").notNull().default("RECEIVED"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("requirements_project_slug_idx").on(table.projectId, table.slug)],
);

export const planRuns = pgTable(
  "plan_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requirementId: uuid("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    planId: text("plan_id"),
    planPath: text("plan_path"),
    branchName: text("branch_name"),
    ghRunId: text("gh_run_id"),
    ghRunUrl: text("gh_run_url"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    mergeCommitSha: text("merge_commit_sha"),
    openQuestionsCount: integer("open_questions_count").notNull().default(0),
    modelUsed: text("model_used"),
    status: text("status").notNull().default("QUEUED"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("plan_runs_req_version_idx").on(table.requirementId, table.version)],
);

export const codingTasks = pgTable(
  "coding_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requirementId: uuid("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    planRunId: uuid("plan_run_id").references(() => planRuns.id, { onDelete: "set null" }),
    featureSlug: text("feature_slug").notNull(),
    branchName: text("branch_name"),
    ghRunId: text("gh_run_id"),
    ghRunUrl: text("gh_run_url"),
    cursorAgentId: text("cursor_agent_id"),
    cursorRunId: text("cursor_run_id"),
    cursorTrackingUrl: text("cursor_tracking_url"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    mergeCommitSha: text("merge_commit_sha"),
    status: text("status").notNull().default("QUEUED"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("coding_tasks_req_feature_idx").on(table.requirementId, table.featureSlug),
  ],
);

export const reviewRuns = pgTable(
  "review_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codingTaskId: uuid("coding_task_id")
      .notNull()
      .references(() => codingTasks.id, { onDelete: "cascade" }),
    ghRunId: text("gh_run_id").notNull(),
    ghRunUrl: text("gh_run_url"),
    testStatus: text("test_status").notNull().default("PENDING"),
    verdict: text("verdict").notNull().default("PENDING"),
    p0Count: integer("p0_count").notNull().default(0),
    p1Count: integer("p1_count").notNull().default(0),
    commentUrl: text("comment_url"),
    modelUsed: text("model_used"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("review_runs_task_gh_run_idx").on(table.codingTaskId, table.ghRunId)],
);

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requirementId: uuid("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    codingTaskId: uuid("coding_task_id").references(() => codingTasks.id, { onDelete: "set null" }),
    releaseTag: text("release_tag"),
    releaseUrl: text("release_url"),
    commitSha: text("commit_sha"),
    ghRunId: text("gh_run_id").notNull(),
    ghRunUrl: text("gh_run_url"),
    smokeTestStatus: text("smoke_test_status").notNull().default("PENDING"),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("deployments_req_gh_run_idx").on(table.requirementId, table.ghRunId)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type RequirementRow = typeof requirements.$inferSelect;
export type PlanRunRow = typeof planRuns.$inferSelect;
export type CodingTaskRow = typeof codingTasks.$inferSelect;
export type ReviewRunRow = typeof reviewRuns.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;
