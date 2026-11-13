---
name: design-direction
description: How to design a new screen, flow or section in Figma so it looks intentional rather than template-made. Covers reading the brief and the file's design system, planning hierarchy, tokens and layout before building, building with build_design, and reviewing with screenshots and check_design. Read before creating any new screen or major section.
---

# Designing a screen

Good screens come from decisions made before the first frame exists: who is looking, what they came to do, and what must be seen first. The tools make building fast, which makes it easy to skip those decisions. Don't.

## 1. Understand the job

Write down, in one or two sentences, before touching the canvas:

- **Who** uses this screen and in what situation (first visit, daily use, something went wrong).
- **What they came to do**: the one task the screen exists for.
- **What they must see first**, and what can wait.

If the brief is thin, make reasonable assumptions and state them in your reply so the user can correct them.

Use realistic content in the product's language: real-looking names, amounts, dates, long and short values. Placeholder text ("Title", "Lorem ipsum", "Button") hides the problems real content causes: long names that wrap, big numbers that overflow, empty lists.

## 2. Read the file before designing

1. `get_status`: confirm the connection, and whether the Figma window is visible (screenshots need it).
2. `get_document_info`: pages and existing screens. Look for screens your new one sits next to.
3. `get_styles`: variables (and their modes, such as Light/Dark), text styles, effect styles.
4. `get_components`: components with their properties and variant options. Read the component descriptions; they often hold usage rules ("one primary button per view").
5. If related screens exist, read one with `get_node` at depth 2 to learn the shell: sidebar width, page padding, section spacing, how cards and headers are built. Reuse it. Consistency with the rest of the product beats novelty.

If the file has no design system, either set up a small one first (`get_skill` with name `design-system`) or keep to a short, consistent set of values and say that you did.

## 3. Plan, then check the plan

Before building, write a short plan in your reply:

- **Layout**: the structure in a few lines, or a tiny ASCII sketch.
- **Hierarchy**: the single primary action, the primary information, and what is secondary.
- **Tokens and components**: which variables and styles you will use for background, surfaces, text roles, accent, borders, spacing and radius; which components and variants.
- **One distinctive element** that comes from the subject matter: a chart that tells the key story, a strong typographic number, a well-chosen illustration slot. Not decoration for its own sake.

Then compare the plan with the brief and with the list below, and change anything that is there only by habit.

### Defaults that make work look generic

- Every section as an identical white card with the same shadow and padding.
- Three equal feature cards (icon, title, two lines) as the default answer to any content.
- Centring everything; a large hero with a vague slogan.
- Gradient blobs, glass effects, neon on dark, purple-to-blue gradients, unless the brand uses them.
- Small uppercase labels above every heading; light grey text used for anything "secondary".
- Numbered markers (01, 02, 03) when the order means nothing; emoji standing in for icons.
- Badges and pills sprinkled for colour; colours without meaning (green that does not mean success).
- Filler copy: "Unlock the power of…", "Seamless experience", invented metrics.

## 4. Build

- Build a screen with one `build_design` call, or the shell first and then each large section with `parentId`. Smaller calls give clearer errors and faster retries.
- Bind values instead of typing them: `{ "variable": "…" }` for colours, gap, padding and radius; `textStyle` for text; `effectStyle` for shadows; `type: "instance"` for anything a component already covers. Use hex values only when the file has no token for that role.
- Name layers by role ("Header", "Plan usage", "Primary action"). Generic "Frame" names make the file hard to work with later.
- Common screen sizes: 1440 wide for desktop, 390 for mobile. Let the height hug the content unless you are showing a single viewport.
- Inside the screen, use auto layout throughout. `width: "fill"` for content that should stretch; `align: "space-between"` to push items to opposite edges; absolute positioning only for overlays.
- For overlays and marks that sit on an edge (an active-tab bar, a badge on a corner, a rule mark), use `absolute: true` with `x`, `y` and `constraints`, for example `{ "horizontal": "stretch", "vertical": "bottom" }`, so they follow the frame when its size changes.
- A frame's border takes layout space: in an auto-layout frame built here, a 1px stroke moves the children in by 1px. Adding 1px padding as well puts everything 2px in, which shows as marks sitting off their lines.
- **Spacing rhythm**: take values from the spacing scale, and keep gaps inside a group smaller than gaps between groups (for example 8 inside a field, 16 between fields, 32 between sections).
- **Type**: stay within the file's text styles. Body text reads best at 45 to 80 characters per line.
- **States**: for screens that show data, consider the empty, loading and error versions, and what happens with very long values.
- When a section needs logic (repeating rows from data, variants of the same card), `execute_code` with `h.build` uses the same spec format.

## 5. Review

1. Read the `check` field that `build_design` and `update_nodes` return, and fix every error and warning before moving on.
2. Look at the result: `screenshot: true` on the build call, or `export_node`.
   - Does the primary action stand out, and only one?
   - Squint test: is the hierarchy clear from the shapes alone?
   - Are edges aligned, and spacing consistent between similar groups?
   - Is anything cut off, cramped, or floating without a reason?
   - Does it belong next to the neighbouring screens?
3. Run `check_design` on the finished frame. Fix what it finds with `update_nodes`.

If the Figma window is hidden, screenshots are skipped. Say that the visual check is still pending; do not claim the design looks right without having seen it.

## 6. Changing existing designs

- Call `save_checkpoint` before changing a design you did not just create.
- Prefer `update_nodes` for targeted changes, and keep the rest of the screen as it is unless asked.
- When turning on auto layout for an existing frame, also set width and height ("hug" to fit the content), or the cross axis keeps its old size and can cut content off.
- To reuse a section from another screen, copy it with `h.clone(node, { parent })` in `execute_code`, not `node.clone()`. A plain clone moved into a frame with another variable mode (a Dark screen's section into a Light screen) keeps the colours of the mode it came from. `check_design` reports this as `stale-variable`; `h.refreshVariables(node)` repairs copies that already have it.

## 7. Report

Tell the user what you built (frame name and id), the main decisions, the assumptions you made, and anything you could not verify (for example, no screenshot because the window was hidden).
