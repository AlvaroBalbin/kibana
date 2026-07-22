---
name: Flaky Test Fixer
description: Open a draft fix PR for a `failed-test` issue that has been labeled `ai:fix-flaky`.
on:
  issues:
    types: [labeled]
  workflow_dispatch:
    inputs:
      issue_number:
        description: Issue number in this repository to fix
        required: true
        type: string

permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
  checks: read
  models: read

if: "${{ (github.event_name == 'workflow_dispatch' && github.event.inputs.issue_number != '') || (github.event_name == 'issues' && github.event.action == 'labeled' && github.event.label.name == 'ai:fix-flaky' && !github.event.issue.pull_request) }}"

concurrency:
  group: 'flaky-test-fixer-${{ github.event.issue.number || github.event.inputs.issue_number }}'
  cancel-in-progress: false

env:
  ISSUE_NUMBER: &issue_number ${{ github.event.issue.number || github.event.inputs.issue_number }}
  # Whoever triggered this run: the user who applied `ai:fix-flaky`, or the manual dispatcher.
  REQUESTED_BY: ${{ github.actor }}
  # Lets the agent omit `-o elastic` on every `bk` invocation when re-investigating.
  BUILDKITE_ORGANIZATION_SLUG: elastic

imports:
  - .github/workflows/buildkite-cli-setup.md

engine:
  id: claude
  version: '2.1.165'
  model: opus
  max-turns: 200
  env:
    ANTHROPIC_API_KEY: ${{ secrets.LITELLM_API_KEY }}
    ANTHROPIC_BASE_URL: https://elastic.litellm-prod.ai
    ENABLE_PROMPT_CACHING_1H: '1'
    ANTHROPIC_DEFAULT_OPUS_MODEL: llm-gateway/claude-opus-4-8[1m]
    ANTHROPIC_DEFAULT_HAIKU_MODEL: llm-gateway/claude-haiku-4-5
    ANTHROPIC_DEFAULT_SONNET_MODEL: llm-gateway/claude-sonnet-4-6
    CLAUDE_CODE_EFFORT_LEVEL: high
    CLAUDE_CODE_SUBAGENT_MODEL: opus[1m]

tools:
  github:
    toolsets: [default, search]
  web-fetch:
  bash: true

# Bootstrap Kibana on the self-hosted runner, in a pre-agent step that runs on the
# host (before `awf` starts the sandboxed agent), so `node_modules` and
# `@kbn/setup-node-env` exist and the agent can lint and type check the fix.
runs-on: kibana
steps:
  - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
    with:
      node-version-file: '.nvmrc'
      cache: yarn
  - name: Bootstrap Kibana
    run: yarn kbn bootstrap
  # Failed-test issues record the branch each failure happened on ("First failure:
  # [<pipeline> - <branch>](...)" in the body, "New failure: ..." in kibanamachine
  # comments). A fix that targets a version branch needs that branch's ref plus enough
  # commit history to compute merge-bases, but the default checkout is a shallow
  # single-commit clone of `main`. Prefetching here — branch tip in full, history
  # treeless (`--filter=tree:0`: commit objects only, blobs fetched lazily on demand) —
  # takes a minute or two instead of the 10+ minute `git fetch --unshallow` the agent
  # is otherwise forced into mid-run. No-op when all failures are on `main`.
  - name: Resolve failing branches and prefetch their git history
    continue-on-error: true
    env:
      # ISSUE_NUMBER comes from the workflow-level env.
      GH_TOKEN: ${{ github.token }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/agent
      {
        gh api "repos/${GITHUB_REPOSITORY}/issues/${ISSUE_NUMBER}" --jq '.body'
        gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${ISSUE_NUMBER}/comments" --jq '.[].body'
      } > /tmp/flaky-issue-text.txt
      # Lines look like "First failure: [kibana-on-merge - 8.19](https://...)"; the
      # branch is the segment after the last " - " inside the link text. Filter to
      # plausible branch names so prose can't inject arbitrary fetch arguments.
      branches=$(grep -hoE '(First|New) failure[^]]*\]' /tmp/flaky-issue-text.txt \
        | sed -E 's/.* - ([^]]+)\]$/\1/' \
        | grep -xE 'main|[0-9]+\.(x|[0-9]+)' | sort -u | tr '\n' ' ' | sed 's/ $//') || true
      echo "Failing branches parsed from issue #${ISSUE_NUMBER}: ${branches:-<none found>}"
      printf '%s\n' "${branches}" > /tmp/gh-aw/agent/flaky-failing-branches.txt
      echo "FLAKY_FAILING_BRANCHES=${branches}" >> "$GITHUB_ENV"
      need_history=0
      for branch in ${branches}; do
        if [ "${branch}" != "main" ]; then
          git fetch --depth=1 origin "refs/heads/${branch}:refs/remotes/origin/${branch}" || true
          need_history=1
        fi
      done
      if [ "${need_history}" = 1 ]; then
        # Full commit history (no trees/blobs) for merge-base computations across
        # main and the failing version branches.
        git fetch --unshallow --filter=tree:0 origin main ${branches} \
          || echo "::warning::Treeless history fetch failed; the agent may need to deepen history itself"
      fi

network:
  allowed:
    - defaults
    - buildkite.com
    - '*.buildkite.com'
    - buildkiteartifacts.com
    - ci-stats.kibana.dev
    - github.com
    - api.github.com
    - elastic.litellm-prod.ai
sandbox:
  agent: awf

safe-outputs:
  activation-comments: false
  report-failure-as-issue: false
  mentions:
    allowed:
      - ${{ github.actor }}
    # Lets the agent `cc` the author of the PR that introduced the flaky test
    allowed-collaborators: true
  add-comment:
    max: 1
    target: *issue_number
    hide-older-comments: true
  # Clear the `ai:fix-flaky` trigger label once we have a result.
  remove-labels:
    allowed:
      - ai:fix-flaky
    max: 1
    target: *issue_number
  create-pull-request:
    draft: true
    max: 1
    labels: [flaky-test-fixer, release_note:skip]
    allowed-labels: ['backport:skip', 'backport:all-open', 'backport:version', 'v9.*', 'v8.*']
    # Request whoever triggered the fix as reviewer. A bot actor (rare) can't be a
    # reviewer, so the handler just logs a warning and the PR is still created.
    reviewers: ${{ github.actor }}
    base-branch: main
    # `main` only: for a non-main base, the handler runs an unbounded
    # `git fetch origin <base>` into its shallow main-only checkout, which on a repo
    # Kibana's size cannot finish within any reasonable job timeout. Version-branch
    # PRs go through the `open_version_branch_pr` safe-job below instead.
    allowed-base-branches: ['main']
    if-no-changes: 'ignore'
    # Open the PR as `kibanamachine` (a user), not the default GITHUB_TOKEN bot, so
    # the PR's `opened` event can trigger the Flaky Fix Verifier (GITHUB_TOKEN events don't).
    github-token: ${{ secrets.KIBANAMACHINE_TOKEN }}
    protected-files: fallback-to-issue
    # Use git format-patch / `git am --3way` instead of a git bundle. The bundle
    # transport makes the shallow safe_outputs checkout run `git fetch --unshallow`,
    # which on a repo Kibana's size cannot finish within the 15m job timeout.
    patch-format: am
  # Fills the %%FIX_PR_URL%% / %%FIX_PR_BADGE%% placeholders the agent leaves in the
  # outcome comment. The agent can't do this itself: it doesn't know the PR number while
  # it runs (safe_outputs creates the PR afterwards), so this job runs after safe_outputs.
  jobs:
    link-fix-pr:
      description: 'Replace the %%FIX_PR_URL%% and %%FIX_PR_BADGE%% placeholders in the outcome comment with the newly-opened fix PR link and a live PR-state badge. Call this exactly once, and only after you have opened a draft PR via create_pull_request. Never call it for a version-branch PR opened via open_version_branch_pr — that job fills the placeholders itself.'
      runs-on: ubuntu-latest
      needs: safe_outputs
      if: needs.safe_outputs.outputs.created_pr_url != '' && needs.safe_outputs.outputs.comment_id != ''
      permissions:
        issues: write
      inputs:
        confirm:
          description: 'Set to true to link the outcome comment to the opened fix PR. Only call this after a PR has been opened.'
          required: true
          type: boolean
      env:
        # The URL and number of the fix PR that safe_outputs just created.
        GH_AW_PR_URL: ${{ needs.safe_outputs.outputs.created_pr_url }}
        GH_AW_PR_NUMBER: ${{ needs.safe_outputs.outputs.created_pr_number }}
        # The id of the outcome comment safe_outputs just posted (which comment to edit).
        GH_AW_COMMENT_ID: ${{ needs.safe_outputs.outputs.comment_id }}
      steps:
        - name: Append PR link to outcome comment
          uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
          with:
            github-token: ${{ secrets.KIBANAMACHINE_TOKEN }}
            script: |
              const prUrl = process.env.GH_AW_PR_URL;
              const prNumber = process.env.GH_AW_PR_NUMBER;
              const commentId = Number(process.env.GH_AW_COMMENT_ID);
              if (!prUrl || !prNumber || !Number.isInteger(commentId)) {
                core.info('Missing PR URL, PR number, or comment id; nothing to do.');
                return;
              }
              const { owner, repo } = context.repo;
              const { data: comment } = await github.rest.issues.getComment({ owner, repo, comment_id: commentId });
              const body = comment.body || '';
              // Live PR-state badge (open/draft/merged/closed) linking to the fix PR.
              const badge = `[<img src="https://img.shields.io/github/pulls/detail/state/${owner}/${repo}/${prNumber}">](${prUrl})`;
              // Fill the placeholders the agent left in the outcome comment.
              const updated = body.replaceAll('%%FIX_PR_URL%%', prUrl).replaceAll('%%FIX_PR_BADGE%%', badge);
              if (updated === body) {
                core.info('No fix-PR placeholders found; nothing to do.');
                return;
              }
              await github.rest.issues.updateComment({ owner, repo, comment_id: commentId, body: updated });
              core.info(`Filled fix-PR placeholders for #${prNumber} in comment ${commentId}.`);
    # Requests the author of the PR that introduced the flaky test as a reviewer on the fix PR
    request-fix-review:
      description: 'Request a review on the fix PR from the author of the PR that introduced the flaky test. Only pass a real, non-bot GitHub login.'
      runs-on: ubuntu-latest
      needs: safe_outputs
      if: needs.safe_outputs.outputs.created_pr_number != ''
      permissions:
        pull-requests: write
      inputs:
        author:
          description: "GitHub login (no leading @) of the introducing PR's author to request as a reviewer on the fix PR."
          required: true
          type: string
      env:
        GH_AW_PR_NUMBER: ${{ needs.safe_outputs.outputs.created_pr_number }}
      steps:
        - name: Request review from the introducing PR author
          uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
          with:
            github-token: ${{ secrets.KIBANAMACHINE_TOKEN }}
            script: |
              const fs = require('fs');
              const prNumber = Number(process.env.GH_AW_PR_NUMBER);
              const outputPath = process.env.GH_AW_AGENT_OUTPUT;
              if (!Number.isInteger(prNumber) || !outputPath || !fs.existsSync(outputPath)) {
                core.info('Missing PR number or agent output; nothing to do.');
                return;
              }
              // The agent's `author` tool parameter is delivered here (custom safe-jobs read inputs
              // from GH_AW_AGENT_OUTPUT, not from the job's inputs context).
              const { items = [] } = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
              const author = items.find((entry) => entry.type === 'request_fix_review')?.author?.trim().replace(/^@/, '');
              if (!author) {
                core.info('No reviewer supplied; nothing to do.');
                return;
              }
              const { owner, repo } = context.repo;
              try {
                await github.rest.pulls.requestReviewers({ owner, repo, pull_number: prNumber, reviewers: [author] });
                core.info(`Requested review from @${author} on #${prNumber}.`);
              } catch (err) {
                // Non-fatal: GitHub 422s if the user can't review (not a collaborator, is the PR author, etc.).
                core.warning(`Could not request review from @${author} on #${prNumber}: ${err.status || ''} ${err.message}`);
              }
    # Opens the draft fix PR when it must target a version branch (base ≠ main).
    # The create_pull_request handler can't do this on Kibana: it runs an unbounded
    # `git fetch origin <base>` into its shallow main-only checkout, which cannot
    # finish within any job timeout. This job instead applies the agent's
    # `git format-patch` output (shipped via the `agent` artifact, so provenance is
    # guaranteed) onto a bounded depth-1 fetch of the base branch. The aw-*.patch
    # file name matters: the threat-detection job scans /tmp/gh-aw/aw-*.patch, and
    # this job only runs when safe_outputs succeeded — i.e. detection passed — so the
    # patch gets the same scan as create_pull_request patches. Because it bypasses
    # the create_pull_request handler, it re-implements the handler's guardrails
    # itself: base-branch and label allowlists, patch size/file-count caps, and
    # protected-path checks.
    open-version-branch-pr:
      description: 'Open the draft fix PR against a version branch (base ≠ main). Before calling this, commit your fix on a branch created from origin/<base> and export the patch with `git format-patch origin/<base>..HEAD --stdout > /tmp/gh-aw/aw-version-fix.patch` (see "Version-branch mechanics"). Call it at most once, always instead of — never alongside — create_pull_request.'
      runs-on: ubuntu-latest
      needs: safe_outputs
      # Only run when safe_outputs actually ran (threat detection passed and the
      # outcome comment was processed) — without this, a failed detection job would
      # skip safe_outputs but not this job.
      if: needs.safe_outputs.result == 'success'
      permissions:
        contents: write
        issues: write
        pull-requests: write
      inputs:
        base:
          description: 'Version branch the PR targets (e.g. 8.19, 9.3, 8.x). Never main — main-based PRs go through create_pull_request.'
          required: true
          type: string
        title:
          description: 'PR title, following the "PR format" section.'
          required: true
          type: string
        body:
          description: 'PR body in Markdown, following the "PR format" section.'
          required: true
          type: string
        head_branch:
          description: 'Source branch name for the PR, following the fix/flaky-<issue-number>-<short-kebab-slug> convention.'
          required: true
          type: string
        labels:
          description: 'Comma-separated backport labels (backport:skip, backport:all-open, backport:version, vX.Y.Z), per "Backport label". flaky-test-fixer and release_note:skip are added automatically. Omit if unsure.'
          required: false
          type: string
        reviewer:
          description: "GitHub login (no leading @) of the introducing PR's author to request as a reviewer, only if you confidently identified a real, non-bot one (same rules as request_fix_review). The requester is always added."
          required: false
          type: string
      env:
        # The id of the outcome comment safe_outputs just posted (where to fill the
        # %%FIX_PR_URL%% / %%FIX_PR_BADGE%% placeholders, or report failure).
        GH_AW_COMMENT_ID: ${{ needs.safe_outputs.outputs.comment_id }}
        GH_AW_REQUESTED_BY: ${{ github.actor }}
      steps:
        # Seed git checkout; the base branch itself is fetched (bounded, depth-1) in
        # the apply step below, once the requested base has been validated.
        - name: Checkout repository
          uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
          with:
            persist-credentials: true
            token: ${{ secrets.KIBANAMACHINE_TOKEN }}
        - name: Validate inputs and stage the patch
          id: validate
          uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
          with:
            script: |
              const fs = require('fs');
              const path = require('path');
              // Custom safe-jobs read the agent's tool inputs from GH_AW_AGENT_OUTPUT,
              // not from the job's inputs context.
              const outputPath = process.env.GH_AW_AGENT_OUTPUT;
              if (!outputPath || !fs.existsSync(outputPath)) {
                core.setFailed('Agent output not found; cannot open a version-branch PR.');
                return;
              }
              const { items = [] } = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
              const request = items.find((entry) => entry.type === 'open_version_branch_pr');
              if (!request) {
                core.setFailed('No open_version_branch_pr request found in the agent output.');
                return;
              }
              const errors = [];
              const base = String(request.base || '').trim();
              if (!/^[0-9]+\.(x|[0-9]+)$/.test(base)) {
                errors.push(`base ${JSON.stringify(base)} is not a version branch (expected e.g. 8.19 or 9.x; main-based PRs go through create_pull_request)`);
              }
              const headBranch = String(request.head_branch || '').trim();
              if (!/^fix\/flaky-[0-9]+(-[a-z0-9]+)*$/.test(headBranch) || headBranch.length > 100) {
                errors.push(`head_branch ${JSON.stringify(headBranch)} does not match fix/flaky-<issue-number>-<short-kebab-slug>`);
              }
              const title = String(request.title || '').replace(/\s+/g, ' ').trim();
              if (!title || title.length > 256) {
                errors.push('title is missing or longer than 256 characters');
              }
              const body = String(request.body || '').trim();
              if (!body || body.length > 60000) {
                errors.push('body is missing or longer than 60000 characters');
              }
              // Same allowlist as create_pull_request's allowed-labels.
              const exactLabels = new Set(['backport:skip', 'backport:all-open', 'backport:version']);
              const labels = String(request.labels || '').split(',').map((label) => label.trim()).filter(Boolean);
              for (const label of labels) {
                if (!exactLabels.has(label) && !/^v[89]\.[0-9]+\.[0-9]+$/.test(label)) {
                  errors.push(`label ${JSON.stringify(label)} is not in the allowlist`);
                }
              }
              const reviewer = String(request.reviewer || '').trim().replace(/^@/, '');
              if (reviewer && !/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(reviewer)) {
                errors.push(`reviewer ${JSON.stringify(reviewer)} is not a valid GitHub login`);
              }
              // The patch travels inside the agent artifact (downloaded next to
              // agent_output.json), never through prose the agent could be tricked into echoing.
              const patchPath = path.join(path.dirname(outputPath), 'aw-version-fix.patch');
              if (!fs.existsSync(patchPath)) {
                errors.push('aw-version-fix.patch was not found in the agent artifact (the agent must write it with git format-patch before calling this tool)');
              } else {
                const patchSize = fs.statSync(patchPath).size;
                if (patchSize === 0) errors.push('aw-version-fix.patch is empty');
                if (patchSize > 4 * 1024 * 1024) errors.push('aw-version-fix.patch is larger than the 4MB cap');
              }
              if (errors.length) {
                core.setFailed(`Refusing to open a version-branch PR:\n- ${errors.join('\n- ')}`);
                return;
              }
              fs.copyFileSync(patchPath, path.join(process.env.RUNNER_TEMP, 'version-fix.patch'));
              // The body goes through a file (not a step output) so its content can't
              // leak into shell interpolation or output parsing.
              fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'pr_body.md'), body);
              core.setOutput('base', base);
              core.setOutput('head_branch', headBranch);
              core.setOutput('title', title);
              core.setOutput('labels', ['flaky-test-fixer', 'release_note:skip', ...labels].join(','));
              core.setOutput('reviewer', reviewer);
        - name: Apply the patch onto the base branch and push
          env:
            BASE: ${{ steps.validate.outputs.base }}
            HEAD_BRANCH: ${{ steps.validate.outputs.head_branch }}
          run: |
            set -euo pipefail
            git config user.name "kibanamachine"
            git config user.email "42973632+kibanamachine@users.noreply.github.com"
            # Bounded fetch: only the base branch's tip. Unlike the create_pull_request
            # handler's unbounded history fetch, this finishes in a couple of minutes.
            git fetch --depth=1 origin "refs/heads/${BASE}:refs/remotes/origin/${BASE}"
            git checkout -b "${HEAD_BRANCH}" "refs/remotes/origin/${BASE}"
            git am --3way "${RUNNER_TEMP}/version-fix.patch"
            changed_files=$(git diff --name-only "refs/remotes/origin/${BASE}..HEAD")
            file_count=$(printf '%s\n' "${changed_files}" | grep -c . || true)
            echo "Patch changes ${file_count} file(s):"
            printf '%s\n' "${changed_files}"
            if [ "${file_count}" -eq 0 ]; then
              echo "::error::The patch produced no changes on ${BASE}"
              exit 1
            fi
            if [ "${file_count}" -gt 100 ]; then
              echo "::error::The patch changes ${file_count} files (cap is 100)"
              exit 1
            fi
            # Mirror the create_pull_request handler's protected-path policy: no
            # top-level dot-folders (.github, .buildkite, ...) and no manifest/lock/
            # ownership files anywhere. A test-side fix never needs these.
            while IFS= read -r changed_file; do
              [ -z "${changed_file}" ] && continue
              case "${changed_file}" in
                .*)
                  echo "::error::The patch touches protected path ${changed_file}"
                  exit 1
                  ;;
              esac
              case "$(basename "${changed_file}")" in
                package.json|yarn.lock|package-lock.json|pnpm-lock.yaml|npm-shrinkwrap.json|CODEOWNERS|AGENTS.md|CLAUDE.md|README.md|renovate.json)
                  echo "::error::The patch touches protected file ${changed_file}"
                  exit 1
                  ;;
              esac
            done <<< "${changed_files}"
            # --force keeps re-runs working if a previous attempt already pushed the
            # branch; the namespace is validated to fix/flaky-* above.
            git push --force origin "HEAD:refs/heads/${HEAD_BRANCH}"
        - name: Open the draft PR and link the outcome comment
          uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
          env:
            GH_AW_BASE: ${{ steps.validate.outputs.base }}
            GH_AW_HEAD_BRANCH: ${{ steps.validate.outputs.head_branch }}
            GH_AW_PR_TITLE: ${{ steps.validate.outputs.title }}
            GH_AW_PR_LABELS: ${{ steps.validate.outputs.labels }}
            GH_AW_INTRODUCER: ${{ steps.validate.outputs.reviewer }}
          with:
            # kibanamachine (a user), not the GITHUB_TOKEN bot, so the PR's `opened`
            # event can trigger the Flaky Fix Verifier.
            github-token: ${{ secrets.KIBANAMACHINE_TOKEN }}
            script: |
              const fs = require('fs');
              const path = require('path');
              const { owner, repo } = context.repo;
              const body = fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'pr_body.md'), 'utf8');
              const { data: pr } = await github.rest.pulls.create({
                owner,
                repo,
                base: process.env.GH_AW_BASE,
                head: process.env.GH_AW_HEAD_BRANCH,
                title: process.env.GH_AW_PR_TITLE,
                body,
                draft: true,
              });
              core.info(`Opened draft PR #${pr.number}: ${pr.html_url}`);
              const labels = (process.env.GH_AW_PR_LABELS || '').split(',').filter(Boolean);
              if (labels.length) {
                await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels });
              }
              // The request_fix_review job only serves create_pull_request PRs (it is
              // gated on safe_outputs' created_pr_number), so request reviewers here.
              const isBot = (login) => !login || login.endsWith('[bot]') || login === 'kibanamachine';
              const reviewers = [];
              const requestedBy = (process.env.GH_AW_REQUESTED_BY || '').trim();
              if (!isBot(requestedBy)) reviewers.push(requestedBy);
              const introducer = (process.env.GH_AW_INTRODUCER || '').trim();
              if (introducer && !isBot(introducer) && !reviewers.includes(introducer)) reviewers.push(introducer);
              if (reviewers.length) {
                try {
                  await github.rest.pulls.requestReviewers({ owner, repo, pull_number: pr.number, reviewers });
                  core.info(`Requested review from ${reviewers.join(', ')} on #${pr.number}.`);
                } catch (err) {
                  // Non-fatal: GitHub 422s if a user can't review (not a collaborator, etc.).
                  core.warning(`Could not request reviewers on #${pr.number}: ${err.status || ''} ${err.message}`);
                }
              }
              // Fill the outcome-comment placeholders — the link_fix_pr job only runs
              // for PRs created by safe_outputs, so this path does it itself.
              const commentId = Number(process.env.GH_AW_COMMENT_ID);
              if (!Number.isInteger(commentId) || commentId <= 0) {
                core.info('No outcome comment id; skipping placeholder fill.');
                return;
              }
              const { data: comment } = await github.rest.issues.getComment({ owner, repo, comment_id: commentId });
              const badge = `[<img src="https://img.shields.io/github/pulls/detail/state/${owner}/${repo}/${pr.number}">](${pr.html_url})`;
              const updated = (comment.body || '').replaceAll('%%FIX_PR_URL%%', pr.html_url).replaceAll('%%FIX_PR_BADGE%%', badge);
              if (updated !== comment.body) {
                await github.rest.issues.updateComment({ owner, repo, comment_id: commentId, body: updated });
                core.info(`Filled fix-PR placeholders for #${pr.number} in comment ${commentId}.`);
              }
        # Fallback: if anything above failed, swap the dangling placeholders in the
        # outcome comment for a short error notice pointing at the run logs. The
        # proposed patch stays downloadable from the run's `agent` artifact.
        - name: Report the failure on the issue
          if: failure()
          uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
          with:
            github-token: ${{ secrets.KIBANAMACHINE_TOKEN }}
            script: |
              const commentId = Number(process.env.GH_AW_COMMENT_ID);
              if (!Number.isInteger(commentId) || commentId <= 0) {
                core.info('No outcome comment to update.');
                return;
              }
              const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
              const notice = `⚠️ Something went wrong while opening the fix PR — check the [run logs](${runUrl}) for details. The proposed patch can be downloaded from the run's \`agent\` artifact (\`aw-version-fix.patch\`).`;
              const { owner, repo } = context.repo;
              const { data: comment } = await github.rest.issues.getComment({ owner, repo, comment_id: commentId });
              const body = comment.body || '';
              let updated = body.replaceAll('%%FIX_PR_URL%%', '(not opened)').replaceAll('%%FIX_PR_BADGE%%', notice);
              if (updated === body) updated = `${body}\n\n${notice}`;
              await github.rest.issues.updateComment({ owner, repo, comment_id: commentId, body: updated });
              core.info(`Reported the PR-creation failure in comment ${commentId}.`);

strict: false
timeout-minutes: 90
---

# Flaky Test Fixer

Open a single draft PR with the smallest possible test-side fix for this flaky-test issue. Do not open a PR if either of the following is true: you find an existing open PR with an identical or similar fix (search PRs for ones that reference this issue number in their body, or check the issue timeline for PRs that reference it), or you cannot identify a credible fix. Whatever the outcome, always finish by leaving one concise comment on the issue (see "Outcome comment").

## Requester mention

`${{ env.REQUESTED_BY }}` triggered this run — the user who applied `ai:fix-flaky`, or the manual dispatcher. @-mention them (`@${{ env.REQUESTED_BY }}`) in both the outcome comment and the PR body so they get pinged to review the outcome and the fix, but **only if it is a real user account**: if `${{ env.REQUESTED_BY }}` ends with `[bot]` or is `kibanamachine`, omit the mention (and the "Requested by" line) entirely.

## Environment

Kibana is already bootstrapped for you. The `bk` (Buildkite) CLI is installed and authenticated and `BUILDKITE_ORGANIZATION_SLUG` is `elastic`, so you can inspect CI builds and download failure artifacts (JUnit XML, screenshots, server logs) when you need to re-investigate (see "Validate the investigation is current").

The branches this issue's failures were observed on have been parsed into `/tmp/gh-aw/agent/flaky-failing-branches.txt` (space-separated, e.g. `8.19 main`; empty means parsing failed — derive them from the issue yourself). For every non-`main` branch listed, `origin/<branch>` and the commit history needed for merge-bases are already fetched.

## Steps

1. **Establish a current root-cause analysis.** Read the failed-test investigator's comment(s) on the issue for the suspected root cause and proposed fix, and note the most recent one's permalink, timestamp, any attribution it makes (e.g. an implicated PR/commit), and where the failures happened, so you can cite them in the PR's Context section. **Do not treat that comment as ground truth**: a prior analysis can be based on stale data or superseded guidance, and building on a stale diagnosis is a top cause of fixes that don't hold. Assess whether it is still current and, when it is not, re-investigate from scratch before proposing anything — see [Validate the investigation is current](#validate-the-investigation-is-current). If, after that, no action is needed, skip to step 7.
2. Read the failing test and the helpers, fixtures, and page objects it imports.
3. Decide where the fix should land — see [Choosing the target branch](#choosing-the-target-branch). In short: `main` is the vehicle whenever the flaky pattern exists there, even if the failures were only observed on a version branch (backport labels deliver the fix there); target a version branch directly only when `main` cannot carry the fix.
4. Apply the smallest test-side patch that addresses the root cause on the target branch. Don't add explanatory code comments to the patch by default — a good test-side fix is self-explanatory. Add one only when the fix is particularly involved or non-obvious, and keep it to 1–2 sentences; a simple change like a timeout bump never warrants a comment.
5. Verify the patch: lint and type check it with `node scripts/eslint` and `node scripts/type_check` (and, for a Jest test, run it with `node scripts/jest`). FTR/Scout tests need a live Elasticsearch + Kibana and cannot be run here.
6. Decide the backport strategy and open the PR (see "PR format" and "Backport label" below). A `main`-based PR goes through the `create_pull_request` safe output; a version-branch PR goes through the `open_version_branch_pr` tool instead (see "Version-branch mechanics") — never both in one run.
7. Post the outcome comment on the issue (see "Outcome comment" below). Do this in every run, whether or not you opened a PR.
8. Remove the `ai:fix-flaky` label from the issue via the `remove-labels` safe output. Do this in **every** run once you have a result — whether you opened a PR, found an existing one, or opened none.
9. **Only if you opened a `main`-based PR via `create_pull_request` in step 6**, call the `link_fix_pr` tool with `confirm: true`. It runs after the PR and your comment exist and replaces the `%%FIX_PR_URL%%` and `%%FIX_PR_BADGE%%` placeholders in your outcome comment with the PR link and a live PR-state badge. You cannot know the PR number while running (the PR is created afterwards), so leave the placeholders in place and never write the URL, number, or badge yourself — this tool is how they get filled. Skip this for a version-branch PR: the `open_version_branch_pr` job fills the placeholders itself.
10. **Only if you opened a `main`-based PR in step 6 and confidently identified a real, non-bot introducing PR author** (the same person you `cc`'d on the `Fixes` line), call the `request_fix_review` tool with their GitHub login in `author` (no leading `@`) to request them as a reviewer on the fix PR. Skip this otherwise — you couldn't identify the author, or it's a bot (includes `kibanamachine`). Like `link_fix_pr` it runs after the PR is created. For a version-branch PR, pass the author in `open_version_branch_pr`'s `reviewer` input instead.

## Validate the investigation is current

The investigator's comment is a starting hint, not a verdict you can trust blindly — it is a snapshot from when it was written, and both the code and the failure pattern move on. Before you build a fix on it, confirm it still reflects reality. Treat the analysis as **stale** and re-run a complete investigation yourself when **any** of these hold:

- it was posted **more than 1 day ago** (older analyses have drifted from the current code and failure signature more often than not);
- **new failures arrived after it** — e.g. `kibanamachine` "New failure for …" notification comments, or CI-data updates, timestamped later than the analysis. A later failure can mean the symptom has shifted, so the prior root cause may no longer be the operative one; or
- the comment is **absent**, or offers no actionable root cause.

To re-investigate, follow the `flaky-test-investigator` skill at `.agents/skills/flaky-test-investigator/SKILL.md` end to end (read the files in that folder directly; do not invoke the skill).

- Where your fresh conclusion **departs** from the prior comment, say so and why in the PR's Context section.

## Choosing the target branch

Start from where the failures were observed: the issue body's `First failure: [<pipeline> - <branch>](...)` line and each kibanamachine `New failure: [<pipeline> - <branch>](...)` comment name the branch (pre-parsed into `/tmp/gh-aw/agent/flaky-failing-branches.txt`, see "Environment"). Observed branches only tell you where it *failed* — pick the target by combining them with the state of `main`:

- **Failures on `main`** (alone or alongside version branches): fix on `main` and propagate with backport labels (see "Backport label").
- **Failures only on version branch(es), but the flaky pattern still exists on `main`** (same test, same anti-pattern): still fix on `main`, applying `backport:version` plus the failing branches' `vX.Y.Z` labels. The backport delivers the fix where it failed, and a `main`-based PR is the one you can fully verify here.
- **Failures only on version branch(es), and `main` no longer has the problem**:
  - `main` was fixed by an identifiable PR → follow "Fix already on `main`" (backport recommendation, or an extracted fix as a version-branch PR);
  - the test only exists on the version branch (deleted or rewritten on `main`, or skipped only there) → open the PR against that version branch (see "Version-branch mechanics").

## Version-branch mechanics

When the PR must target a version branch (`base` ≠ `main`), do **not** use `create_pull_request` — its handler cannot fetch a version branch on a repo Kibana's size (it only allows `main` bases). Use the `open_version_branch_pr` tool, whose job opens the PR deterministically after your run finishes:

- The pre-agent setup already fetched each failing branch's tip and the treeless commit history, so `origin/<version-branch>` and merge-base computations work without further fetching. If you still need more git data, fetch in the **foreground** with `--filter=tree:0`, and never kill a running `git fetch`: an interrupted fetch leaves a stale `.git/shallow.lock` that the sandbox won't let you remove.
- Create the fix branch from `origin/<version-branch>`, craft the patch from that branch's copy of the file(s), and commit it there.
- Export the patch for the PR-opening job (it ships in the run's artifact, is scanned by threat detection, and gets applied with `git am --3way`):

  ```bash
  git format-patch origin/<version-branch>..HEAD --stdout > /tmp/gh-aw/aw-version-fix.patch
  ```

- Call `open_version_branch_pr` with `base` (the version branch), `title`, `body`, and `head_branch` per "PR format", plus `labels` (comma-separated, see "Backport label") and optionally `reviewer` (see step 10).
- Write the outcome comment exactly as for a `main` PR — keep the `%%FIX_PR_URL%%` / `%%FIX_PR_BADGE%%` placeholders; the `open_version_branch_pr` job fills them once the PR exists (do not call `link_fix_pr` on this path). If opening the PR fails, the job replaces the placeholders with a short error notice linking to the run logs, where the patch remains downloadable.

## PR format

Write the body so a developer can grasp the fix and its root cause at a glance, from the PR alone — without needing to open links or leave the page (links are still welcome for anyone who wants to dig deeper).

- **Branch**: name the PR's source branch `fix/flaky-<issue-number>-<short-kebab-slug>` (e.g. `fix/flaky-275144-host-flow-ingestion-wait`) to keep fixer branches uniform.
- **Title**: `[<Plugin name>] <concise summary of the fix>`. Derive the plugin name from the test file path (e.g. `x-pack/solutions/security/plugins/security_solution/...` → `Security Solution`).
- **Body**:
  ```
  Fixes #<issue-number> - likely introduced by #<introducing-pr> (cc @<introducing-pr-author>)

  ### Summary
  <a few bullet points: what was failing, and what this patch changes - keep it very concise, every bullet point must be earned>

  ### Context
  <a few bullet points of history around this flake, in the same concise, high-value style as the Summary — every bullet earned, and omit any you cannot back with real evidence (never guess a PR or attribution). Cover, where known:
  - a link to the failed test investigator's comment on the issue, flagging whether this patch follows or departs from their proposed fix — and, if you re-investigated because that comment was stale (see "Validate the investigation is current"), say so and summarize what your fresh analysis concluded
  - a one-line recount of where the failures happened — e.g. the CI pipeline/lane and how often/recently — from the issue's CI data and the investigator's comment>

  <details>
  <summary>Verification</summary>

  #### Verified locally

  <one line per check you ran on this branch, each prefixed with its status — `✅ Passed:` when it succeeded, `⚠️` when it failed — followed by the exact command; on a `⚠️` line, add a short note after the command explaining what failed, e.g.
  `✅ Passed: node scripts/eslint <files>`
  `✅ Passed: node scripts/type_check --project <tsconfig>`
  `⚠️ node scripts/jest <test> — 1 assertion still failing (<one-line reason>)`>

  #### Not verified locally

  <bullet list of what you could not verify and why. E.g., behavior under CI parallel load, on a different stack version, against a real Elasticsearch instance, etc. Omit this section if there is nothing to mention.>

  </details>

  <details>
  <summary>Backporting guidance</summary>

  <one or two sentences: which backport label(s) you applied — `backport:skip`, `backport:all-open`, or `backport:version` with the per-branch `vX.Y.Z` labels — or that you applied none because you weren't sure, and why. Say which open release branches (from `versions.json`) the failing test exists on and whether this patch applies there unchanged. If you left it unlabeled, note which versions a reviewer should consider.>

  </details>
  ```

The first line attributes the flake:
- **Introducing PR** (`#<introducing-pr>`): the PR you believe introduced the flake — find the PR that first added the failing test with `git log` / `git blame` on the test file, or prefer a specific PR/commit the investigator implicated as the cause. The `likely` hedge is intentional: this is an informed suspicion, not a proven cause, so keep it. If you can't identify a well-supported candidate, omit the whole `- likely introduced by …` clause and keep just `Fixes #<issue-number>` — never guess.
- **cc** (`@<introducing-pr-author>`): `@`-mention that PR's author so they're looped in on the fix; drop the `(cc @…)` if the author is a bot (includes `kibanamachine`). Request this same person as a reviewer via the `request_fix_review` tool (see Steps).
- Add more `Fixes #<issue-number>` references if this fix resolves multiple issues.

Add the following at the very end of the PR description (and outside of the details block):

```markdown
> [!NOTE]
> Requested by @${{ env.REQUESTED_BY }}. Share feedback in #kibana-qa. Mention `@copilot` to make quick changes.
```

(Per "Requester mention", drop `Requested by @${{ env.REQUESTED_BY }}.` from the NOTE if the requester is a bot or `kibanamachine`, leaving the rest of the NOTE.)

## Backport label

The guiding principle is to backport a fix to every older active version branch where it still applies — don't leave older branches flaky, so propagate the fix as widely as it safely fits.

Only apply backport labels when you are **confident** about the decision. If you're unsure, apply **no** backport label at all and explain the uncertainty in the "Backporting guidance" section so a human can decide. Never guess.

When you are confident, pick the backport policy and pass the matching label(s) in the `labels` field of the `create_pull_request` safe output — or, for a version-branch PR, of the `open_version_branch_pr` tool (the `flaky-test-fixer` label is added automatically either way). First figure out which open `release` branches (listed in `versions.json` at the repository root) the fix belongs on by confirming the failing test's file exists at each branch's `ref` (e.g. read the path at that ref via the GitHub API), then choose:

- **`backport:skip`** — the fix is effectively main-only: the failing test (or the file you patched) doesn't exist on any open release branch, it was recently added, or the flakiness is specific to `main`.
- **`backport:all-open`** — the same test exists on **every** open release branch and your patch applies there unchanged, so fixing it across all of them is safe.
- **`backport:version` + one `vX.Y.Z` label per target branch** — only *some* open release branches need the fix. Pass `backport:version` **together with** the version label for each target branch, mapping the branch to its current version in `versions.json` (e.g. `9.4` → `v9.4.4`, `9.3` → `v9.3.8`). Include a branch's label only when you've confirmed the test exists there.

Always explain the choice — including a deliberate no-label decision — in the "Backporting guidance" section.

## Fix already on `main`

Sometimes the failure is on a **version branch** (e.g. `9.3`) while `main` already carries the fix — it was fixed on `main` and never backported. The tell: the root cause the investigator flagged is already resolved on `main` (the anti-pattern the fix would remove is already gone), so there's nothing to change on `main`. This only applies to a version-branch failure — determine the failing branch from the issue's CI data or the investigator's comment; a `main` failure is the normal flow above.

When it happens, do **not** open a normal `main` PR. Find the `main` PR that already fixed it (`git log` / `git blame`, or the PR the investigator implicated), then:

- **Contained `main` PR** (small and single-purpose — essentially just the fix and its test, no unrelated refactors, so it backports cleanly): do **not** open a PR. Post the "Backport the existing fix" outcome comment naming that PR and the release branch(es) that still need it. When unsure whether it backports cleanly, prefer this — a recommendation beats an unverified PR.
- **Not-contained `main` PR** (bundles unrelated changes, so a whole-PR backport isn't safe): open a **best-effort draft PR against the failing version branch** with just the extracted fix, via the `open_version_branch_pr` tool, following "Version-branch mechanics". You're bootstrapped on `main`, so you can't lint or type-check against the version branch: list the skipped checks under "Not verified locally" (note it targets `<branch>` and relies on that branch's CI). If other release branches still need the fix too, apply the matching `backport:version` + `vX.Y.Z` labels (per "Backport label", but leave out `main` and any branch already fixed) so it propagates there on merge.

## Outcome comment

In **every** run, finish by posting exactly one short comment on issue #${{ env.ISSUE_NUMBER }} via the `add-comment` safe output, and removing the `ai:fix-flaky` label (see step 8). Format the comment as a short `###` heading that states the outcome (with the leading emoji shown below), followed by a single sentence of detail, then `cc @${{ env.REQUESTED_BY }}` at the very end (see "Requester mention", only append if the requester isn't a bot). No other preamble or sign-off.

Follow this format:

- **PR opened**:
  ```markdown
  ### ➡️ A fix PR is ready for review: %%FIX_PR_URL%%

  <one very concise sentence on what the PR changes>. cc @<github-handle-here>

  %%FIX_PR_BADGE%%
  ```
  Include the `%%FIX_PR_URL%%` and `%%FIX_PR_BADGE%%` placeholders verbatim — the `link_fix_pr` tool (for a `main`-based PR) or the `open_version_branch_pr` job (for a version-branch PR) replaces them with the PR link and a live PR-state badge. Never write the PR URL, number, or badge yourself.
  
- **Existing PR already covers it**:
  ```markdown
  ### 🔁 A fix is already in flight

  #<PR number> already covers this, so no duplicate PR was opened. cc @<github-handle-here>
  ```
- **No PR opened**:
  ```markdown
  ### ⏭️ No fix PR was opened

  The failure is infrastructure-side (the CI agent lost its Elasticsearch connection mid-run), not test-side, so there's nothing to patch here. cc @<github-handle-here>
  ```
  Swap in the actual one-clause reason — e.g. the test already passes on `main`, the failure is infrastructure / not test-side, or the root cause can't be confidently identified.
- **Backport the existing fix** (fix already on `main`, contained PR — no PR opened):
  ```markdown
  ### The fix is already on `main` — it needs backporting

  #<main-PR> already fixed this on `main`; add the `backport:version` + `<vX.Y.Z>` label(s) to it to backport to <branch(es)>. cc @<github-handle-here>
  ```
  Fill `<vX.Y.Z>` from the branch → version mapping in "Backport label" (only the branches that still need the fix).
