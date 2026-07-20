# AgentSmith Lite UX/UI Design Principles

## Product Character

AgentSmith Lite is a focused cloud-agent workbench. It should feel calm,
capable, precise, and quietly distinctive. The interface is operational rather
than promotional: users should see their workspace, current state, and next
action before they notice the styling.

## Principles

1. **Work first.** Put the active task, conversation, file, or setting at the
   visual center. Do not add hero layouts, feature explanations, or decorative
   sections inside the authenticated product.
2. **One hierarchy.** Global navigation, page navigation, content, and
   supporting metadata must remain visually distinct. A stronger surface or
   type size represents higher importance, never decoration alone.
3. **Dense, not cramped.** Keep repeated operational rows compact and
   scannable. Give page headers and primary work areas enough breathing room.
4. **State is visible.** Selection, activity, read-only state, failure, and
   destructive intent use consistent color, icon, and copy. Color never carries
   meaning by itself.
5. **One action language.** Solid accent is reserved for the primary action in
   the current context. Ordinary commands use neutral surfaces; destructive
   commands use red only when the action is genuinely destructive.
6. **Continuous context.** Preserve workspace, project, Task, and File Library
   context while users move between modules. Avoid repeated navigation or
   duplicate summaries inside a page.
7. **Responsive by composition.** Desktop may use rails and split panes.
   Mobile turns those into sheets, tabs, or a single reading column without
   shrinking desktop UI or allowing controls to overlap.
8. **Motion explains change.** Use short transitions for sheets, menus,
   selection, and state changes. Respect reduced-motion preferences. Do not use
   ambient or decorative animation.

## Visual Foundation

- Neutral white/gray surfaces in light mode and neutral charcoal surfaces in
  dark mode. Avoid beige, brown, blue-slate, and single-hue palettes.
- Agent orange identifies primary actions and the active product context.
  Blue is informational, green is successful, amber is cautionary, and red is
  destructive or failed.
- Cursor Gothic is the UI face; Berkeley Mono is reserved for identifiers,
  commands, logs, and resource values. JJannon is not used in operational UI.
- Letter spacing is always `0`. Page titles are fixed-size and compact; large
  display typography is reserved for true empty or sign-in experiences.
- Corners stay at 8px or less for normal controls and containers. Pills are
  limited to status badges, segmented controls, and avatars.
- Shadows indicate floating layers only. Page sections are unframed; cards are
  used for repeated objects, dialogs, and genuinely bounded tools.
- Product imagery is optional and exceptional. Prefer real artifacts, file
  previews, terminal output, and agent results over decorative illustration.

## Layout Foundation

- Top bar: 52px, persistent identity and workspace context.
- Desktop navigation: 240px expanded, 72px collapsed, with a visible active
  indicator and restrained group labels.
- Standard pages: 20px mobile and 32px desktop gutters, maximum useful width
  around 1480px. Conversation and file workspaces may use the full width.
- Minimum interactive target: 36px desktop and 40px where controls are primary
  on mobile.
- Empty states explain the next useful action in one sentence and expose that
  action directly when permitted.

## Review Checklist

- Can a user identify the current workspace, project, module, and state at a
  glance?
- Is there one visually dominant next action, or intentionally none?
- Are repeated rows easy to compare without decorative card nesting?
- Does the same workflow remain understandable at 390px and 1440px?
- Are loading, empty, error, read-only, and destructive states designed?
- Do keyboard focus, contrast, truncation, and overflow remain coherent?
- Does every visible element help the current product task?
