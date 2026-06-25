# Orquesta Discovery Posting Plan

Date: 2026-06-25
Status: draft

## First Post Recommendation

Publish the Japanese introduction article first, then use short social posts to route people to the GitHub repository and `START_HERE.md`.

Recommended order:

1. Zenn, because the article already has frontmatter and a technical narrative.
2. Qiita as a lightly adapted repost if desired, after confirming the Zenn version reads cleanly.
3. X / Bluesky / Mastodon short posts after the article is live.

Do not present Orquesta as production-ready. Use beta language and ask for testers/collaborators who already feel the pain of one Codex thread growing too much context.

## First Post Angle

Lead with the pain:

- one Codex thread accumulates too much context
- role boundaries blur
- the orchestrator starts doing specialist work directly
- disposable subagents are useful, but not enough for durable specialist context

Then explain the current state:

- long-lived specialist Codex threads
- file-backed `.orquesta/` state
- mission-control local dashboard
- delegation gate and specialist reports
- user-side tasks
- vision/failure/user liaison layers
- trigger-audit question-candidate visibility without making `vision-curator` a watcher

## Short Social Copy

### Japanese

```text
Codexを「ひとつの巨大な作業スレッド」ではなく、長期専門AIチームとして使うためのCodex skill、Orquestaを作っています。
まだbetaですが、専門スレッドへの委任、file-backed state、mission-control型ローカルダッシュボード、delegation gate、trigger auditまで動いています。
同じ痛みがある人に触って壊してほしいです。
https://github.com/ugin-man/orquesta
```

### English

```text
I am building Orquesta, a Codex skill for running Codex as a long-lived specialist AI team instead of one overloaded thread.

It is still beta, but the current version has file-backed state, specialist handoffs, a mission-control local dashboard, delegation gates, user-side tasks, and trigger-audit visibility.

Feedback and collaborators welcome:
https://github.com/ugin-man/orquesta
```

## Pre-Posting Checks

- Confirm the article contains no mojibake or repeated literal question marks.
- Confirm the article links to GitHub and `START_HERE.md`.
- Confirm wording says beta, not stable release or production-ready.
- Confirm the article does not claim the dashboard alone proves multi-agent operation.
- Confirm current README and article agree on delegation evidence and trigger-audit boundaries.
