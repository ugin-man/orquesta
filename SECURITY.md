# Security Policy

## Supported version

Security fixes currently target the newest `0.4.0-preview.x` release candidate. Older previews are not maintained as separate supported lines.

## Reporting a vulnerability

Use the repository's GitHub Security Advisory “Report a vulnerability” form when it is available. Do not publish secrets, credentials, or working exploit details in a public issue. If private reporting is unavailable, contact the maintainer through the GitHub profile before sharing sensitive details.

## Preview security boundary

Orquesta relies on the Codex harness for sandboxing and approvals. The Desktop does not add a second sandbox. A prepared or accepted dispatch is not proof that a Codex turn ran, and repository-only fallback cannot claim live execution.

The release-candidate audit on 2026-08-07 reported zero known vulnerabilities for the root production dependency tree and zero for the Desktop production dependency tree. The full Desktop development/build tree reported 28 transitive findings: 1 critical, 23 high, 1 moderate, and 3 low. They are associated with the Electron Forge build toolchain and its transitive `tar`/`tmp` paths, not the packaged runtime dependency set. This is a disclosed preview-build risk, not a claim that the development environment is vulnerability-free. It must be reviewed again before publishing the tag.
