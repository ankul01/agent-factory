# Phase 3 Backlog: Warp Self-Improvement & Verification Learnings

Parked enhancements for Phase 3 of **Agent Factory**, inspired by Warp's software-factory architecture:

## 1. Online Run Scorers (`scorer.yml` + Neon Table)
- Score every completed requirement run across plan quality, diff minimality, test coverage, review P0/P1 density, and deploy smoke-test latency.
- Persist structured scores in a `run_scores` Neon Postgres table linked to `requirements.id`.

## 2. Weekly Self-Improvement PR (`factory-retro.yml`)
- Scheduled weekly workflow that analyzes recent `FAILED` runs, review comments, and `run_scores` regressions.
- Automatically opens a PR against `skills/*.md` and `.github/config/llm_profiles.json` with proposed prompt/guardrail improvements.

## 3. Pre-Merge Behavioral Verification Artifacts
- Require coding agents to attach deterministic verification artifacts (e.g. HTTP curl transcripts, unit test summaries, migration dry-run output) in PR descriptions before `pr-review.yml` marks `APPROVED`.

## 4. Private Model Benchmark Suite
- Maintain a curated benchmark of past real requirements and replay them across candidate LLM routes (`planner`, `reviewer`, `coder`) to measure pass rate, latency, and cost before promoting new models.
