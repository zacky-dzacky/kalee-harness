import { exec } from "../../tools/exec.ts";
import type { Finding } from "../finding.ts";
import type { ReviewResult } from "../pipeline.ts";

/**
 * Inline PR comments via `gh api`. Behind `--comment`, and only for a PR target.
 *
 * Posting is an outward-facing action, so the caller confirms before this runs — nothing here
 * decides on its own to write to someone's pull request.
 */
export interface PostOptions {
  prNumber: number;
  repo?: string;
  cwd: string;
  /** Post the review without an approval state. */
  event?: "COMMENT" | "REQUEST_CHANGES";
}

export async function postReview(
  result: ReviewResult,
  opts: PostOptions,
): Promise<{ posted: number; url?: string; skipped: Finding[] }> {
  const commentable = result.findings;
  if (commentable.length === 0) return { posted: 0, skipped: [] };

  const repoArgs = opts.repo ? ["--repo", opts.repo] : [];
  const head = await exec(["gh", "pr", "view", String(opts.prNumber), ...repoArgs, "--json", "headRefOid", "-q", ".headRefOid"], {
    cwd: opts.cwd,
    timeoutMs: 20_000,
  });
  if (head.code !== 0) throw new Error(`gh pr view failed: ${head.stderr.trim()}`);
  const commitId = head.stdout.trim();

  const repo = opts.repo ?? (await currentRepo(opts.cwd));
  const body = {
    commit_id: commitId,
    event: opts.event ?? "COMMENT",
    body: summary(result),
    comments: commentable.map((f) => ({
      path: f.file,
      line: f.line,
      side: "RIGHT",
      body: commentBody(f),
    })),
  };

  const r = await exec(
    ["gh", "api", "--method", "POST", `repos/${repo}/pulls/${opts.prNumber}/reviews`, "--input", "-"],
    { cwd: opts.cwd, timeoutMs: 60_000, stdin: JSON.stringify(body) },
  );
  if (r.code !== 0) {
    // The commonest failure is a finding on a line outside the diff, which GitHub rejects
    // outright — say so rather than reporting a bare API error.
    throw new Error(
      `posting the review failed: ${r.stderr.trim() || r.stdout.trim()}\n` +
        "(GitHub only accepts inline comments on lines present in the diff)",
    );
  }
  const url = (JSON.parse(r.stdout) as { html_url?: string }).html_url;
  return { posted: commentable.length, url, skipped: [] };
}

async function currentRepo(cwd: string): Promise<string> {
  const r = await exec(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    cwd,
    timeoutMs: 20_000,
  });
  if (r.code !== 0) throw new Error("could not determine the repository; pass --repo owner/name");
  return r.stdout.trim();
}

function commentBody(f: Finding): string {
  const badge = f.verdict === "confirmed" ? "confirmed" : "plausible";
  return `**${f.severity}** · ${f.category} · _${badge}_

${f.summary}

**Failure scenario.** ${f.failureScenario}

<sub>via kalee review</sub>`;
}

function summary(result: ReviewResult): string {
  const n = result.findings.length;
  const confirmed = result.findings.filter((f) => f.verdict === "confirmed").length;
  return `**kalee review** — ${n} finding${n === 1 ? "" : "s"} (${confirmed} confirmed), ${result.rejected.length} rejected during verification.`;
}
