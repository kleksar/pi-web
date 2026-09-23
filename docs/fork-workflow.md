# Keeping the personal Pi Web fork current

The official repository is `agegr/pi-web`, the personal fork is
`kleksar/pi-web`. Both are currently public. Keep the personal fork's `main`
as an exact fast-forward mirror of official `main`; develop features on
`develop`. Never merge `develop` into the fork's `main`.

## Check and update the mirror

```bash
git remote add upstream https://github.com/agegr/pi-web.git  # once per clone
git fetch upstream main
git fetch origin main develop
git merge-base --is-ancestor origin/main upstream/main
git push origin upstream/main:refs/heads/main
```

If the ancestry check fails, stop: the fork's `main` diverged and needs
investigation. The push is a fast-forward, and changes nothing when both refs
are equal.

## Update the development branch

Check whether `upstream/main` is already an ancestor of `origin/develop`:

```bash
git merge-base --is-ancestor upstream/main origin/develop
```

If that succeeds there is no new upstream base to apply. Otherwise, coordinate
a quiet window for `develop` and open feature branches. Record the exact
remote head before rebasing:

```bash
git fetch origin develop
old_develop=$(git rev-parse origin/develop)
sync_dir=$(mktemp -d)
git worktree add --detach "$sync_dir" origin/develop
git -C "$sync_dir" rebase upstream/main
```

Only after a successful rebase and project checks, publish the rebased head:

```bash
git -C "$sync_dir" push origin HEAD:refs/heads/develop \
  --force-with-lease=refs/heads/develop:$old_develop
git worktree remove "$sync_dir"
```

Resolve conflicts and run project checks before the final push. The lease
rejects a concurrent update to `develop`; never retry by overriding it. A
published rebase changes commit IDs, so rebase or recreate feature branches
and check open PRs afterwards. For a long-lived active development branch,
consider an ordinary merge of upstream into `develop` when preserving PR
history matters more than the preferred rebase policy.

At the time this catalog was prepared, official and fork `main` had the same
commit. `develop` had its own commit, and existing feature PRs were still
open. There was no new upstream base to rebase, and a PR proposing
`develop → main` would break the mirror rule if merged.
