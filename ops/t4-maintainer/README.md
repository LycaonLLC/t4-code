# T4 live OMP maintainer

This user service watches the official Oh My Pi releases and gives GPT-5.6 Sol ownership of each T4 compatibility update and publication. It runs with the normal host account, full host resources, the standard OMP toolset, existing `gh` authentication, and `yolo` approvals. Every newly detected stable OMP release enters the live release workflow immediately.

The timer checks every two hours and uses GitHub's latest stable release as its target, so several upstream releases between checks collapse into one update to the newest release. `flock` keeps one maintainer active at a time. The dedicated OMP profile is `t4-maintainer` and its sessions remain available for follow-up.

The profile's `auth-broker.token` is a symlink to the existing mode-0600 broker token file. This keeps one credential source while giving OMP the profile-local path it resolves at launch.

Sol performs the complete release: fork sync, appserver/app-wire reconciliation, version and provenance updates, normal release checks, commits, pushes, merges, immutable tags, GitHub publication, and site deployment. The wrapper records `state/processed.json` only after it independently confirms the integration tag, T4 tag, non-draft GitHub release, all six public release files, and the release bundle currently served by `t4code.net`.

Runtime data lives at `~/.local/share/t4-maintainer`:

- `state/processed.json` — latest fully verified publication
- `runs/<omp-version>-<timestamp>/` — context, Sol session output, workspace, and result
- `logs/service.log` and `logs/service.error.log` — persistent service output
- `libexec/` — the installed runner and positive maintainer prompt
- `environment` — mode-0600 references for the existing OMP auth broker URL and token file

Install and enable the user timer:

```bash
./ops/t4-maintainer/install.sh
```

Useful operator commands:

```bash
systemctl --user status t4-omp-maintainer.timer
systemctl --user list-timers t4-omp-maintainer.timer
systemctl --user start t4-omp-maintainer.service
tail -f ~/.local/share/t4-maintainer/logs/service.log
```

`install.sh --check` validates the scripts, live tool availability, timer calendar, and rendered systemd units without installing them. Installation adopts the current public T4 release only after running the same public verification used after future Sol releases, so enabling the timer starts from proven state and waits for the next official stable OMP version.
