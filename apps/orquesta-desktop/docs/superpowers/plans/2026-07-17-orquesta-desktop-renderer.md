# Orquesta Desktop Renderer Implementation Plan

> **For agentic workers:** Implement task-by-task with test-first checks and verification after each deliverable.

**Goal:** Build the approved Orquesta desktop home as a local React, TypeScript, and Vite Renderer that uses typed fixtures and a replaceable bridge, without Electron or Node APIs in the Renderer.

**Architecture:** The app layer owns bridge calls and transient UI state. Feature components receive typed props and callbacks. A custom two-dimensional map viewport renders stable world coordinates with SVG edges and HTML agent nodes, while floating instruments and overlays remain fixed to the viewport.

**Tech Stack:** React 19, TypeScript 5, Vite 5, Lucide React, Vitest, Testing Library, Playwright, axe-core.

## Global Constraints

- The central Orquesta Map is the dominant visual element.
- Every roster agent remains individually visible; no aggregate agent nodes.
- Home has no document-level scrolling.
- Renderer code must not import Node.js, filesystem, child process, Electron, or App Server APIs.
- Working motion requires turn-start or progress evidence and stops while offline or reduced motion is active.
- Prototype and unknown evidence are labeled honestly.
- The UI supports English and Japanese.

---

### Task 1: Project shell and contracts
- Create Vite, TypeScript, Vitest, and Playwright configuration.
- Define UI projection and bridge interfaces.
- Add a test proving the mock bridge keeps offline sends unavailable.

### Task 2: Fixtures and mock bridge
- Add active, idle, attention-heavy, large-roster, offline, unknown-evidence, and long-Japanese fixtures.
- Implement project switching, conversation messages, attention resolution, and team proposals.
- Add unit tests for truthfulness and fixture size requirements.

### Task 3: Map viewport
- Write interaction tests for full roster, selection, pan, zoom, fit, and reset.
- Implement stable layout, task edges, selection dimming, and evidence-gated motion.

### Task 4: Floating instruments
- Implement Now, Project Status, Attention, Composer, and Toast components.
- Verify Home remains fixed and Attention scrolls internally.

### Task 5: Context overlays
- Implement Agent Detail, Task Detail, Project Route, Project Switcher, Conversation History, Attention History, Team Management, Now list, and Advanced Operations.
- Implement Escape closing and focus handling.

### Task 6: Visual system and accessibility
- Match the approved warm paper, monochrome geometry, thin borders, restrained semantic colors, and desktop safe areas.
- Add reduced-motion behavior, keyboard labels, focus rings, and Japanese layout checks.

### Task 7: Verification and handoff
- Run unit tests, browser tests, accessibility checks, and the production build.
- Do not create comparison screenshots; the user explicitly excluded them from this handoff.
- Create README-UI-HANDOFF.md, known gaps, and a source ZIP.
