# AgentSmith Lite Web App Design Principles

## Purpose

This document defines the target UX and visual language for the AgentSmith Lite
Web App. It describes how the product should feel and behave as a whole. It does
not define product features, page-specific workflows, backend behavior, or the
current implementation.

Use these principles to make coherent design decisions. Keep them stable and
product-wide rather than expanding them into page specifications or a component
API.

## Design Character

The Web App should feel calm, capable, precise, and quietly distinctive. It is
an operational workspace, not a marketing site. Users should notice their work,
context, current state, and available action before they notice the styling.

Confidence comes from clear hierarchy, continuity, fast feedback, readable
density, and predictable recovery. Avoid decorative dashboards, oversized hero
layouts, onboarding theater, ornamental containers, and explanatory copy that
fills space without helping a decision.

## Core Principles

1. **Work first.** Give the user's current work the largest and clearest region.
   Supporting interface should improve orientation or action, not compete for
   attention.
2. **One clear hierarchy.** Global context, local context, page identity, work,
   supporting information, and metadata must remain visually distinct.
3. **Continuity over ceremony.** Preserve input, selection, position, and
   known-good content across navigation, refresh, reconnect, and recoverable
   failure.
4. **Dense, not cramped.** Optimize repeated work for scanning and comparison
   while giving primary content enough room to breathe.
5. **State is part of the interface.** Loading, active, waiting, unavailable,
   read-only, failed, and completed states must be explicit and truthful.
6. **One interaction language.** Similar controls and actions look and behave
   alike everywhere. Each clear scope has at most one dominant action.
7. **Progressive disclosure.** Present what is needed for the current decision;
   keep secondary detail available without leaving all of it permanently open.
8. **Responsive by composition.** Recompose for the available space instead of
   shrinking a desktop layout.
9. **Accessible by default.** Keyboard, touch, screen-reader, zoom, contrast,
   and reduced-motion behavior belong to the primary experience.
10. **No decorative complexity.** Every visible element must improve
    orientation, comprehension, expression, or action.

## Information and navigation

Navigation should answer three questions immediately: where am I, what am I
working on, and where can I go next?

- Use one stable global navigation model across the product.
- Keep global navigation, local navigation, and in-content navigation visually
  and semantically distinct.
- Show the current location through position, label, and selection treatment;
  do not rely on color alone.
- Preserve useful context when moving between views. Navigation must never
  silently create, duplicate, modify, or discard user work.
- Use links for destinations, buttons for commands, tabs for peer views of the
  same context, and menus for secondary commands or option sets.
- Keep labels concise and stable. Do not rename the same destination according
  to the path used to reach it.
- Prefer shallow, predictable navigation. Add another level only when it makes
  the user's mental model clearer.
- Back and forward navigation should restore meaningful position, selection,
  filters, and drafts whenever they remain valid.

Every view has one semantic `h1`. Standard views share one page-header pattern;
immersive work surfaces share one compact workbench-header pattern. Section and
panel titles never imitate page titles.

## Layout and composition

The application shell provides stable orientation while leaving the largest
possible useful area for work.

- Define shell, content-width, gutter, spacing, and density values as a small
  shared token system rather than page-level measurements.
- Distinguish reading width, ordinary working width, and full-width data or
  immersive surfaces. Content determines which one is appropriate.
- Support comfortable and compact density. Density may change spacing and row
  height, but never legibility, touch safety, or information priority.
- Align related elements to a shared grid. Use whitespace to show grouping
  before adding borders or containers.
- Stable controls, toolbars, and split regions use explicit dimensions or
  responsive constraints so dynamic content does not shift the layout.
- Keep the primary content in normal reading order. Auxiliary information may
  occupy a rail, drawer, popover, or disclosure only when its relationship is
  clear.
- Avoid card-in-card layouts and floating page sections. Cards are reserved for
  repeated objects, dialogs, and genuinely bounded tools.
- Use borders to separate adjacent operational regions, not to frame every
  section. Shadows belong only to floating layers.

## Responsive Composition

The complete experience must remain coherent at 320 CSS px wide, through large
desktop screens, at low viewport heights, in landscape, at 400% browser zoom,
with enlarged text, a soft keyboard, and safe-area insets. Font size does not
scale with viewport width.

- Breakpoints occur where the composition stops working, not at one universal
  device width. Compact navigation moves into a labelled overlay when it can no
  longer coexist with primary content.
- Preserve the primary activity and reading order. Move auxiliary rails, secondary
  controls, details, and filters into sheets or disclosures.
- In master-detail compositions, show one primary region at a time on narrow
  screens unless simultaneous comparison is essential.
- Dense tables first remove truly secondary columns, then become labelled rows.
  Use horizontal scrolling only when column comparison is itself the purpose.
- Toolbars wrap by priority. Keep the primary action visible and move secondary
  commands into a menu.
- Do not reduce type below the established scale to make content fit. Reflow,
  wrap, disclose, or scroll the correct region.
- Essential capability never depends on hover. Hover may reveal convenience.
- Every pointer target meets the WCAG 2.2 target-size minimum or equivalent
  spacing. Primary, frequent, mobile, and destructive controls should reach
  44x44 CSS px.
- Drag, swipe, long-press, and hover interactions have a straightforward click
  or keyboard equivalent.
- Dialogs, sheets, composers, and fixed controls remain usable above the soft
  keyboard and inside safe areas.

Responsive behavior is a design decision, not a set of accidental breakpoints.
Define what remains visible, what moves, what collapses, and what becomes
sequential for each composition.

## Visual hierarchy

Hierarchy should remain understandable before color, imagery, or motion is
applied.

- Establish importance through position, size, spacing, weight, and contrast in
  that order.
- Give each scope at most one visually dominant action.
- Keep ordinary controls visually quieter than content and primary actions.
- Use alignment and proximity to express relationships; do not make every item
  a separate surface.
- Keep metadata subordinate but readable. Never reduce essential information
  to faint text.
- Selection, focus, status, and emphasis are different concepts and must use
  different treatments.
- Empty space is structural. It should clarify groups and rhythm, not imitate a
  promotional layout.

## Typography

Cursor Gothic is the product UI face. Berkeley Mono is reserved for machine
values and technical content. Do not use serif typography in the operational
application.

- Use a small fixed hierarchy: page title `28/32`, section title `22/28`, panel
  title `18/24`, body `15/23`, compact metadata `13/18`, and mono `13/20`.
- Use regular weight for most text, medium for emphasis, and semibold only when
  size and position cannot establish enough hierarchy.
- Letter spacing is `0` throughout the product, including uppercase text.
- Use sentence case for titles, labels, tabs, buttons, badges, and table
  headers.
- Keep body text to a readable measure. Long prose should not span the full
  width of a large work surface.
- Text wraps without covering adjacent content. Machine values may break only
  inside regions designed for them.
- Numbers used for comparison align consistently and use tabular numerals.
  Identifiers, commands, paths, timestamps, and logs use mono; ordinary labels
  and status text do not.

## Color and themes

Light mode uses neutral white and gray surfaces. Dark mode uses neutral
charcoal surfaces. Each theme is designed on its own contrast relationships;
dark mode is not a tinted inversion of light mode.

- Agent orange expresses brand identity and the primary action. Selection,
  navigation context, focus, and status use their own semantic tokens.
- Blue is informational, green is successful or healthy, amber is cautionary,
  and red is failed or destructive.
- Neutral color expresses ordinary content, passive state, separation, and
  disabled or read-only presentation.
- Every semantic color has coordinated text, icon, border, focus, and subtle
  surface tokens in both themes. Product components do not use raw colors.
- Selection, focus, active work, success, warning, failure, and disabled state
  remain distinguishable. Color never carries meaning alone.
- Avoid beige, brown, blue-slate dominance, single-hue palettes, gradients,
  decorative glows, orbs, and bokeh.
- User-authored and generated content keeps readable contrast without allowing
  arbitrary styling to weaken the surrounding interface.

Theme changes should preserve hierarchy and avoid flashes of the wrong theme.
Honor the user's explicit choice first and system preference otherwise.

## Geometry and surfaces

- Normal controls and containers use 4-8px corners.
- Pills are limited to compact status, segmented controls, and avatars.
- Page content and ordinary controls are flat.
- Floating layers use restrained elevation and a clear relationship to their
  trigger or parent context.
- Borders are quiet but visible in both themes. Essential boundaries meet
  contrast requirements.
- Control size and placement stay stable across loading, hover, active,
  disabled, and validation states.
- Icons come from one coherent icon system. Use familiar symbols before text in
  compact toolbars, with accessible names and tooltips where meaning is not
  obvious.
- Use a small shared icon-size scale and one stroke/fill language. The same
  concept keeps the same icon throughout the product.
- Icons inherit semantic foreground color and never become the only expression
  of state.

## Actions and controls

Use one component and one interaction pattern for each job. Prefer familiar,
native semantics and introduce custom behavior only when it materially improves
the work.

- Separate navigation, commands, selection, status, and disclosure. Do not make
  one control carry several meanings.
- Give each clear scope one primary action and keep secondary commands quieter.
- Use the same control, label pattern, interaction states, and keyboard behavior
  for the same job everywhere.
- Every interactive component defines stable rest, hover, active,
  focus-visible, selected, disabled, loading, and error behavior as applicable.
  These states remain visually distinct and do not change its dimensions.
- Destructive actions use specific labels and proportionate emphasis. Familiar
  reversible actions should not feel dangerous.

Disabled controls are not explanations. When permission, policy, validation,
or state prevents an action, explain the reason near the action or omit it when
the user cannot meaningfully resolve the restriction.

Confirmation is reserved for consequential, difficult-to-reverse actions. It
states the affected object or scope, what is retained, and the likely result.
Default focus remains on the safe action. Do not confirm reversible or lossless
commands.

## Forms and input

- Every field has a persistent visible label. Placeholder text is an example,
  never a label.
- Help text explains constraints or consequences, not obvious mechanics.
- Labels, help, required state, and errors are programmatically associated with
  their fields.
- Group related fields and use one clear progression. Avoid multi-column forms
  when scanning order or error recovery becomes ambiguous.
- Validate at the earliest useful moment without interrupting typing.
- Preserve input after validation, network failure, reauthentication, and
  recoverable conflict.
- Submission keeps the action in place, names the active operation, and blocks
  accidental duplicate submission without freezing unrelated content.
- Ask about unsaved changes only when leaving would actually lose input.
- Numeric values show units and distinguish zero, unlimited, inherited, and
  unavailable where those meanings apply.
- Sensitive input clearly communicates storage and replacement behavior and
  does not reveal previously stored values by default.

## Data-dense interfaces

- Repeated rows use stable columns, a clear primary identity, visible status,
  and predictable action placement.
- Row density follows shared comfortable or compact tokens. Multi-line rows may
  grow, but metadata remains aligned and scannable.
- Search, filters, sorting, pagination, and bulk actions appear only when the
  real workflow needs them.
- Active filters, sort order, result count, and pagination position remain
  understandable. A filtered-empty state offers a direct reset.
- Critical identifiers, errors, and status are never available only through
  truncation. Provide expansion, copy, or a complete detail surface.
- Refresh preserves filters, selection, focus, and scroll whenever the content
  still exists.
- Charts supplement rather than replace exact values. Provide an equivalent
  table or concise text summary for comparison and non-visual access.

## State, feedback, and recovery

Every asynchronous experience should answer four questions: what is happening,
what remains usable, what changed, and what can be done if it fails.

- Field validation belongs beside the field.
- Form-level errors belong before the affected form and focus the first invalid
  field after submission.
- Operation status belongs near its trigger or affected content.
- Persistent object or view state belongs near its identity.
- Only cross-view account or service problems justify a global notice.
- Toasts acknowledge brief success after explicit actions. They do not carry
  persistent errors, required actions, data-loss risk, or routine loading.
- Refreshing existing content keeps it visible. A refresh failure adds an
  inline notice instead of replacing useful content.
- Loading new content uses a layout-preserving skeleton or a specific labelled
  state, not an unexplained spinner in empty space.
- Long operations name their actual stage and any available control. Do not use
  vague progress language when the current activity is known.
- Progress controls expose an accessible name, state, and value when a value is
  known.
- Retry repeats only the failed operation and preserves input.
- Reauthentication returns users to their previous location and recoverable
  draft.

Offline, expired authentication, insufficient permission, missing content,
conflict, validation failure, service failure, and result-unknown operations are
different states. Explain what happened in product language and offer the
closest useful next step. Never expose stack traces, internal service names, or
opaque transport terminology to ordinary users.

## Continuity and concurrency

- Keep known-good content available during refresh and transient failure.
- Do not silently overwrite a newer change from another tab, device, or user.
- Preserve local input during conflict, show the current confirmed state, and
  let the user make an informed choice.
- Optimistic feedback may show work as pending, never as confirmed fact.
- Distinguish pending, confirmed, rejected, and result-unknown operations.
- Reconciliation updates content in place without duplication, unrelated
  reordering, focus loss, or unnecessary scroll jumps.
- Streaming or live updates do not steal focus or force-scroll someone who has
  intentionally moved away from the latest content.
- When new content arrives away from the reading position, offer a clear way to
  move to the latest content instead of moving the viewport automatically.
- Drafts and transient UI state remain scoped to the context in which they were
  created.

## Content design

Use concise, direct English. The interface is English-only until localization
becomes a real product requirement.

- Use one canonical term for each concept and action.
- Commands use "verb + object" and describe the actual result.
- Status labels state current truth. Avoid vague words such as `Processing` or
  `Something went wrong` when a useful state is known.
- Error copy says what happened and gives the next useful action. It does not
  blame the user or promise recovery the system cannot provide.
- Confirmation copy names the scope and consequence. Success copy is brief and
  does not narrate routine navigation.
- Supporting copy explains state, scope, constraint, or consequence. It does
  not advertise features or teach obvious control mechanics.
- Dates follow the user's locale and timezone. Relative time may aid scanning,
  but an exact timestamp remains available.
- IDs are secondary, selectable, easy to copy, and never the primary name when
  a human-readable label exists.

## Motion and media

- Motion explains entry, exit, reordering, expansion, or state change.
- Use a small shared set of duration and easing tokens. Exit is usually faster
  than entry, and motion never delays the underlying action.
- Do not use flashing or strobing effects. Reduced-motion mode also removes
  non-essential translation, scaling, rotation, and smooth scrolling while
  preserving understandable state changes.
- Never fake progress with decorative animation.
- Avoid illustration that merely fills space. Prefer real content, previews,
  output, charts, and results when visual material improves understanding.
- User-controlled media never autoplays with sound. Any moving or updating
  content can be paused when it affects reading or concentration.

## Accessibility and semantics

Target WCAG 2.2 AA as the baseline and optimize for real use rather than
treating conformance as a checklist.

- Every operation is available by keyboard without timing traps. Focus order
  follows visual and interaction order.
- Provide a skip-to-content path. Each view has one `main`, one `h1`, named
  navigation regions, and named work regions where ambiguity is possible.
- Use native links, buttons, fields, tables, lists, and headings. Do not make a
  generic container behave like a control.
- Opening a modal surface moves focus inside; closing it returns focus to its
  trigger or nearest surviving logical control.
- Route changes update the document title and move focus to a logical starting
  point. Ordinary content updates do not move focus.
- After deletion, refresh, or navigation, move focus to a predictable location
  that communicates the result.
- Sticky regions, overlays, and soft keyboards never hide the focused control.
- Composite controls use conventional arrow, Home, End, Enter, Space, and
  Escape behavior. Tooltips, popovers, and menus support keyboard entry and
  dismissal.
- Focus indicators remain visible on every surface and meet 3:1 contrast.
- Body and small text meet 4.5:1 contrast; large text, essential boundaries,
  controls, focus, and meaningful graphics meet 3:1.
- Icon-only controls have accurate accessible names. Decorative icons are
  hidden from assistive technology.
- Status uses text and semantics as well as color and icon.
- Live regions announce meaningful completion and state transitions, not every
  streamed token, log line, timer tick, or rapidly changing event.
- Live content can be paused without stopping the underlying work so reading
  position remains stable.
- Rich text preserves a coherent heading hierarchy and is sanitized without
  flattening useful structure.
- Code, logs, canvases, charts, and streams provide keyboard-safe interaction,
  copy access, and an equivalent readable representation where needed.
- Errors and instructions are understandable without relying on position,
  shape, sound, color, or motion alone.
- Layout survives user-defined text spacing without clipping or overlap.
  Custom-font failure preserves readable metrics and operability.
- Honor forced-colors and system high-contrast modes; essential boundaries,
  focus, and state remain visible.

## Design judgment

Use these questions during design and in-place correction.

- Is the current location, context, and state clear at a glance?
- Does content remain more prominent than interface chrome?
- Is there one obvious next action without competing primary actions?
- Does the experience preserve input, position, and known-good content when it
  should?
- Does each async state explain what is happening and how to recover?
- Can dense information be scanned and compared without unnecessary opening
  and closing?
- Does the same composition remain coherent at 320 CSS px, desktop, low height,
  400% zoom, enlarged text, and in both themes?
- Can every operation be completed with keyboard and touch, with predictable
  focus and meaningful semantics?
- Does the experience remain understandable without color, hover, sound, or
  motion?
- Does every visible element improve orientation, comprehension, expression,
  or action?
