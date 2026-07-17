# Execute The User-Service Installation Smoke

Read `docs/agents/smoke-testing.md` completely. This smoke mutates global per-user service state;
stop unless the user explicitly requested installation testing and approved the exact config/state
paths and cleanup behavior.

Verify the installation lifecycle separately from real-driver smokes:

1. Build `./dist/caara` and record its version/checksum.
2. Record existing service status, receipt, config, state, generated roles/guidance, and installed
   binary without exposing secrets.
3. Install the current compiled artifact with the requested options.
4. Prove the service manager invokes the installer-owned binary and the installed checksum/version
   matches `./dist/caara`.
5. Run health, status, doctor, diagnostic portable start/wait/viewer/cancel, and service restart
   recovery. Do not invoke a paid target.
6. Verify generated Caara-owned roles/guidance and service execution PATH behavior expected by the
   selected install options.
7. Uninstall only if the user authorized it. Without `--purge`, prove user-owned config/state/logs
   remain. Use `--purge` only with separate explicit approval.
8. Restore any pre-existing service state exactly or report why restoration is unsafe.

Retain commands, service-manager output, checksums, diagnostic JSON, viewer evidence, and a concise
assertion report under `temp.local/$(date +%F)/service-installation/<timestamp>/`. Never mix this
smoke with authenticated Claude, Antigravity, or Codex calls.

