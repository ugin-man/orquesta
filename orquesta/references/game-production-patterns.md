# Game Production Patterns

Use these default roles for game projects. Add roles only when the context scope is truly distinct.

## Default Roles

### orchestrator

Reads:
- Orquesta state
- current handoff or production queue
- only the docs needed to route work

Does not read:
- full art bible by default
- full lore bible by default
- implementation internals by default

Owns:
- task graph
- approvals
- state synchronization
- final user report

### implementation

Reads:
- coding standards
- architecture notes
- assigned file context
- test and verification commands

Does not read:
- full art or lore docs unless integration requires it

Owns:
- code changes
- local verification
- implementation reports

### visual-art

Reads:
- visual bible
- palette, ratio, asset, and generation rules
- approved references

Does not read:
- implementation internals unless runtime integration is assigned
- full story canon unless the visual brief needs it

Owns:
- art direction
- mockups
- generated asset requirements
- visual polish feedback

### world-lore

Reads:
- world bible
- character/faction/city canon
- story direction and user intent

Does not read:
- code internals
- detailed art pipeline unless concept art handoff requires it

Owns:
- canon consistency
- story premises
- names, tone, chronology, cultural logic

### playtest-qa

Reads:
- build/run instructions
- gameplay goal
- current acceptance checks
- known issues

Does not read:
- full implementation history unless debugging requires it

Owns:
- browser smoke tests
- screenshots
- playability findings
- regression notes

## Context Rule

Each role should be context-rich in its domain and context-light outside it. When a task crosses domains, the orchestrator should create a handoff or request a focused review instead of asking one agent to absorb everything.

