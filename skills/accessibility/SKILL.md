---
name: accessibility
description: Accessibility at design time in Figma, following WCAG 2.2 level AA - text and non-text contrast, text size and reflow, touch target size, focus and error states, colour-only meaning, and handoff notes for what code must do. Also how to audit a frame with check_design and the read tools without editing it. Read when designing interactive screens or when asked to review accessibility.
---

# Accessibility in designs

Many accessibility problems are decided in the design: colours, sizes, states, wording, and the order things appear in. This skill covers those, based on WCAG 2.2 level AA. Semantics such as headings, landmarks and ARIA are implemented in code, but the design should say what they are (see "Handoff notes").

## Requirements

### Contrast

- **Text**: at least **4.5:1** against its background. **Large text** (at least 24 px regular, or 18.66 px bold) needs **3:1**. (WCAG 1.4.3)
- **Non-text**: at least **3:1** for anything needed to see or operate a control: input borders, checkbox and toggle outlines, focus indicators, meaningful icons, chart lines and bars. (1.4.11)
- **Placeholder and helper text** is still text people read; keep it at 4.5:1. Better still, use a visible label and keep the placeholder as an example only.
- **Disabled controls** are exempt, but they must still look clearly disabled.
- **Both themes**: if the file has Light and Dark modes, check frames in each mode.

### Colour is never the only cue (1.4.1)

- Errors pair colour with an icon and text.
- Links in body text are underlined, or differ from the text by 3:1 and have another cue on hover and focus.
- Status badges carry a word ("Active", "Failed"), not only a colour.
- Chart series are labelled directly or have distinct shapes or patterns.

### Text size and reflow

- Body text: 14 to 16 px on desktop and 16 px on mobile. Inputs on mobile are at least 16 px, or iOS zooms the page.
- Body line height of at least 1.4, and lines of at most about 80 characters.
- Avoid all caps for anything longer than a short label.
- Layouts must survive 200 % zoom and narrow widths (1.4.4, 1.4.10): give text boxes hug height rather than fixed height, and avoid text placed absolutely over other content.

### Targets and spacing

- Interactive targets are at least **24 × 24 px** with space around them (2.5.8). For touch, aim for **44 × 44 px** (iOS) or **48 × 48 px** (Material).
- Small icons can sit inside a larger tappable area; the area is what counts.

### States

- Every interactive component has a visible **focus** state with at least 3:1 contrast, typically a 2 px ring (2.4.7). Component sets should have Default, Hover, Focus, Pressed and Disabled variants; inputs also need Error.
- Errors appear next to the field, say what is wrong and how to fix it, and keep what the user typed (3.3.1, 3.3.3).
- Labels are visible and stay visible while typing (3.3.2). Mark required fields with text ("Required"), or explain the asterisk.

### Content

- Button and link text makes sense on its own: "Download invoice", not "Click here".
- Icon-only buttons need an accessible name; write it in the handoff notes and consider a tooltip.
- Nothing flashes more than three times a second. Large motion needs a reduced-motion version (note it in the spec).

## Handoff notes

Add these to the design when they are not obvious from the layout, for example as a short annotation frame:

- Heading levels: one H1 per page, and the visual hierarchy mapped to H2, H3.
- Landmarks: header, navigation, main content, footer.
- Reading and focus order, especially where the visual order differs from the layer order.
- Names for icon-only buttons and images that carry meaning; decorative images marked as decorative.
- Live updates, such as a toast or a balance that changes, that a screen reader should announce.

## Auditing a frame (read-only)

Do not edit while auditing unless asked. Steps:

1. `check_design` on the frame. It reports text that overflows its box, missing fonts, text contrast below AA with the measured ratio, content cut off by clipping frames, and colours not linked to tokens.
   Its limits: contrast is measured against the nearest solid background, so text on images or gradients is skipped. It does not measure non-text contrast or target size. Instance contents are checked in their main component.
2. Check what it does not cover:
   - `find_nodes` with types `["INSTANCE"]` (or a name such as "Button") to list interactive elements, then `get_node` for their sizes against the target-size rule.
   - `get_components` to confirm that interactive component sets have Focus, Disabled and Error variants.
   - `get_node` on inputs and their surroundings to check labels, helper text and error messages.
   - `export_node` (window must be visible) to judge colour-only meaning, focus visibility and density by eye.
3. Report each issue with:
   - severity: **blocker** (cannot be used), **major** (hard to use), or **minor**;
   - the WCAG criterion;
   - node id and layer path;
   - what is wrong, with numbers (ratio, size);
   - the fix, naming the token or component variant to use.

   A table works well:

   | Severity | Criterion | Where | Problem | Fix |
   | --- | --- | --- | --- | --- |
   | major | 1.4.3 Contrast | `12:34` Login / Form / Placeholder | 2.4:1 on #F8FAFC | Use `text/secondary` (4.6:1) |

4. Ask before fixing. When fixing, call `save_checkpoint` first and use `update_nodes`, then run `check_design` again.
