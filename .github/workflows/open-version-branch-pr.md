---
description: >-
  Shared safe-job for the Flaky Test Fixer: deterministically opens a draft fix
  PR against a version branch (base ≠ main) from the agent's exported
  `git format-patch` output, bypassing the create_pull_request handler whose
  unbounded base-branch fetch cannot finish on a repo Kibana's size.
safe-outputs:
  jobs:
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

---
