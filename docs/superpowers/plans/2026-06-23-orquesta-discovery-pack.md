# Orquesta Discovery Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Orquesta easier to discover and easier to understand for the first outside reader.

**Architecture:** Keep the product itself unchanged. Add a short first-run entry document, improve the README opening, add package keywords, document GitHub topic settings, and write a Japanese article draft that explains the motivation and beta state.

**Tech Stack:** Markdown, GitHub repository metadata guidance, Codex skill docs.

---

### Task 1: First-Reader Entry

**Files:**
- Create: `START_HERE.md`
- Modify: `README.md`

- [ ] Add a short first-reader guide with the problem, audience, install path, first prompt, expected bootstrap behavior, and beta caveats.
- [ ] Link it near the top of `README.md`.
- [ ] Keep the README opening focused on one clear value proposition.

### Task 2: Discoverability Metadata

**Files:**
- Modify: `package.json`
- Create: `docs/release/github-discovery.md`

- [ ] Add search-friendly `keywords` to `package.json`.
- [ ] Record recommended GitHub topics and the reason for each group.
- [ ] Note that this environment cannot update GitHub topics directly because `gh` is unavailable and no GitHub token is present.

### Task 3: Japanese Launch Article Draft

**Files:**
- Create: `docs/articles/zenn-orquesta-introduction.md`

- [ ] Write a Zenn/Qiita-ready Japanese draft.
- [ ] Lead with the pain: Codex work becomes hard when one agent owns too much context.
- [ ] Explain why Orquesta uses long-lived specialist threads instead of disposable subagents.
- [ ] Explain beta.2 honestly: what works, what is weak, and what feedback is wanted.

### Task 4: Verification

**Files:**
- All changed files

- [ ] Run `npm run check`.
- [ ] Run a quick `rg` pass to ensure the new docs are linked.
- [ ] Check `git status -sb`.
