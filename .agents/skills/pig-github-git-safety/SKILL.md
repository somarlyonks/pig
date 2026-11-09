---
name: pig-github-git-safety
description: Use when changing GitHub webhook planning, permission checks, work/review/release handlers, or host Git operations. Covers GitHub App permissions/events, review diff line mapping, release idempotency, and the Git safety invariants.
---

# PiG GitHub + Git safety

## GitHub App contract

Required repository permissions:
- Metadata: read
- Contents: read/write (branches, tags, releases)
- Issues: read/write (progress comments; PR conversation comments)
- Pull requests: read/write (PRs, reviews, inline comments)
- Workflows: no access by default; optional and guarded

Events:
- `issue_comment`
- `pull_request`
- `pull_request_review_comment`

Webhook:
- Verify `X-Hub-Signature-256` from the **raw body** before JSON parse.
- Node uses `src/webhooks/verify.ts` (`node:crypto`).
- Worker uses `src/webhooks/verify-webcrypto.ts` (`crypto.subtle`).
- `X-GitHub-Event`, `X-GitHub-Delivery` required.

## Planning and authorization

- `src/webhooks/commands.ts` parses `@pig` / `/pig` commands; `/pig` alias, case-insensitive.
- `src/webhooks/plan.ts` is pure and produces an admission plan; no DB writes.
- `src/webhooks/extract.ts` extracts `repository.full_name` for DO routing.
- Ignore bot authors (`type: "Bot"` or `<slug>[bot]`), non-created actions, non-trigger PR actions, no mention.
- Auto review actions: opened, reopened, synchronize, ready_for_review; dedupe per repo+PR+head SHA, with `:ready` for ready_for_review.
- Authorization is server-side in the job, not in planning: write/admin/maintain/push, or `.pig.yml` `permissions.allow`.
- Auto reviews skip authorization (but only run from PR events).

## Work handler

- Issue work: checkout default branch on deterministic `<branch_prefix><issue>-<slug>-<shortTaskId>`, agent, commit, push, open PR, `Closes #N`, credit requester.
- PR work: only same-repository head branches; reject forks; reject default branch; push without force.
- Closed issues / closed or merged PRs are rejected.
- Empty change set: no branch/commit/PR; comment says so.
- Agent may not commit/amend/rebase/push/PR; handler resets soft to base if the agent committed.
- Workflow edits (`.github/workflows/**`) reverted unless `work.allow_workflow_changes`; note reverted files in PR body/comment.
- Recheck PR head before committing; stale head → transient retry from new head.
- Commit author: PiG `<appId>+<slug>[bot]@users.noreply.github.com`.

## Review handler

- Review agent has read + write only; write guard allows only `.pig/review.json`.
- Diff source: `GET /repos/{owner}/{repo}/pulls/{n}` with `Accept: application/vnd.github.diff`.
- Changed files: `pulls.listFiles` (up to 300).
- Findings: path, line, side LEFT/RIGHT, severity blocker/issue/nit, body.
- Validate line against parsed diff (`src/diff.ts`); only changed/context lines post inline. Demoted findings go in the review body with a reason.
- Dedupe findings; cap by `review.max_findings`.
- Skip auto reviews for drafts (config), stale head, PiG's own PRs.
- `findExistingReview` checks PiG reviews at the same head SHA before posting.
- Verdict: default COMMENT; REQUEST_CHANGES per `blocker|any|never`; APPROVE only if allowApprove and no findings.
- 422 on inline comments → retry as one review body.
- Recheck PR open and same head immediately before posting.
- Post review with `commit_id` = live head.

## Release handler

- Only semver tags under `release.tag_prefix`.
- `auto` bump from merged PRs since latest tag (breaking/major, feat/minor, else patch); first release 0.1.0 (or 1.0.0 for major).
- `major|minor|patch` bumps latest; exact version allowed, reject lower than latest unless it already exists.
- Exclude `skip-changelog`/`no-changelog`/`release-skip`, `chore(release)`, other base branches.
- Notes groups: Breaking, Features, Fixes, Performance, Documentation, Maintenance, Other; compare link.
- Checkpoint plan (tag/version/commit/notes/draft/prerelease) before `createRef`.
- Idempotent: existing release → report; existing tag without release → create release; recheck after retry.
- No package publishing, assets, or version-file commit.

## Git safety

Host Git uses `src/git.ts` `runGit`:
- minimal env; `GIT_TERMINAL_PROMPT=0`; `GIT_CONFIG_GLOBAL=/dev/null`; hooks path `/dev/null`; empty credential helper
- no token in URL; askpass temp script via `withGitAskpass`, token only in Git subprocess env
- reset local config after agent work (`resetLocalGitConfig`) with explicit origin URL
- push uses explicit repository URL, never a token URL
- never default branch; force only deterministic PiG branch
- path checks for workspace files; workflow revert
- `commitAll` uses `-c user.name/user.email`; returns null for empty tree

Runner Git operations reuse the same helpers; the installed token is passed only to create/push, not to the agent shell.

## Pitfalls

- Do not trust `author_association`; query collaborator permission.
- Do not parse JSON before HMAC verification.
- Do not construct push URLs with tokens.
- Do not review a stale head; skip auto, retry manual.
- Do not post duplicate inline comments; validate and dedupe.
- Do not create a release if the checkpoint says the tag exists but the release step did not finish? Actually recheck GitHub; create only the missing side.
- Do not approve by default.
- Do not let agent edit `.github/workflows/**` unless explicitly allowed and permitted.
- Do not push to a fork branch; PiG cannot.
