# Security Policy

## Supported version

Security fixes currently target the newest public `0.4.0-preview.x` release.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting or Security Advisory flow when available. Do not publish credentials, secrets, private project data, or working exploit details in a public issue.

If private reporting is unavailable, contact the maintainer through the GitHub profile before sending sensitive details.

## Security model

Orquesta is local-first and uses the existing Codex sandbox and approval boundaries for Codex actions. The Desktop renderer does not directly access the filesystem or launch project commands.

Preview builds are currently unsigned. Verify release checksums when downloading binaries from GitHub Releases.
