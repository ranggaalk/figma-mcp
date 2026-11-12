---
name: ux-writing
description: Writing and reviewing the text inside designs - buttons, labels, helper and error messages, empty states, confirmations, notifications, numbers, dates and currency - in clear, specific language that does not sound machine-written, with English and Indonesian conventions. Read whenever a design contains interface copy, or when asked to review or rewrite copy in a Figma file.
---

# Writing interface text

Interface text is part of the design. People read it to decide what to do next, usually in a hurry. Good copy names things the way users do, says what will happen, and stops.

## Principles

- **Say what happens.** "Delete key" is better than "Confirm"; "Top up balance" is better than "Continue".
- **Use the user's words**, not internal ones (not a database name or a team's jargon).
- **Be specific.** "Payment failed: the card was declined" is better than "Something went wrong".
- **Be brief.** Cut words that do not change the meaning, and put the important word first.
- **Be consistent.** One term per concept everywhere: do not switch between "key", "API key" and "token" for the same thing.
- **Use sentence case** for buttons, headings and labels. Title Case and ALL CAPS are harder to read.

## Patterns

### Buttons and links

- Verb plus object: "Create key", "Save changes", "Download invoice".
- The primary button repeats the dialog's intent: a dialog titled "Delete API key?" has a "Delete key" button, not "OK".
- Avoid "Submit", "OK", "Click here" and "Learn more" without context.

### Labels and help

- Labels are short nouns, placed above the field, and stay visible while typing.
- Use helper text for format and limits ("8 characters or more").
- A placeholder is only an example ("name@company.com"), never the label.

### Errors

- Say what happened and how to fix it: "Enter an amount of at least Rp10.000".
- Show the message next to the field, keep what the user typed, and do not blame them ("You entered…").
- No "Oops" or jokes when something failed; no error codes without an explanation.

### Empty states

- Say what will appear here and how to get started: "No API keys yet. Create one to send your first request." plus the action button.
- For a filtered list with no results: name the filter and offer to clear it.

### Confirmations of destructive actions

- Name the object and the consequence: "Delete 'Production key'? Apps using it will stop working immediately."
- The buttons are the action ("Delete key") and a safe way out ("Cancel" or "Keep key").

### Success, progress and notifications

- Success in the past tense, short: "Key created". Add the next step when useful: "Key created. Copy it now; it will not be shown again."
- If loading takes more than about a second, say what is loading: "Loading usage…".

### Numbers, dates and currency

- Units go with numbers: "12.48M tokens", not "12.48M".
- Indonesian formats: "Rp12.500" (no space, dot for thousands, comma for decimals: "Rp1.250,50"); dates "12 Nov 2026"; 24-hour time "14.30".
- English formats: "$1,234.50"; "Nov 12, 2026" (US) or "12 Nov 2026"; follow the product's existing choice.
- Use one format throughout a screen and the product.

## Indonesian copy

- Choose "Anda" or "kamu" and keep it everywhere; do not mix them.
- Do not mix languages within a sentence. Keep established technical terms that users already say ("API key", "token", "endpoint") instead of forcing awkward translations.
- Buttons use the base verb: "Simpan", "Buat key", "Isi saldo", "Hapus".
- Indonesian text often runs longer than English. Design for about 30 % more length: let text hug or wrap rather than giving it a fixed width.

## Copy that sounds machine-written

Remove these and say the concrete thing instead:

- Inflated adjectives: seamless, powerful, robust, cutting-edge, effortless.
- Hype verbs: unlock, elevate, empower, supercharge, revolutionize.
- Stock openings: "In today's fast-paced world", "Whether you're a … or a …".
- Lists of three by habit, and "not only … but also" constructions.
- Exclamation marks and emoji in product UI; colons in every heading ("Analytics: Your Data, Simplified").
- Vague benefits with no specifics. "Faster responses" is weaker than "Answers in under a second for 95 % of requests" when the number is real. Never invent numbers.

## Reviewing copy in a file

1. `find_nodes` with types `["TEXT"]` and `withinNodeId` set to the screen. This lists every text with its id, layer path and content.
2. Propose changes as a table:

   | Where | Current | Proposed | Why |
   | --- | --- | --- | --- |
   | `12:40` Dialog / Primary | OK | Delete key | Names the action |

3. Ask before applying. Then:
   - Plain text layers: `update_nodes` with `text`. Fonts are handled for you.
   - Text inside instances: set the component's text property (`props`) or override the layer (`texts`) with `update_nodes` on the instance.
4. Check the result. Longer text can wrap or overflow, so read the `check` field and look at a screenshot.
