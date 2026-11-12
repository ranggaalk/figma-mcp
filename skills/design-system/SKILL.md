---
name: design-system
description: Setting up, extending or auditing a design system in Figma through this bridge - variable collections (primitives, semantic tokens with Light/Dark modes, spacing and radius), text and effect styles, and components with variants and properties - including execute_code recipes for the parts build_design cannot create. Read when a file has no tokens yet, when adding tokens or components, or when asked to tidy a design system.
---

# Design systems in Figma

A design system here means three things living in the file: **variables** (colours and dimensions), **styles** (text and effects), and **components** (with variants and properties). Screens built with `build_design` bind to all three, so the quality of the system decides how consistent and changeable every screen is.

## 1. Start from what exists

- `get_styles` lists variable collections with their modes and values, and the text and effect styles.
- `get_components` lists components and component sets, with properties, variant options and descriptions.
- Look for a foundations or components page with `get_document_info`, and follow its naming.

Extend what is there. Do not create a second palette or a parallel set of spacing tokens. When the existing names are inconsistent, report it and ask before renaming anything.

## 2. Structure

**Primitives** (one collection, one mode). Raw values, never bound in screens directly:

- `blue/500`, `gray/0` … `gray/900`, `red/500`, and so on.

**Theme** (semantic tokens, modes Light and Dark). Each one is an alias of a primitive; screens bind to these:

- `bg/canvas`, `bg/surface`, `bg/subtle`
- `text/primary`, `text/secondary`, `text/inverse`
- `border/default`, `border/strong`
- `accent/default`, `accent/hover`, `accent/on` (text on the accent colour)
- `success/text`, `success/subtle`, `warning/…`, `danger/…`

**Dimension** (one mode):

- `space/4` … `space/96` on a 4 or 8 point scale.
- `radius/sm`, `radius/md`, `radius/lg`, `radius/full`.

**Text styles** by role, using one or two families. Give each a size, a line height in pixels, and letter spacing:

- `Display/…`, `Heading/H1` … `H3`, `Body/Base`, `Body/Small`, `Label/Small`, `Mono/Base`.

**Effect styles**: `Elevation/1` … `3`, `Focus/Ring`.

**Naming**: use slash groups. Name tokens by role, not by appearance (`text/secondary`, not `gray-text`), so that Dark mode and rebrands do not make the names wrong.

## 3. Creating tokens

`build_design` binds to variables and styles but cannot create them, so use `execute_code`. Keep one collection per call, and return the ids.

### Primitives and a themed collection

```js
const prim = figma.variables.createVariableCollection("Primitives");
const pm = prim.modes[0].modeId;
const raw = {};
for (const [name, hex] of Object.entries({ "gray/0": "#FFFFFF", "gray/900": "#1F2328", "blue/500": "#0969DA", "blue/300": "#58A6FF" })) {
  raw[name] = figma.variables.createVariable(name, prim, "COLOR");
  raw[name].setValueForMode(pm, { ...h.color(hex), a: 1 });
}

const theme = figma.variables.createVariableCollection("Theme");
const light = theme.modes[0].modeId;
theme.renameMode(light, "Light");
let dark;
try {
  dark = theme.addMode("Dark");
} catch (err) {
  // Some Figma plans allow only one mode per collection ("Limited to 1 modes only").
  // Continue with Light only and tell the user that Dark mode needs a plan with more modes.
}
const alias = (v) => figma.variables.createVariableAlias(v);
const token = (name, scopes, lightValue, darkValue) => {
  const v = figma.variables.createVariable(name, theme, "COLOR");
  v.scopes = scopes;
  v.setValueForMode(light, alias(lightValue));
  if (dark) v.setValueForMode(dark, alias(darkValue));
  return v;
};
token("bg/surface", ["FRAME_FILL", "SHAPE_FILL"], raw["gray/0"], raw["gray/900"]);
token("text/primary", ["TEXT_FILL"], raw["gray/900"], raw["gray/0"]);
token("accent/default", ["ALL_FILLS", "STROKE_COLOR"], raw["blue/500"], raw["blue/300"]);
return { primitives: prim.id, theme: theme.id, darkMode: Boolean(dark) };
```

### Spacing and radius

```js
const dim = figma.variables.createVariableCollection("Dimension");
const m = dim.modes[0].modeId;
for (const n of [4, 8, 12, 16, 24, 32, 48, 64]) {
  const v = figma.variables.createVariable(`space/${n}`, dim, "FLOAT");
  v.scopes = ["GAP"];
  v.setValueForMode(m, n);
}
for (const [name, n] of [["radius/sm", 6], ["radius/md", 8], ["radius/lg", 12], ["radius/full", 999]]) {
  const v = figma.variables.createVariable(name, dim, "FLOAT");
  v.scopes = ["CORNER_RADIUS"];
  v.setValueForMode(m, n);
}
```

### Text and effect styles

```js
for (const [name, weight, size, lineHeight] of [["Heading/H1", 600, 28, 36], ["Body/Base", 400, 14, 22], ["Label/Small", 500, 12, 16]]) {
  const style = figma.createTextStyle();
  style.name = name;
  style.fontName = await h.font("Inter", weight); // resolves and loads the font
  style.fontSize = size;
  style.lineHeight = { unit: "PIXELS", value: lineHeight };
}
const elevation = figma.createEffectStyle();
elevation.name = "Elevation/1";
elevation.effects = [{ type: "DROP_SHADOW", color: { r: 0.12, g: 0.14, b: 0.16, a: 0.08 }, offset: { x: 0, y: 1 }, radius: 2, spread: 0, visible: true, blendMode: "NORMAL" }];
```

To show a frame in Dark mode: `frame.setExplicitVariableModeForCollection(theme, darkModeId)`, passing the collection object.

Afterwards, run `get_styles` to confirm the result.

## 4. Components

1. **Build each variant** with `build_design`, using `type: "component"` and tokens throughout. Name variants `Property=Value, Property=Value`, for example `Kind=Primary, Size=M`. Use the same layer names in every variant (such as "Label" and "Icon") so properties and overrides line up.
2. **Combine them into a set** and add properties with `execute_code`:

   ```js
   const variants = await Promise.all(["10:24", "10:26"].map((id) => figma.getNodeByIdAsync(id)));
   const set = figma.combineAsVariants(variants, variants[0].parent);
   set.name = "Button";
   set.description = "Primary for the main action, one per view. Secondary for alternatives.";
   const label = set.addComponentProperty("Label", "TEXT", "Button");
   for (const variant of set.children) {
     variant.findOne((n) => n.type === "TEXT" && n.name === "Label").componentPropertyReferences = { characters: label };
   }
   // Lay the variants out and let the set fit them; without width/height "hug" the set keeps
   // its old height and cuts variants off.
   await h.apply(set, { layout: "horizontal", gap: 16, padding: 16, width: "hug", height: "hug" });
   return set;
   ```

3. **Other property types**:
   - Optional parts: `const show = set.addComponentProperty("Show icon", "BOOLEAN", false)`, bound to the layer's `visible`.
   - Swappable icons: `const icon = set.addComponentProperty("Icon", "INSTANCE_SWAP", iconComponent.id)`, bound to the nested icon *instance*'s `mainComponent`.
   - Assigning `componentPropertyReferences` **replaces** the whole object, so a second assignment drops the first binding. Set them together, or merge:

     ```js
     layer.componentPropertyReferences = { ...layer.componentPropertyReferences, visible: show, mainComponent: icon };
     ```
4. **States as variants**: Default, Hover, Focus, Pressed and Disabled for anything interactive; Error for inputs; sizes such as S, M, L when needed. The Focus variant needs a visible ring (see `get_skill` with name `accessibility`).
5. **Describe the rules** in `description`: when to use it, when not to, and limits ("one per view").
6. **Verify**: `get_components` should show the properties and variant options. Then place one with `build_design` (`type: "instance"`, `variant`, `props`) to check it behaves.

## 5. Auditing an existing system

Work read-only, then report:

- `check_design` on representative screens: `unlinked-token` warnings show values that equal a token but are not linked to it; `off-palette` shows colours outside the system.
- `get_styles`: duplicate values under different names, primitives bound directly in screens, gaps in the spacing scale, text styles with near-identical sizes.
- `get_components`: missing states, inconsistent variant or property names, components without descriptions.
- `find_nodes` with types `["FRAME"]` on a screen: many layers named "Frame" are worth reporting too.

## 6. Safety

- Call `save_checkpoint` before changing tokens or components that screens already use.
- Renaming a variable or style is safe, because bindings use ids. **Deleting** one breaks every binding, so never delete without asking.
- Editing a main component changes every instance in the file. Say so before doing it.
