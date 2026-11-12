// An in-memory imitation of the parts of the Figma Plugin API the plugin uses,
// including the rules real Figma enforces (fonts must be loaded before text
// edits, FILL/HUG only where valid, dynamic page loading, undo semantics), so
// that plugin/code.js can be tested under Node.

import { createHash } from "node:crypto";

export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const DEFAULT_FONTS = [
  ["Inter", "Regular"],
  ["Inter", "Italic"],
  ["Inter", "Medium"],
  ["Inter", "Semi Bold"],
  ["Inter", "Bold"],
  ["Inter", "Bold Italic"],
  ["Roboto", "Regular"],
  ["Roboto", "Medium"],
  ["Roboto", "SemiBold"],
  ["Roboto", "Bold"],
];

const fontKey = (font) => `${font.family}|${font.style}`;
const clone = (value) => (value === null || typeof value !== "object" ? value : structuredClone(value));
const SOLID = (r, g, b) => ({ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r, g, b } });

function parseHex(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a };
}

/** Width/height of PNG, GIF or JPEG bytes, or undefined when the bytes are none of those. */
function imageSize(bytes) {
  const b = Buffer.from(bytes);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString("ascii", 0, 3) === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      const length = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + length;
    }
  }
  return undefined;
}

export function createMockFigma(options = {}) {
  const mixed = Symbol("figma.mixed");
  const session = options.session ?? 7;
  let counter = 1;
  const newId = () => `${session}:${counter++}`;
  const newKey = () => createHash("sha1").update(String(Math.random()) + counter++).digest("hex");

  const availableFonts = new Set((options.fonts ?? DEFAULT_FONTS).map(([family, style]) => `${family}|${style}`));
  const loadedFonts = new Set();
  const stats = { undos: 0, commits: 0, versions: [], fontLoads: 0 };
  const listeners = {};

  // ------------------------------------------------------------------ undo
  // Verified in real Figma: triggerUndo() reverts the uncommitted changes AND
  // the last committed step, even when nothing is uncommitted.
  let pending = [];
  const undoStack = [];
  let replaying = false;
  const record = (revert) => {
    if (!replaying) pending.push(revert);
  };
  function commitUndo() {
    stats.commits++;
    if (pending.length > 0) {
      undoStack.push(pending);
      pending = [];
    }
  }
  function triggerUndo() {
    stats.undos++;
    const batches = [pending];
    const last = undoStack.pop();
    if (last) batches.push(last);
    pending = [];
    replaying = true;
    try {
      for (const batch of batches) for (let i = batch.length - 1; i >= 0; i--) batch[i]();
    } finally {
      replaying = false;
    }
  }

  // -------------------------------------------------------------- registry
  const nodes = new Map();
  const styles = new Map();
  const variables = new Map();
  const collections = new Map();
  const images = new Map();
  let allPagesLoaded = false;

  function requireFont(font, where) {
    if (!loadedFonts.has(fontKey(font))) {
      throw new Error(
        `in ${where}: Cannot write to node with unloaded font "${font.family} ${font.style}". Please call figma.loadFontAsync({ family: "${font.family}", style: "${font.style}" }) and await the returned promise first.`,
      );
    }
  }

  // --------------------------------------------------------------- nodes
  const isAutoLayout = (node) => !!node && typeof node._p?.layoutMode === "string" && node._p.layoutMode !== "NONE";
  const isFrameLike = (node) => ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(node.type);

  function set(node, key, value) {
    const old = node._p[key];
    node._p[key] = value;
    record(() => {
      node._p[key] = old;
    });
  }

  function accessors(proto, names) {
    for (const name of names) {
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: true,
        get() {
          return clone(this._p[name]);
        },
        set(value) {
          set(this, name, clone(value));
        },
      });
    }
  }

  // Base
  const BaseProto = {
    get parent() {
      return this._parent;
    },
    get removed() {
      return this._removed;
    },
    get name() {
      return this._p.name;
    },
    set name(value) {
      set(this, "name", String(value));
    },
    remove() {
      const parent = this._parent;
      const index = parent ? parent._children.indexOf(this) : -1;
      if (parent) parent._children.splice(index, 1);
      this._parent = null;
      markRemoved(this, true);
      record(() => {
        markRemoved(this, false);
        if (parent) {
          parent._children.splice(index, 0, this);
          this._parent = parent;
        }
      });
    },
    setPluginData(key, value) {
      set(this, "pluginData:" + key, String(value));
    },
    getPluginData(key) {
      return this._p["pluginData:" + key] ?? "";
    },
    toString() {
      return `[Node ${this.id}]`;
    },
  };

  function markRemoved(node, removed) {
    node._removed = removed;
    if (removed) nodes.delete(node.id);
    else nodes.set(node.id, node);
    for (const child of node._children ?? []) markRemoved(child, removed);
  }

  const ChildrenMixin = {
    get children() {
      return [...this._children];
    },
    appendChild(child) {
      this.insertChild(this._children.length, child);
    },
    insertChild(index, child) {
      if (child === this) throw new Error("Cannot append a node to itself");
      const oldParent = child._parent;
      const oldIndex = oldParent ? oldParent._children.indexOf(child) : -1;
      if (oldParent) oldParent._children.splice(oldIndex, 1);
      this._children.splice(Math.min(index, this._children.length), 0, child);
      child._parent = this;
      // Leaving an auto-layout parent turns FILL into FIXED, as in Figma.
      const keepSizing = { h: child._p.sizingH, v: child._p.sizingV };
      if (!isAutoLayout(this)) {
        if (child._p.sizingH === "FILL") child._p.sizingH = "FIXED";
        if (child._p.sizingV === "FILL") child._p.sizingV = "FIXED";
      }
      record(() => {
        const at = this._children.indexOf(child);
        if (at !== -1) this._children.splice(at, 1);
        child._parent = oldParent;
        if (oldParent) oldParent._children.splice(oldIndex, 0, child);
        child._p.sizingH = keepSizing.h;
        child._p.sizingV = keepSizing.v;
      });
    },
    findAll(callback) {
      const out = [];
      const walk = (node) => {
        for (const child of node._children ?? []) {
          if (!callback || callback(child)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    },
    findOne(callback) {
      return this.findAll(callback)[0] ?? null;
    },
    findChildren(callback) {
      return this._children.filter((child) => !callback || callback(child));
    },
    findAllWithCriteria(criteria) {
      if (this.type === "DOCUMENT" && !allPagesLoaded) {
        throw new Error("in findAllWithCriteria: Cannot access children on a page that has not been explicitly loaded. Remember to call figma.loadAllPagesAsync() first.");
      }
      return this.findAll((node) => !criteria?.types || criteria.types.includes(node.type));
    },
  };

  // Scene nodes: geometry, layout and export.
  const SceneProto = Object.create(BaseProto);
  accessors(SceneProto, [
    "visible",
    "locked",
    "opacity",
    "rotation",
    "layoutPositioning",
    "layoutGrow",
    "effects",
  ]);
  Object.defineProperties(SceneProto, Object.getOwnPropertyDescriptors({
    get x() {
      return layoutPosition(this).x;
    },
    set x(value) {
      set(this, "x", value);
    },
    get y() {
      return layoutPosition(this).y;
    },
    set y(value) {
      set(this, "y", value);
    },
    get width() {
      return computeSize(this, "h");
    },
    get height() {
      return computeSize(this, "v");
    },
    get layoutSizingHorizontal() {
      return this._p.sizingH;
    },
    set layoutSizingHorizontal(value) {
      setSizing(this, "h", value);
    },
    get layoutSizingVertical() {
      return this._p.sizingV;
    },
    set layoutSizingVertical(value) {
      setSizing(this, "v", value);
    },
    get absoluteBoundingBox() {
      const { x, y } = absolutePosition(this);
      return { x, y, width: this.width, height: this.height };
    },
    get absoluteRenderBounds() {
      // Like Figma: drawn area, so glyphs that overflow, drop shadows, and
      // unclipped children all count.
      let box = this.absoluteBoundingBox;
      if (this.type === "TEXT") {
        const natural = textNaturalSize(this, this._p.textAutoResize === "WIDTH_AND_HEIGHT" ? undefined : box.width);
        box = { ...box, height: Math.max(box.height, natural.height) };
      }
      let [x1, y1, x2, y2] = [box.x, box.y, box.x + box.width, box.y + box.height];
      for (const effect of this._p.effects ?? []) {
        if (effect.type !== "DROP_SHADOW" || effect.visible === false) continue;
        const spread = (effect.radius ?? 0) + (effect.spread ?? 0);
        x1 = Math.min(x1, box.x + effect.offset.x - spread);
        y1 = Math.min(y1, box.y + effect.offset.y - spread);
        x2 = Math.max(x2, box.x + box.width + effect.offset.x + spread);
        y2 = Math.max(y2, box.y + box.height + effect.offset.y + spread);
      }
      if (this._children && this._p.clipsContent !== true) {
        for (const child of this._children) {
          if (child._p.visible === false) continue;
          const r = child.absoluteRenderBounds;
          x1 = Math.min(x1, r.x);
          y1 = Math.min(y1, r.y);
          x2 = Math.max(x2, r.x + r.width);
          y2 = Math.max(y2, r.y + r.height);
        }
      }
      // Observed in Figma: what a clipping ancestor hides is not part of the
      // render bounds.
      for (let a = this._parent; a && a.type !== "PAGE" && a.type !== "DOCUMENT"; a = a._parent) {
        if (a._p.clipsContent !== true) continue;
        const c = a.absoluteBoundingBox;
        x1 = Math.max(x1, c.x);
        y1 = Math.max(y1, c.y);
        x2 = Math.min(x2, c.x + c.width);
        y2 = Math.min(y2, c.y + c.height);
      }
      return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
    },
    get effectStyleId() {
      return this._p.effectStyleId ?? "";
    },
    get boundVariables() {
      const out = { ...(this._p.bound ?? {}) };
      for (const key of ["fills", "strokes"]) {
        const paints = this._p[key];
        if (Array.isArray(paints) && paints.some((p) => p.boundVariables?.color)) {
          out[key] = paints.filter((p) => p.boundVariables?.color).map((p) => p.boundVariables.color);
        }
      }
      return out;
    },
    setBoundVariable(field, variable) {
      if (!variable) {
        const bound = { ...(this._p.bound ?? {}) };
        delete bound[field];
        set(this, "bound", bound);
        return;
      }
      const v = variables.get(variable.id);
      if (!v) throw new Error(`in setBoundVariable: variable ${variable.id} not found`);
      if (v.resolvedType !== "FLOAT") throw new Error(`in setBoundVariable: field "${field}" needs a FLOAT variable, got ${v.resolvedType}`);
      if (!(field in this) && !field.endsWith("Radius")) throw new Error(`in setBoundVariable: node does not have field "${field}"`);
      const value = Object.values(v.valuesByMode)[0];
      if (field.startsWith("padding") || field === "itemSpacing" || field === "counterAxisSpacing") set(this, field, value);
      else if (field.endsWith("Radius")) set(this, field, value);
      set(this, "bound", { ...(this._p.bound ?? {}), [field]: { type: "VARIABLE_ALIAS", id: v.id } });
    },
    resize(width, height) {
      if (!(width >= 0.01) || !(height >= 0.01)) throw new Error("in resize: width and height must be >= 0.01");
      set(this, "w", width);
      set(this, "h", height);
      if (this.type === "TEXT") {
        // Conservative: a resized text box is fixed in both directions until
        // textAutoResize is set again.
        requireTextFonts(this, "resize");
        set(this, "textAutoResize", "NONE");
        if (this._p.sizingH === "HUG") set(this, "sizingH", "FIXED");
        if (this._p.sizingV === "HUG") set(this, "sizingV", "FIXED");
      } else {
        if (this._p.sizingH === "HUG") set(this, "sizingH", "FIXED");
        if (this._p.sizingV === "HUG") set(this, "sizingV", "FIXED");
      }
    },
    rescale(scale) {
      if (!(scale >= 0.01)) throw new Error("in rescale: scale must be >= 0.01");
      set(this, "w", this.width * scale);
      set(this, "h", this.height * scale);
      for (const child of this._children ?? []) {
        set(child, "x", child._p.x * scale);
        set(child, "y", child._p.y * scale);
        child.rescale(scale);
      }
    },
    async exportAsync(settings) {
      stats.lastExport = settings;
      if (options.exportImpl) return options.exportImpl(this, settings);
      return new Uint8Array(PNG_1X1);
    },
    async setEffectStyleIdAsync(id) {
      const style = styles.get(id);
      if (!style) throw new Error(`in setEffectStyleIdAsync: style ${id} not found`);
      set(this, "effects", clone(style.effects));
      set(this, "effectStyleId", id);
    },
    clone() {
      return cloneNode(this);
    },
  }));

  const GeometryProto = Object.create(SceneProto);
  accessors(GeometryProto, ["strokeWeight", "strokeAlign"]);
  Object.defineProperties(GeometryProto, Object.getOwnPropertyDescriptors({
    get fills() {
      if (this.type === "TEXT" && this._rangeFills.length > 0) return mixed;
      return clone(this._p.fills);
    },
    set fills(value) {
      if (!Array.isArray(value)) throw new Error("in set_fills: Expected an array of paints");
      set(this, "fills", clone(value));
      set(this, "fillStyleId", "");
      if (this.type === "TEXT") this._rangeFills = [];
    },
    get strokes() {
      return clone(this._p.strokes);
    },
    set strokes(value) {
      if (!Array.isArray(value)) throw new Error("in set_strokes: Expected an array of paints");
      set(this, "strokes", clone(value));
      set(this, "strokeStyleId", "");
    },
    get fillStyleId() {
      return this._p.fillStyleId ?? "";
    },
    get strokeStyleId() {
      return this._p.strokeStyleId ?? "";
    },
    async setFillStyleIdAsync(id) {
      const style = styles.get(id);
      if (!style || style.type !== "PAINT") throw new Error(`in setFillStyleIdAsync: paint style ${id} not found`);
      set(this, "fills", clone(style.paints));
      set(this, "fillStyleId", id);
    },
    async setStrokeStyleIdAsync(id) {
      const style = styles.get(id);
      if (!style || style.type !== "PAINT") throw new Error(`in setStrokeStyleIdAsync: paint style ${id} not found`);
      set(this, "strokes", clone(style.paints));
      set(this, "strokeStyleId", id);
    },
  }));

  const CornerMixin = {};
  accessors(CornerMixin, ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"]);
  Object.defineProperties(CornerMixin, Object.getOwnPropertyDescriptors({
    get cornerRadius() {
      const r = [this._p.topLeftRadius, this._p.topRightRadius, this._p.bottomRightRadius, this._p.bottomLeftRadius];
      return r.every((v) => v === r[0]) ? r[0] : mixed;
    },
    set cornerRadius(value) {
      for (const key of ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"]) set(this, key, value);
    },
  }));

  const FrameProto = Object.create(GeometryProto);
  Object.defineProperties(FrameProto, Object.getOwnPropertyDescriptors(ChildrenMixin));
  Object.defineProperties(FrameProto, Object.getOwnPropertyDescriptors(CornerMixin));
  accessors(FrameProto, [
    "layoutWrap",
    "itemSpacing",
    "counterAxisSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "clipsContent",
  ]);
  Object.defineProperties(FrameProto, Object.getOwnPropertyDescriptors({
    get layoutMode() {
      return this._p.layoutMode;
    },
    set layoutMode(value) {
      if (!["NONE", "HORIZONTAL", "VERTICAL", "GRID"].includes(value)) throw new Error(`in set_layoutMode: invalid value ${value}`);
      const before = this._p.layoutMode;
      if (before === value) return;
      // Measure while the old layout still applies.
      const size = { h: this.width, v: this.height };
      set(this, "layoutMode", value);
      if (value === "NONE") {
        set(this, "w", size.h);
        set(this, "h", size.v);
        if (this._p.sizingH === "HUG") set(this, "sizingH", "FIXED");
        if (this._p.sizingV === "HUG") set(this, "sizingV", "FIXED");
      } else if (before === "NONE") {
        // Turning on auto layout makes the primary axis hug, the counter axis stays fixed.
        set(this, value === "HORIZONTAL" ? "sizingH" : "sizingV", "HUG");
      }
    },
    get primaryAxisSizingMode() {
      return this._p[this._p.layoutMode === "HORIZONTAL" ? "sizingH" : "sizingV"] === "HUG" ? "AUTO" : "FIXED";
    },
    set primaryAxisSizingMode(value) {
      set(this, this._p.layoutMode === "HORIZONTAL" ? "sizingH" : "sizingV", value === "AUTO" ? "HUG" : "FIXED");
    },
    get counterAxisSizingMode() {
      return this._p[this._p.layoutMode === "HORIZONTAL" ? "sizingV" : "sizingH"] === "HUG" ? "AUTO" : "FIXED";
    },
    set counterAxisSizingMode(value) {
      set(this, this._p.layoutMode === "HORIZONTAL" ? "sizingV" : "sizingH", value === "AUTO" ? "HUG" : "FIXED");
    },
  }));

  const RectProto = Object.create(GeometryProto);
  Object.defineProperties(RectProto, Object.getOwnPropertyDescriptors(CornerMixin));
  const EllipseProto = Object.create(GeometryProto);
  const VectorProto = Object.create(GeometryProto);

  // Components
  const ComponentProto = Object.create(FrameProto);
  Object.defineProperties(ComponentProto, Object.getOwnPropertyDescriptors({
    get key() {
      return this._p.key;
    },
    get remote() {
      return this._p.remote === true;
    },
    get description() {
      return this._p.description ?? "";
    },
    set description(value) {
      set(this, "description", value);
    },
    get variantProperties() {
      return this._parent?.type === "COMPONENT_SET" ? parseVariantName(this._p.name) : null;
    },
    async getPublishStatusAsync() {
      return this._p.publishStatus ?? "UNPUBLISHED";
    },
    get componentPropertyDefinitions() {
      if (this._parent?.type === "COMPONENT_SET") {
        throw new Error("in get_componentPropertyDefinitions: Can only get definitions of a component set or non-variant component");
      }
      return clone(this._p.defs ?? {});
    },
    addComponentProperty(name, type, defaultValue) {
      const fullName = type === "VARIANT" ? name : `${name}#${counter++}:0`;
      const owner = this._parent?.type === "COMPONENT_SET" ? this._parent : this;
      set(owner, "defs", { ...(owner._p.defs ?? {}), [fullName]: { type, defaultValue } });
      return fullName;
    },
    createInstance() {
      return createInstanceOf(this);
    },
  }));

  const ComponentSetProto = Object.create(FrameProto);
  Object.defineProperties(ComponentSetProto, Object.getOwnPropertyDescriptors({
    get key() {
      return this._p.key;
    },
    get remote() {
      return this._p.remote === true;
    },
    get description() {
      return this._p.description ?? "";
    },
    set description(value) {
      set(this, "description", value);
    },
    addComponentProperty(name, type, defaultValue) {
      if (type === "VARIANT") throw new Error("in addComponentProperty: variant properties come from variant names");
      const fullName = `${name}#${counter++}:0`;
      set(this, "defs", { ...(this._p.defs ?? {}), [fullName]: { type, defaultValue } });
      return fullName;
    },
    get defaultVariant() {
      return this._children[0];
    },
    async getPublishStatusAsync() {
      return this._p.publishStatus ?? "UNPUBLISHED";
    },
    get componentPropertyDefinitions() {
      const defs = clone(this._p.defs ?? {});
      const variantNames = this._children.map((c) => parseVariantName(c._p.name));
      for (const prop of Object.keys(variantNames[0] ?? {})) {
        const options = [...new Set(variantNames.map((v) => v[prop]))];
        defs[prop] = { type: "VARIANT", defaultValue: variantNames[0][prop], variantOptions: options };
      }
      return defs;
    },
  }));

  const InstanceProto = Object.create(FrameProto);
  Object.defineProperties(InstanceProto, Object.getOwnPropertyDescriptors({
    async getMainComponentAsync() {
      return this._p.main;
    },
    get componentProperties() {
      const main = this._p.main;
      const owner = main._parent?.type === "COMPONENT_SET" ? main._parent : main;
      const out = {};
      for (const [name, def] of Object.entries(owner._p.defs ?? {})) {
        out[name] = { type: def.type, value: this._p.propValues?.[name] ?? def.defaultValue };
      }
      if (main._parent?.type === "COMPONENT_SET") {
        for (const [prop, value] of Object.entries(parseVariantName(main._p.name))) out[prop] = { type: "VARIANT", value };
      }
      return out;
    },
    setProperties(props) {
      const main = this._p.main;
      const set_ = main._parent?.type === "COMPONENT_SET" ? main._parent : null;
      const owner = set_ ?? main;
      const defs = owner._p.defs ?? {};
      let variant = set_ ? parseVariantName(main._p.name) : null;
      const values = { ...(this._p.propValues ?? {}) };
      for (const [key, value] of Object.entries(props)) {
        if (variant && key in variant) {
          variant = { ...variant, [key]: value };
        } else if (key in defs) {
          values[key] = value;
        } else {
          throw new Error(`in setProperties: Could not find a component property with name: '${key}'`);
        }
      }
      if (variant) {
        const match = set_._children.find((c) => {
          const v = parseVariantName(c._p.name);
          return Object.keys(variant).every((k) => v[k] === variant[k]);
        });
        if (!match) throw new Error(`in setProperties: Unable to find a variant with those property values: ${JSON.stringify(variant)}`);
        set(this, "main", match);
      }
      set(this, "propValues", values);
    },
  }));

  const TextProto = Object.create(GeometryProto);
  Object.defineProperties(TextProto, Object.getOwnPropertyDescriptors({
    get characters() {
      return this._p.characters;
    },
    set characters(value) {
      requireTextFonts(this, "set_characters");
      const first = this._charFonts[0] ?? this._p.fontName;
      set(this, "characters", String(value));
      const old = this._charFonts;
      this._charFonts = Array.from(String(value), () => clone(first));
      record(() => {
        this._charFonts = old;
      });
    },
    get fontName() {
      const keys = new Set(this._charFonts.map(fontKey));
      if (keys.size > 1) return mixed;
      return clone(this._charFonts[0] ?? this._p.fontName);
    },
    set fontName(font) {
      requireFont(font, "set_fontName");
      set(this, "fontName", clone(font));
      const old = this._charFonts;
      this._charFonts = this._charFonts.map(() => clone(font));
      record(() => {
        this._charFonts = old;
      });
    },
    get fontSize() {
      return this._p.fontSize;
    },
    set fontSize(value) {
      requireTextFonts(this, "set_fontSize");
      set(this, "fontSize", value);
    },
    get lineHeight() {
      return clone(this._p.lineHeight);
    },
    set lineHeight(value) {
      requireTextFonts(this, "set_lineHeight");
      set(this, "lineHeight", clone(value));
    },
    get letterSpacing() {
      return clone(this._p.letterSpacing);
    },
    set letterSpacing(value) {
      requireTextFonts(this, "set_letterSpacing");
      set(this, "letterSpacing", clone(value));
    },
    get textDecoration() {
      return this._p.textDecoration;
    },
    set textDecoration(value) {
      requireTextFonts(this, "set_textDecoration");
      set(this, "textDecoration", value);
    },
    get textAlignHorizontal() {
      return this._p.textAlignHorizontal;
    },
    set textAlignHorizontal(value) {
      set(this, "textAlignHorizontal", value);
    },
    get textAutoResize() {
      return this._p.textAutoResize;
    },
    set textAutoResize(value) {
      requireTextFonts(this, "set_textAutoResize");
      if (value === "WIDTH_AND_HEIGHT") {
        set(this, "sizingH", "HUG");
        set(this, "sizingV", "HUG");
      } else if (value === "HEIGHT") {
        if (this._p.sizingH === "HUG") set(this, "sizingH", "FIXED");
        set(this, "sizingV", "HUG");
        set(this, "w", this.width);
      } else if (value === "NONE") {
        if (this._p.sizingH === "HUG") set(this, "sizingH", "FIXED");
        if (this._p.sizingV === "HUG") set(this, "sizingV", "FIXED");
        set(this, "w", this.width);
        set(this, "h", this.height);
      }
      set(this, "textAutoResize", value);
    },
    get textStyleId() {
      return this._p.textStyleId ?? "";
    },
    async setTextStyleIdAsync(id) {
      const style = styles.get(id);
      if (!style || style.type !== "TEXT") throw new Error(`in setTextStyleIdAsync: text style ${id} not found`);
      requireFont(style.fontName, "setTextStyleIdAsync");
      this.fontName = style.fontName;
      set(this, "fontSize", style.fontSize);
      set(this, "lineHeight", clone(style.lineHeight));
      set(this, "letterSpacing", clone(style.letterSpacing));
      set(this, "textStyleId", id);
    },
    get hasMissingFont() {
      return this._charFonts.some((font) => !availableFonts.has(fontKey(font))) || !availableFonts.has(fontKey(this._p.fontName));
    },
    getRangeAllFontNames(start, end) {
      const fonts = this._charFonts.slice(start, end);
      const list = fonts.length > 0 ? fonts : [this._p.fontName];
      const seen = new Map(list.map((f) => [fontKey(f), clone(f)]));
      return [...seen.values()];
    },
    setRangeFontName(start, end, font) {
      requireFont(font, "setRangeFontName");
      const old = this._charFonts;
      this._charFonts = this._charFonts.map((f, i) => (i >= start && i < end ? clone(font) : f));
      record(() => {
        this._charFonts = old;
      });
    },
    setRangeFills(start, end, paints) {
      const old = this._rangeFills;
      this._rangeFills = [...this._rangeFills, { start, end, paints: clone(paints) }];
      record(() => {
        this._rangeFills = old;
      });
    },
    setRangeFontSize(start, end, size) {
      requireTextFonts(this, "setRangeFontSize");
      const old = this._rangeSizes;
      this._rangeSizes = [...this._rangeSizes, { start, end, size }];
      record(() => {
        this._rangeSizes = old;
      });
    },
    setRangeTextDecoration(start, end, decoration) {
      requireTextFonts(this, "setRangeTextDecoration");
    },
    getRangeFills(start, end) {
      const range = this._rangeFills.find((r) => r.start <= start && r.end >= end);
      return clone(range ? range.paints : this._p.fills);
    },
  }));

  function requireTextFonts(node, where) {
    const fonts = node._charFonts.length > 0 ? node._charFonts : [node._p.fontName];
    for (const font of fonts) requireFont(font, where);
  }

  const PageProto = Object.create(BaseProto);
  Object.defineProperties(PageProto, Object.getOwnPropertyDescriptors(ChildrenMixin));
  Object.defineProperties(PageProto, Object.getOwnPropertyDescriptors({
    get selection() {
      return this._selection.filter((n) => !n._removed);
    },
    set selection(value) {
      this._selection = [...value];
    },
    async loadAsync() {},
    async exportAsync(settings) {
      stats.lastExport = settings;
      return new Uint8Array(PNG_1X1);
    },
    on() {},
    off() {},
  }));

  const DocumentProto = Object.create(BaseProto);
  Object.defineProperties(DocumentProto, Object.getOwnPropertyDescriptors(ChildrenMixin));

  function makeNode(proto, type, props = {}) {
    const node = Object.create(proto);
    node.id = props.id ?? newId();
    node.type = type;
    node._parent = null;
    node._removed = false;
    node._p = {
      name: props.name ?? type.charAt(0) + type.slice(1).toLowerCase(),
      visible: true,
      locked: false,
      opacity: 1,
      rotation: 0,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      sizingH: "FIXED",
      sizingV: "FIXED",
      layoutPositioning: "AUTO",
      layoutGrow: 0,
      effects: [],
      bound: {},
    };
    nodes.set(node.id, node);
    return node;
  }

  function initGeometry(node, fills) {
    Object.assign(node._p, { fills, strokes: [], strokeWeight: 1, strokeAlign: "INSIDE", fillStyleId: "", strokeStyleId: "" });
  }
  function initCorners(node) {
    Object.assign(node._p, { topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0 });
  }
  function initFrame(node) {
    initGeometry(node, [SOLID(1, 1, 1)]);
    initCorners(node);
    Object.assign(node._p, {
      layoutMode: "NONE",
      layoutWrap: "NO_WRAP",
      itemSpacing: 0,
      counterAxisSpacing: 0,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      primaryAxisAlignItems: "MIN",
      counterAxisAlignItems: "MIN",
      clipsContent: true,
    });
  }

  function created(node) {
    record(() => {
      const parent = node._parent;
      if (parent) parent._children.splice(parent._children.indexOf(node), 1);
      node._parent = null;
      markRemoved(node, true);
    });
    return node;
  }

  function onPage(node) {
    figma.currentPage._children.push(node);
    node._parent = figma.currentPage;
    return node;
  }

  function createFrame() {
    const node = makeNode(FrameProto, "FRAME", { name: "Frame" });
    node._children = [];
    initFrame(node);
    return created(onPage(node));
  }

  function createText() {
    const node = makeNode(TextProto, "TEXT", { name: "Text" });
    initGeometry(node, [SOLID(0, 0, 0)]);
    Object.assign(node._p, {
      characters: "",
      fontName: { family: "Inter", style: "Regular" },
      fontSize: 12,
      lineHeight: { unit: "AUTO" },
      letterSpacing: { unit: "PERCENT", value: 0 },
      textAlignHorizontal: "LEFT",
      textAutoResize: "WIDTH_AND_HEIGHT",
      textDecoration: "NONE",
      textStyleId: "",
      sizingH: "HUG",
      sizingV: "HUG",
    });
    node._charFonts = [];
    node._rangeFills = [];
    node._rangeSizes = [];
    return created(onPage(node));
  }

  function createShape(proto, type, name) {
    const node = makeNode(proto, type, { name });
    initGeometry(node, [SOLID(0.85, 0.85, 0.85)]);
    if (proto === RectProto) initCorners(node);
    return created(onPage(node));
  }

  function createComponent() {
    const node = makeNode(ComponentProto, "COMPONENT", { name: "Component" });
    node._children = [];
    initFrame(node);
    node._p.key = newKey();
    node._p.defs = {};
    return created(onPage(node));
  }

  function cloneNode(source, idPrefix) {
    const proto = Object.getPrototypeOf(source);
    const copy = makeNode(proto, source.type, { id: idPrefix ? `${idPrefix};${source.id}` : undefined });
    copy._p = structuredClone({ ...source._p, main: undefined });
    if (source._p.main) copy._p.main = source._p.main;
    if (source.type === "TEXT") {
      copy._charFonts = clone(source._charFonts);
      copy._rangeFills = clone(source._rangeFills);
      copy._rangeSizes = clone(source._rangeSizes);
    }
    if (source._children) {
      copy._children = [];
      for (const child of source._children) {
        const childCopy = cloneNode(child, idPrefix);
        childCopy._parent = copy;
        copy._children.push(childCopy);
      }
    }
    return copy;
  }

  function createInstanceOf(component) {
    const instance = makeNode(InstanceProto, "INSTANCE", { name: component._p.name });
    const id = instance.id;
    nodes.delete(id);
    const copy = cloneNode(component, "I" + id);
    nodes.delete(copy.id);
    instance._children = copy._children;
    for (const child of instance._children) child._parent = instance;
    instance._p = structuredClone({ ...component._p, key: undefined, defs: undefined, main: undefined });
    instance._p.main = component;
    instance._p.propValues = {};
    instance._p.x = 0;
    instance._p.y = 0;
    instance.id = id;
    nodes.set(id, instance);
    return created(onPage(instance));
  }

  function parseVariantName(name) {
    const out = {};
    for (const part of String(name).split(",")) {
      const [k, v] = part.split("=").map((s) => s && s.trim());
      if (k && v !== undefined) out[k] = v;
    }
    return out;
  }

  function combineAsVariants(components, parent) {
    const node = makeNode(ComponentSetProto, "COMPONENT_SET", { name: "Component Set" });
    node._children = [];
    initFrame(node);
    node._p.key = newKey();
    node._p.defs = {};
    parent.appendChild(node);
    for (const component of components) node.appendChild(component);
    return created(node);
  }

  // ---------------------------------------------------------------- layout
  function padding(node, axis) {
    return axis === "h" ? node._p.paddingLeft + node._p.paddingRight : node._p.paddingTop + node._p.paddingBottom;
  }
  const primaryAxis = (node) => (node._p.layoutMode === "HORIZONTAL" ? "h" : "v");
  const flowChildren = (node) =>
    (node._children ?? []).filter((c) => c._p.visible !== false && c._p.layoutPositioning !== "ABSOLUTE");

  function textNaturalSize(node, wrapWidth) {
    const size = node._p.fontSize;
    const lineHeight =
      node._p.lineHeight?.unit === "PIXELS"
        ? node._p.lineHeight.value
        : node._p.lineHeight?.unit === "PERCENT"
          ? (size * node._p.lineHeight.value) / 100
          : Math.round(size * 1.21);
    const charWidth = size * 0.55;
    let lines = 0;
    let widest = 0;
    for (const paragraph of node._p.characters.split("\n")) {
      const width = paragraph.length * charWidth;
      widest = Math.max(widest, width);
      lines += wrapWidth ? Math.max(1, Math.ceil(width / wrapWidth)) : 1;
    }
    return { width: Math.max(1, Math.round(widest)), height: lines * lineHeight };
  }

  function computeSize(node, axis, guard = new Set()) {
    const sizing = axis === "h" ? node._p.sizingH : node._p.sizingV;
    const stored = axis === "h" ? node._p.w : node._p.h;
    const parent = node._parent;
    if (sizing === "FILL" && parent && isAutoLayout(parent) && !guard.has(parent)) {
      guard.add(node);
      const parentSize = computeSize(parent, axis, guard);
      const inner = parentSize - padding(parent, axis);
      if (primaryAxis(parent) !== axis) return Math.max(0.01, inner);
      const siblings = flowChildren(parent);
      const fills = siblings.filter((c) => (axis === "h" ? c._p.sizingH : c._p.sizingV) === "FILL");
      const used = siblings
        .filter((c) => !fills.includes(c))
        .reduce((sum, c) => sum + computeSize(c, axis, guard), 0);
      const gaps = parent._p.itemSpacing * Math.max(0, siblings.length - 1);
      return Math.max(0.01, (inner - used - gaps) / fills.length);
    }
    if (sizing === "HUG") {
      if (node.type === "TEXT") {
        if (axis === "h") return textNaturalSize(node).width;
        const wrap = node._p.sizingH === "HUG" ? undefined : computeSize(node, "h", guard);
        return textNaturalSize(node, wrap).height;
      }
      if (isAutoLayout(node)) {
        const kids = flowChildren(node);
        const sizes = kids.map((c) => {
          const childSizing = axis === "h" ? c._p.sizingH : c._p.sizingV;
          // A FILL child inside a hugging parent contributes its own size.
          if (childSizing === "FILL") return axis === "h" ? c._p.w : c._p.h;
          return computeSize(c, axis, guard);
        });
        const content =
          primaryAxis(node) === axis
            ? sizes.reduce((a, b) => a + b, 0) + node._p.itemSpacing * Math.max(0, kids.length - 1)
            : Math.max(0, ...sizes);
        return content + padding(node, axis);
      }
    }
    if (node.type === "TEXT" && axis === "v" && node._p.textAutoResize === "HEIGHT") {
      return textNaturalSize(node, computeSize(node, "h", guard)).height;
    }
    return stored;
  }

  function layoutPosition(node) {
    const parent = node._parent;
    if (!parent || !isAutoLayout(parent) || node._p.layoutPositioning === "ABSOLUTE" || parent.type === "PAGE") {
      return { x: node._p.x, y: node._p.y };
    }
    const axis = primaryAxis(parent);
    const counter = axis === "h" ? "v" : "h";
    const kids = flowChildren(parent);
    let offset = axis === "h" ? parent._p.paddingLeft : parent._p.paddingTop;
    const total =
      kids.reduce((sum, c) => sum + computeSize(c, axis), 0) + parent._p.itemSpacing * Math.max(0, kids.length - 1);
    const inner = computeSize(parent, axis) - padding(parent, axis);
    if (parent._p.primaryAxisAlignItems === "CENTER") offset += (inner - total) / 2;
    if (parent._p.primaryAxisAlignItems === "MAX") offset += inner - total;
    const spacing =
      parent._p.primaryAxisAlignItems === "SPACE_BETWEEN" && kids.length > 1
        ? (inner - total + parent._p.itemSpacing * (kids.length - 1)) / (kids.length - 1)
        : parent._p.itemSpacing;
    for (const kid of kids) {
      if (kid === node) break;
      offset += computeSize(kid, axis) + spacing;
    }
    const counterInner = computeSize(parent, counter) - padding(parent, counter);
    let counterOffset = counter === "h" ? parent._p.paddingLeft : parent._p.paddingTop;
    const own = computeSize(node, counter);
    if (parent._p.counterAxisAlignItems === "CENTER") counterOffset += (counterInner - own) / 2;
    if (parent._p.counterAxisAlignItems === "MAX") counterOffset += counterInner - own;
    return axis === "h" ? { x: offset, y: counterOffset } : { x: counterOffset, y: offset };
  }

  function absolutePosition(node) {
    let x = 0;
    let y = 0;
    for (let n = node; n && n.type !== "PAGE" && n.type !== "DOCUMENT"; n = n._parent) {
      const p = layoutPosition(n);
      x += p.x;
      y += p.y;
    }
    return { x, y };
  }

  function setSizing(node, axis, value) {
    const where = axis === "h" ? "set_layoutSizingHorizontal" : "set_layoutSizingVertical";
    if (!["FIXED", "HUG", "FILL"].includes(value)) throw new Error(`in ${where}: invalid value ${value}`);
    const parentAL = node._parent && isAutoLayout(node._parent) && node._parent.type !== "PAGE";
    if (!parentAL && !isAutoLayout(node) && node.type !== "TEXT") {
      throw new Error(`in ${where}: This property can only be set on auto-layout frames, their children, and text nodes`);
    }
    if (value === "FILL" && (!parentAL || node._p.layoutPositioning === "ABSOLUTE")) {
      throw new Error(`in ${where}: FILL can only be set on children of auto-layout frames`);
    }
    if (value === "HUG" && !(isAutoLayout(node) || node.type === "TEXT")) {
      throw new Error(`in ${where}: HUG can only be set on auto-layout frames and text nodes`);
    }
    if (node.type === "TEXT") {
      requireTextFonts(node, where);
      if (axis === "h" && value === "HUG") set(node, "textAutoResize", "WIDTH_AND_HEIGHT");
      if (axis === "h" && value !== "HUG" && node._p.textAutoResize === "WIDTH_AND_HEIGHT") {
        set(node, "w", node.width);
        set(node, "textAutoResize", "HEIGHT");
      }
      if (axis === "v" && value !== "HUG") {
        set(node, "h", node.height);
        set(node, "textAutoResize", "NONE");
      }
    }
    if (value === "FIXED") set(node, axis === "h" ? "w" : "h", computeSize(node, axis));
    set(node, axis === "h" ? "sizingH" : "sizingV", value);
  }

  // ------------------------------------------------------- styles & vars
  function makeStyle(type, name, props) {
    const style = {
      id: `S:${newKey()},${counter++}:0`,
      key: props.key ?? newKey(),
      type,
      name,
      remote: props.remote === true,
      description: "",
      ...props,
      async getPublishStatusAsync() {
        return props.publishStatus ?? "UNPUBLISHED";
      },
      remove() {
        styles.delete(this.id);
      },
    };
    styles.set(style.id, style);
    return style;
  }

  function makeCollection(name, props = {}) {
    const modeId = `${counter++}:0`;
    const collection = {
      id: `VariableCollectionId:${counter++}:0`,
      key: newKey(),
      name,
      modes: [{ modeId, name: "Mode 1" }],
      defaultModeId: modeId,
      remote: false,
      ...props,
      renameMode(id, newName) {
        const mode = this.modes.find((m) => m.modeId === id);
        if (!mode) throw new Error(`in renameMode: no mode ${id}`);
        mode.name = newName;
      },
      addMode(modeName) {
        // Observed in Figma on plans with a mode limit.
        const maxModes = options.maxModes ?? Infinity;
        if (this.modes.length >= maxModes) throw new Error(`in addMode: Limited to ${maxModes} modes only`);
        const id = `${counter++}:0`;
        this.modes.push({ modeId: id, name: modeName });
        return id;
      },
      remove() {
        collections.delete(this.id);
      },
    };
    collections.set(collection.id, collection);
    return collection;
  }

  function makeVariable(name, collection, resolvedType, props = {}) {
    const variable = {
      id: `VariableID:${counter++}:0`,
      key: props.key ?? newKey(),
      name,
      resolvedType,
      variableCollectionId: collection.id,
      valuesByMode: {},
      remote: props.remote === true,
      setValueForMode(modeId, value) {
        this.valuesByMode[modeId] = clone(value);
      },
      remove() {
        variables.delete(this.id);
      },
    };
    variables.set(variable.id, variable);
    return variable;
  }

  function resolveVariableValue(variable) {
    let value = Object.values(variable.valuesByMode)[0];
    while (value && value.type === "VARIABLE_ALIAS") value = Object.values(variables.get(value.id).valuesByMode)[0];
    return value;
  }

  // ------------------------------------------------------------- document
  const root = makeNode(DocumentProto, "DOCUMENT", { id: "0:0", name: options.fileName ?? "Test File" });
  root._children = [];
  const firstPage = makeNode(PageProto, "PAGE", { id: "0:1", name: "Page 1" });
  firstPage._children = [];
  firstPage._selection = [];
  root._children.push(firstPage);
  firstPage._parent = root;
  let currentPage = firstPage;

  const library = options.library ?? { components: [], styles: [], variableCollections: [] };

  const figma = {
    mixed,
    editorType: "figma",
    root,
    get currentPage() {
      return currentPage;
    },
    set currentPage(_) {
      throw new Error('Setting figma.currentPage is not supported with documentAccess: "dynamic-page". Use figma.setCurrentPageAsync instead.');
    },
    async setCurrentPageAsync(page) {
      currentPage = page;
      for (const cb of listeners.currentpagechange ?? []) cb();
    },
    createPage() {
      const page = makeNode(PageProto, "PAGE", { name: "Page " + (root._children.length + 1) });
      page._children = [];
      page._selection = [];
      root._children.push(page);
      page._parent = root;
      return page;
    },
    showUI() {},
    on(event, cb) {
      (listeners[event] ??= []).push(cb);
    },
    off() {},
    ui: { onmessage: null, postMessage() {} },
    viewport: { scrollAndZoomIntoView() {}, center: { x: 0, y: 0 }, zoom: 1 },
    commitUndo,
    triggerUndo,
    async saveVersionHistoryAsync(title, description) {
      stats.versions.push({ title, description });
      return { id: String(1000 + stats.versions.length) };
    },
    async loadAllPagesAsync() {
      allPagesLoaded = true;
    },
    async getNodeByIdAsync(id) {
      const node = nodes.get(id);
      return node && !node._removed ? node : null;
    },
    getNodeById() {
      throw new Error('Cannot call getNodeById with documentAccess: dynamic-page. Use figma.getNodeByIdAsync instead.');
    },
    async loadFontAsync(font) {
      stats.fontLoads++;
      if (!availableFonts.has(fontKey(font))) throw new Error(`The font "${font.family} ${font.style}" could not be loaded.`);
      loadedFonts.add(fontKey(font));
    },
    async listAvailableFontsAsync() {
      return [...availableFonts].map((key) => {
        const [family, style] = key.split("|");
        return { fontName: { family, style } };
      });
    },
    createFrame,
    createText,
    createRectangle: () => createShape(RectProto, "RECTANGLE", "Rectangle"),
    createEllipse: () => createShape(EllipseProto, "ELLIPSE", "Ellipse"),
    createComponent,
    combineAsVariants,
    createNodeFromSvg(svg) {
      if (typeof svg !== "string" || !/<svg[\s>]/.test(svg)) throw new Error("in createNodeFromSvg: Failed to parse SVG");
      const frame = createFrame();
      frame._p.name = "Svg";
      frame._p.fills = [];
      const width = Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? 24);
      const height = Number(/height="([\d.]+)"/.exec(svg)?.[1] ?? 24);
      frame._p.w = width;
      frame._p.h = height;
      const vector = makeNode(VectorProto, "VECTOR", { name: "Vector" });
      initGeometry(vector, /fill="none"/.test(svg) ? [] : [SOLID(0, 0, 0)]);
      if (/stroke="#/.test(svg)) vector._p.strokes = [SOLID(0, 0, 0)];
      vector._p.w = width;
      vector._p.h = height;
      frame._children.push(vector);
      vector._parent = frame;
      return frame;
    },
    createImage(bytes) {
      const size = imageSize(bytes);
      if (!size) throw new Error("in createImage: Image type is unsupported");
      if (size.width > 4096 || size.height > 4096) throw new Error("in createImage: Image is too large");
      const hash = createHash("sha1").update(Buffer.from(bytes)).digest("hex");
      const image = { hash, getSizeAsync: async () => ({ ...size }), getBytesAsync: async () => new Uint8Array(bytes) };
      images.set(hash, image);
      return image;
    },
    getImageByHash(hash) {
      return images.get(hash) ?? null;
    },
    async getLocalPaintStylesAsync() {
      return [...styles.values()].filter((s) => s.type === "PAINT" && !s.remote);
    },
    async getLocalTextStylesAsync() {
      return [...styles.values()].filter((s) => s.type === "TEXT" && !s.remote);
    },
    async getLocalEffectStylesAsync() {
      return [...styles.values()].filter((s) => s.type === "EFFECT" && !s.remote);
    },
    async getStyleByIdAsync(id) {
      return styles.get(id) ?? null;
    },
    createPaintStyle: () => makeStyle("PAINT", "Paint", { paints: [] }),
    createTextStyle: () =>
      makeStyle("TEXT", "Text", {
        fontName: { family: "Inter", style: "Regular" },
        fontSize: 12,
        lineHeight: { unit: "AUTO" },
        letterSpacing: { unit: "PERCENT", value: 0 },
      }),
    createEffectStyle: () => makeStyle("EFFECT", "Effect", { effects: [] }),
    async importStyleByKeyAsync(key) {
      const existing = [...styles.values()].find((s) => s.key === key);
      if (existing) return existing;
      const entry = library.styles?.find((s) => s.key === key);
      if (!entry) throw new Error(`in importStyleByKeyAsync: Could not find a published style with key "${key}"`);
      return makeStyle(entry.type, entry.name, { ...clone(entry), remote: true });
    },
    async importComponentByKeyAsync(key) {
      const existing = [...nodes.values()].find((n) => n.type === "COMPONENT" && n._p.key === key);
      if (existing) return existing;
      const entry = library.components?.find((c) => c.key === key && c.type !== "COMPONENT_SET");
      if (!entry) throw new Error(`in importComponentByKeyAsync: Could not find a published component with key "${key}"`);
      const component = makeNode(ComponentProto, "COMPONENT", { name: entry.name });
      component._children = [];
      initFrame(component);
      Object.assign(component._p, { key, remote: true, defs: clone(entry.defs ?? {}), w: entry.width ?? 120, h: entry.height ?? 40 });
      return component;
    },
    async importComponentSetByKeyAsync(key) {
      const entry = library.components?.find((c) => c.key === key && c.type === "COMPONENT_SET");
      if (!entry) throw new Error(`in importComponentSetByKeyAsync: Could not find a published component set with key "${key}"`);
      const set_ = makeNode(ComponentSetProto, "COMPONENT_SET", { name: entry.name });
      set_._children = [];
      initFrame(set_);
      Object.assign(set_._p, { key, remote: true, defs: {} });
      for (const variantName of entry.variants) {
        const variant = makeNode(ComponentProto, "COMPONENT", { name: variantName });
        variant._children = [];
        initFrame(variant);
        Object.assign(variant._p, { key: newKey(), remote: true, defs: {} });
        variant._parent = set_;
        set_._children.push(variant);
      }
      return set_;
    },
    variables: {
      async getLocalVariableCollectionsAsync() {
        return [...collections.values()].filter((c) => !c.remote);
      },
      async getLocalVariablesAsync(type) {
        return [...variables.values()].filter((v) => !v.remote && (!type || v.resolvedType === type));
      },
      async getVariableByIdAsync(id) {
        return variables.get(id) ?? null;
      },
      async getVariableCollectionByIdAsync(id) {
        return collections.get(id) ?? null;
      },
      createVariableCollection: (name) => makeCollection(name),
      createVariable: (name, collection, type) => makeVariable(name, collection, type),
      async importVariableByKeyAsync(key) {
        const existing = [...variables.values()].find((v) => v.key === key);
        if (existing) return existing;
        for (const collection of library.variableCollections ?? []) {
          const entry = collection.variables.find((v) => v.key === key);
          if (!entry) continue;
          let local = [...collections.values()].find((c) => c.key === collection.key);
          if (!local) local = makeCollection(collection.name, { key: collection.key, remote: true });
          const variable = makeVariable(entry.name, local, entry.resolvedType, { key, remote: true });
          variable.setValueForMode(local.defaultModeId, entry.value);
          return variable;
        }
        throw new Error(`in importVariableByKeyAsync: Could not find a published variable with key "${key}"`);
      },
      createVariableAlias(variable) {
        return { type: "VARIABLE_ALIAS", id: variable.id };
      },
      setBoundVariableForPaint(paint, field, variable) {
        if (field !== "color") throw new Error("in setBoundVariableForPaint: only color is supported");
        if (variable.resolvedType !== "COLOR") throw new Error("in setBoundVariableForPaint: variable must be a COLOR variable");
        const value = resolveVariableValue(variable);
        return {
          ...clone(paint),
          color: { r: value.r, g: value.g, b: value.b },
          boundVariables: { color: { type: "VARIABLE_ALIAS", id: variable.id } },
        };
      },
    },
    teamLibrary: {
      async getAvailableLibraryVariableCollectionsAsync() {
        return (library.variableCollections ?? []).map((c) => ({ key: c.key, name: c.name, libraryName: c.libraryName }));
      },
      async getVariablesInLibraryCollectionAsync(key) {
        const collection = (library.variableCollections ?? []).find((c) => c.key === key);
        if (!collection) throw new Error(`Library collection ${key} not found`);
        return collection.variables.map((v) => ({ key: v.key, name: v.name, resolvedType: v.resolvedType }));
      },
    },
    util: {
      solidPaint(color, overrides) {
        const c = typeof color === "string" ? parseHex(color) : color;
        return { ...SOLID(c.r, c.g, c.b), opacity: c.a ?? 1, ...(overrides ?? {}) };
      },
      rgb(color) {
        const c = parseHex(color);
        return { r: c.r, g: c.g, b: c.b };
      },
    },
    base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
    base64Decode: (text) => new Uint8Array(Buffer.from(text, "base64")),
  };

  /** Test-only helpers, not part of the Figma API. */
  figma._test = {
    stats,
    loadedFonts,
    listeners,
    /** Run setup code without it counting as an undoable step. */
    setup(fn) {
      replaying = true;
      try {
        return fn();
      } finally {
        replaying = false;
      }
    },
    resetUndo() {
      pending = [];
      undoStack.length = 0;
    },
    pendingChanges: () => pending.length,
    undoDepth: () => undoStack.length,
    /** Give a text node a font that is not installed, without loading it. */
    forceFont(node, font) {
      node._p.fontName = clone(font);
      node._charFonts = node._charFonts.map(() => clone(font));
    },
    makeStyle,
    makeCollection,
    makeVariable,
  };

  return figma;
}
