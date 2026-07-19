# Orquesta Desktop Map Group Spacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a clear header and connector lane above every grouped agent row at every Map zoom level.

**Architecture:** Keep the current organization projection and layout algorithm. Centralize group padding and dynamic bounds in `layout.ts`, use top-edge ports for group root agents, and render each group frame and label under one SVG camera transform.

**Tech Stack:** React 19, TypeScript, SVG, Vitest, Testing Library

## Global Constraints

- Do not change Orquesta roles, canonical state, agent visibility, organization grouping, or Team Management.
- Do not run long memory or pointer-retention measurements for this geometry-only change.
- Stop after a targeted unit check, production build, package, and user-visible launch.

---

### Task 1: Repair Group Geometry and Zoom Transform

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/map/layout.ts`
- Modify: `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/map-layout.test.ts`
- Modify: `apps/orquesta-desktop/tests/unit/map-viewport.test.ts`

**Interfaces:**
- Consumes: `MapGroupLayout`, agent center positions, `nodeWidth`, `nodeHeight`, and the existing `Camera`.
- Produces: exported `GROUP_PADDING_X`, `GROUP_PADDING_TOP`, `GROUP_PADDING_BOTTOM`, and `groupBoundsForPositions()`; group-root delegation edges ending at each node top port.

- [ ] **Step 1: Add failing group geometry tests**

Add assertions that dynamic bounds keep exactly the shared top padding before and after a top agent moves, and that a group-root edge ends at `root.y - nodeHeight / 2`.

```ts
const group = layout.groups.find((item) => item.agentIds.length > 1)!;
const bounds = groupBoundsForPositions(group, layout.agentPositions, layout.nodeWidth, layout.nodeHeight);
const top = Math.min(...group.agentIds.map((id) => layout.agentPositions.get(id)!.y - layout.nodeHeight / 2));
expect(top - bounds.y).toBe(GROUP_PADDING_TOP);

const rootEdge = layout.edges.find((edge) => edge.parentId === `group:${group.id}`)!;
expect(rootEdge.to.y).toBe(layout.agentPositions.get(rootEdge.childId)!.y - layout.nodeHeight / 2);
```

- [ ] **Step 2: Run the focused tests and confirm the old geometry fails**

Run:

```powershell
npm test -- tests/unit/map-layout.test.ts tests/unit/map-viewport.test.ts -t "group"
```

Expected: failure because the renderer still uses 42px top padding and the root edge targets the node center.

- [ ] **Step 3: Centralize group bounds and root ports**

Export the shared padding and bounds function from `layout.ts` and use them in both initial and manually-adjusted layout calculations.

```ts
export const GROUP_PADDING_X = 52;
export const GROUP_PADDING_TOP = 92;
export const GROUP_PADDING_BOTTOM = 44;

export function groupBoundsForPositions(
  group: MapGroupLayout,
  positions: Map<string, Point>,
  nodeWidth: number,
  nodeHeight: number
): MapGroupLayout {
  const points = group.agentIds.flatMap((agentId) => {
    const point = positions.get(agentId);
    return point ? [point] : [];
  });
  if (!points.length) return group;
  const x = Math.min(...points.map((point) => point.x - nodeWidth / 2)) - GROUP_PADDING_X;
  const y = Math.min(...points.map((point) => point.y - nodeHeight / 2)) - GROUP_PADDING_TOP;
  const right = Math.max(...points.map((point) => point.x + nodeWidth / 2)) + GROUP_PADDING_X;
  const bottom = Math.max(...points.map((point) => point.y + nodeHeight / 2)) + GROUP_PADDING_BOTTOM;
  return { ...group, x, y, width: right - x, height: bottom - y, anchor: { x: (x + right) / 2, y } };
}
```

When creating `delegation:group:*` edges, set `to.y` to `rootPoint.y - NODE_HEIGHT / 2`. Preserve that port when `MapViewport` recalculates effective edges.

- [ ] **Step 4: Put group frame and label under one camera transform**

Render the group in world units beneath a translated and scaled SVG group.

```tsx
<g
  key={`group-${group.id}`}
  className="map-group"
  transform={`translate(${topLeft.x} ${topLeft.y}) scale(${camera.zoom})`}
>
  <rect x={0} y={0} width={group.width} height={group.height} rx={22} />
  <text x={14} y={22}>{group.id.toUpperCase()}</text>
</g>
```

- [ ] **Step 5: Run the focused unit tests**

Run:

```powershell
npm test -- tests/unit/map-layout.test.ts tests/unit/map-viewport.test.ts
```

Expected: both test files pass.

- [ ] **Step 6: Build and package the user-visible checkpoint**

Run:

```powershell
npm run build
npm run package:win
```

Expected: production Renderer build and `out/Orquesta-win32-x64/Orquesta.exe` succeed.

- [ ] **Step 7: Launch the packaged app for user review**

Run:

```powershell
Start-Process -FilePath "apps/orquesta-desktop/out/Orquesta-win32-x64/Orquesta.exe"
```

Ask the user to inspect only the five items in the design document. Do not run the full suite or continue into role redesign.
