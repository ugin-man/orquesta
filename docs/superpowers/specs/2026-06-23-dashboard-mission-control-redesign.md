# Orquesta Dashboard Mission Control Redesign Spec

## Purpose

This is the last major beta-era dashboard redesign for Orquesta. The goal is not only to make the dashboard prettier. The goal is to make a first-time viewer feel that Orquesta is a living Codex production team: multiple long-lived specialists exist, work moves between them, the user has a real seat in the system, and blockers or approvals are visible before they silently stall the project.

## Locked Direction

Use a **Mission Control** dashboard as the main direction.

The dashboard should feel like a calm, premium operations surface: white base, soft glass, refined typography, crisp status color, and Apple-like cleanliness. It should borrow a little from "AI company floor" visuals only inside the Team Visualizer: agents should feel alive through motion, glow, and status-specific behavior, without turning the app into a toy or weakening the information layout.

## Product Design Brief

- Product: Orquesta local dashboard for long-lived Codex specialist teams.
- Core screen: operations dashboard plus user task surface.
- Visual direction: premium white Mission Control, light Apple-like product UI, AI company energy, restrained but satisfying motion.
- Interactivity: full working dashboard controls must remain functional. Pan/zoom, hover inspector, user tasks, setup inputs, review forms, and language switching must keep working.
- Primary outcome: a user should immediately understand who is working, what they are working on, where the project is going, and whether the user needs to act.

## Current Problems

### 1. The first view is useful but not iconic

The current screen has good panels, but it does not produce one strong first impression. A viewer sees a dashboard, not an AI team coming alive.

Fix: make the first view a single Mission Control composition. The Team Visualizer should become the hero surface, with mission status, user waits, and completion map orbiting it as supporting instruments.

### 2. The Team Visualizer is informative but still too map-like

The current visualizer shows structure, pan/zoom, agent nodes, lines, and inspector details. That is good. But the nodes still read as UI cards more than as "specialists at work."

Fix: give each agent a stronger role badge, presence state, current-work pulse, and connection behavior. Active work should visibly travel along command lines. Waiting, blocked, approval-wait, and standby states should have distinct motion and color language.

### 3. Work flow and command flow are split

Task Flow, Completion Map, User Tasks, and Team Visualizer are separate pieces. The user has to mentally connect them.

Fix: connect state in the UI. Selecting an agent should highlight its current task, related completion item, blockers, and user waits. Selecting a completion phase should highlight the responsible agents. Approval waits should glow on both the user rail and the blocked agent.

### 4. User participation is not emotionally central enough

Orquesta is not fully autonomous, but the dashboard can still make user tasks feel like a side panel.

Fix: create a persistent "Your Turn" rail or dock. It should show answer questions, approval waits, report reviews, repair cards, and handoff actions as the user's active collaboration queue. It should be visually important but not noisy.

### 5. Completion Map feels like a progress component, not a production map

The current completion map communicates phases, but it does not yet feel like the project strategy.

Fix: show it as a strategic route: current focus, next phase, blocked phase, done phase. It should be compact enough for first view, expandable enough for details, and connected to agents.

### 6. The visual system lacks a signature

The current design is clean, but a little generic. It needs an Orquesta identity.

Fix: add a signature command-floor visual language:

- thin luminous command lines
- calm glass panels
- role-colored agent presence
- small motion loops for active agents
- high-quality empty states
- richer active/blocked/approval states
- consistent role icons or avatar marks

Do not add decorative blobs, heavy gradients, or generic SaaS hero styling.

### 7. The dashboard still exposes implementation history

Some labels and sections still reflect how features were built rather than how a user thinks: setup, handoff, report review, repair cards, production start, task flow.

Fix: keep the underlying data, but group it by user mental model:

- "Now": current work, active agents, blockers
- "Team": who exists and who is collaborating
- "Your Turn": what the user needs to do
- "Project Route": completion map and next milestones
- "Log": events and raw history

## Proposed Screen Architecture

### First View: Mission Control

The first screen should have four zones:

1. **Top command bar**
   - Orquesta identity
   - live connection chip
   - language toggle
   - state load button
   - compact global health

2. **Center command floor**
   - large Team Visualizer
   - active command lines
   - agent role pods
   - hover/selection inspector integrated into the floor, not detached like an unrelated card

3. **Right collaboration rail**
   - "Your Turn" queue
   - approval waits first
   - questions, report reviews, repair cards, handoff drafts
   - strong empty state: "All clear, team is moving"

4. **Bottom project route**
   - compact Completion Map strip
   - current focus
   - next milestone
   - blocked/done markers

Task flow and event log should be secondary drawers or lower panels, not first-view competitors.

### User Tasks View

The User Tasks view can remain a separate tab, but it should feel like a focused desk rather than a pile of panels.

Structure:

- left: task categories and counts
- center: selected user task content
- right: context, source agent, affected task, resume instruction

Vision questions should stay text-friendly, but answers must not lose focus during background refresh.

### Detail/Log View

Events, raw task flow, directives, and low-level state are useful, but they should read as a log/debug layer. They do not need first-view priority.

## Team Visualizer Behavior

### Agent States

Each agent should have a visibly distinct state:

- active: animated pulse, moving command line, current task chip
- standby: quiet but present
- blocked: amber lock/border and blocked reason
- approval wait: amber user-rail link plus waiting badge
- stale: dimmed with heartbeat warning
- completed/report-ready: green report badge

### Connections

Connections should communicate meaning:

- user to orchestrator: creative authority line
- user to vision-curator and user-liaison: direct collaboration lines
- orchestrator to production specialists: command lines
- specialist to specialist: collaboration lines only when task state records collaboration
- blocked-to-user: approval/user action line

Active lines should animate softly. Avoid four lines starting from the same crowded point. Keep the central spine concept, but make it feel intentional and polished.

### Inspector

The inspector should answer:

- What is this agent's role?
- What is it doing now?
- Who gave it the task?
- What is it waiting on?
- What artifact or report will prove completion?
- What should the user do, if anything?

The inspector should be visually tied to the selected node.

## Visual Style System

### Palette

Use a white and near-white base:

- base: #f7f9fc / #fbfcff
- panel: translucent white
- ink: near black
- muted: cool gray
- blue: command/selection
- cyan: live flow
- green: accepted/done
- amber: user wait/approval/blocker
- red: error
- violet: vision/creative

Avoid a one-note blue/purple theme. Use role color sparingly and consistently.

### Type

Use system UI / SF-like font stack. Keep hero-scale text only in the top health area. Agent nodes and panels should use dense, precise text.

### Motion

Motion should be meaningful:

- active line flow
- active agent pulse
- hover expansion
- selected-agent focus
- user-wait rail glow
- smooth pan/zoom

Avoid constant noise. Standby state should be calm.

### Layout

Desktop first view should target 1440px width but remain usable at laptop widths. Mobile should stack:

1. health
2. Your Turn
3. Team Visualizer
4. Project Route
5. logs/details

The Team Visualizer can remain pan/zoom on mobile, but controls and labels must not overlap.

## What To Keep

Keep these current strengths:

- file-backed live dashboard
- localhost refresh with unchanged-state caching
- language toggle
- pan/zoom team map
- agent inspector
- user task queue
- approval wait visibility
- completion map
- setup autopilot card
- browser DOM smoke expectations

## What To De-emphasize

These should remain available, but not dominate the first view:

- raw event log
- raw task list
- setup internals after setup completes
- low-level file loading language
- implementation-specific labels like "handoff prepared" unless in details

## Required Product Design Workflow

Before implementation, create visual options.

1. Use Product Design ideation to generate exactly three visual directions from this brief:
   - Mission Control Premium
   - AI Company Floor Light
   - Command Glass Board
2. Choose one direction.
3. Convert the chosen direction into an implementation plan.
4. Implement in small slices:
   - layout shell
   - Team Visualizer polish
   - Your Turn rail
   - Project Route strip
   - state linking/highlights
   - responsive polish
5. Verify with:
   - `npm run check`
   - browser console check
   - DOM smoke
   - desktop screenshot
   - mobile screenshot

## Non-Goals

- Do not rewrite Orquesta state schema unless the UI cannot express required state.
- Do not turn the dashboard into a landing page.
- Do not use fake decorative illustrations as the main value.
- Do not remove raw logs or task details; just demote them.
- Do not add a heavy frontend framework during this beta rework unless implementation proves the current static app cannot support the design.

## Acceptance Criteria

- First view communicates "AI team operating now" within five seconds.
- Active, standby, blocked, stale, approval-wait, and report-ready states are visually distinct.
- User action is obvious without opening multiple panels.
- Selecting an agent highlights related work and user waits.
- Completion Map reads as the project route, not just a checklist.
- UI feels premium and intentional, not generic admin SaaS.
- Existing dashboard functions keep working.
- Japanese and English labels remain usable.
- Text does not overlap or overflow on desktop or mobile.
- Verification includes browser-backed visual checks, not only `node --check`.
