# Moving an existing local roster into Git

`orchestration/` is the versioned source for shared agent profiles, selected
skills, the Main prompt, and sub-agent settings. A local file is an experiment
until its reviewed replacement is committed and published on `origin/develop`.
The sample profiles in this checkout do **not** contain the operator's previous
local files. Pi Web cannot inspect your Mac from a different machine. Pi Web
started from this checkout discovers the roster automatically; an independently
installed Pi Web package still needs `PI_WEB_ROSTER_ROOT` set by its operator.

## Inventory before replacing anything

On the Mac that has the existing files, run this from a clean `develop` checkout
after merging the pending roster PR into `develop`:

```bash
git fetch origin develop
export PI_WEB_ROSTER_ROOT="$(pwd)/orchestration"
node scripts/check-roster-migration.mjs
```

The script reads these exact sources, including hidden files and resources
behind symlinks:

| Local source | Git destination |
| --- | --- |
| `~/.agents/skills/*` | `orchestration/skills/*` |
| `~/.pi/agent/agents/*.md` | `orchestration/agents/*.md` |
| `~/.pi/agent/agents/settings.json` | `orchestration/subagent-settings.json` (runtime default) |
| `~/.pi/agent/APPEND_SYSTEM.md` | `orchestration/APPEND_SYSTEM.md` (Main fallback) |

The settings file needs special attention: it lives inside `agents/*`. Its
absence used to switch off Pi Web's built-in sub-agents and reset the
concurrency limit to the built-in default. The shared settings must be active
before moving that local directory.

The inventory checks exact bytes for profiles, skills, skill supporting files,
the prompt, and the settings file. It reports files missing from Git, changed
content, Git metadata in separately cloned skill trees, broken links, and
uncommitted roster edits. Different bytes need manual review; differences may
be intentional, but this script cannot decide that safely. For an intentional
replacement, inspect the local and tracked texts privately, then pass the
precise `--reviewed local/path=localSHA256:repositorySHA256` argument printed
for that difference. A changed byte in either file invalidates acknowledgment.
If a local experimental profile or skill should be **retired** instead of
committed, inspect it privately and use the printed
`--retired local/path=resourceSHA256` argument. It can name an entire old
skill directory or a specific old agent profile. Its hash covers filenames,
file contents, and links in that tree; changing anything invalidates the
acknowledgment. Retirement cannot waive the Main prompt or sub-agent settings
check. Keep a private backup of retired files until the new runtime has passed
the smoke test; the script never deletes or silently ignores them.
The script prints hashes and paths, never prompt or skill contents. Review all
historical local resources and credentials privately **before** committing
them to this public repository. A separate skills Git repository can be retained separately until
there is a reviewed, pinned way to reference it from this roster; a link from
`orchestration/skills` outside the roster root cannot currently load safely.

The check requires the current committed roster to be contained in the live
`origin/develop` branch. A draft PR or an unpublished local commit cannot
make the result green. It never imports, changes, or deletes a local file.
You may also use `--json` to save the report privately; review paths before
sharing it.

The script also blocks if `~/.pi/agent/skills/` contains resources, or if
`~/.pi/agent/main-agent-config.json` has global overrides. These are outside
the proposed deletion paths and need separate review. Check any project `.pi/`
resources, which can still add skills or override Main's repository configuration. A local
`APPEND_SYSTEM.md`, even an empty one, shadows the tracked Main fallback.

## Reversible runtime check

Only after the inventory has no blockers, finish or pause running agent
sessions, save the inventory report, and move the **three specified sources**
into a private backup outside the SDK discovery directories. Preserve the
directory structure and links; `mv` of a symbolic link moves only the link,
not the external repository it names. Keep the backup until you have tested
and inspected it. For a reversible check, from the same shell as your first
inventory run:

```bash
mkdir -p "$HOME/.pi/roster-backups"
roster_backup=$(mktemp -d "$HOME/.pi/roster-backups/check-XXXXXX")
for item in "$HOME/.agents/skills" "$HOME/.pi/agent/agents" "$HOME/.pi/agent/APPEND_SYSTEM.md"; do
  if [ -e "$item" ] || [ -L "$item" ]; then
    mv "$item" "$roster_backup/$(basename "$item")"
  fi
done
printf 'Private backup: %s\n' "$roster_backup"
```

Write down the printed backup path. If the check fails, stop Pi Web and
restore the moved paths one at a time, for example
`mv "$roster_backup/agents" "$HOME/.pi/agent/agents"` (only after checking
that the destination is absent). Restart the Pi Web server from this checkout,
or set `PI_WEB_ROSTER_ROOT` to the absolute path of the checkout's
`orchestration` directory when using another installed package. Run a new
session in a trusted project and check:

1. Settings → Main reports the repository prompt and selected skills as the
   effective defaults; a project or global override should be deliberate.
2. Settings → Sub-agents lists the repository agents. Built-in delegation is
   enabled with the intended concurrency limit after `agents/settings.json`
   was moved away.
3. A coordinator can delegate a narrow task to Reader, Analyst, Writer, and
   Verifier; the child sees only its selected skills and the required context.
   Check the map and a request for later evidence from Reader.
4. Reopen the app from another project or working directory; the same shared
   profiles and Main defaults should appear. Existing sessions may retain
   their earlier pinned resources, so use a **new** session for this test.

If any step fails, stop the server and restore the original files from the
private backup before restarting it. Remove backups only after the test,
repository review, and any users of the old `~/.agents/skills` links have been
accounted for. Passing the inventory alone does **not** authorize deletion:
it cannot prove which prompt was active in a live process or whether another
application used the removed links.
