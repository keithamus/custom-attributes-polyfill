# Custom Attributes Polyfill

This polyfills [Custom Attributes]. While this proposal's specification and
web platform tests are pending, this polyfill aims to implement what _will be_
specified.

The polyfill will reach `1.0` when the specification has been written and
merged. Until then _expect breaking changes_.

This polyfill works by overriding `Attr`, allowing sub classing, and introducing
the `CustomAttributeRegistry` object. Attrs registered with
`customAttributes.define()` will be upgraded in place with the same lifecycle
callbacks as custom elements.

Like custom elements, custom attributes only apply to HTML elements. Attributes
on SVG, MathML or other non-HTML elements are never upgraded, even if their name
matches a definition (so `define("stroke-width", ...)` only affects HTML
elements).

## Installation

### With npm

```js
import "custom-attributes-polyfill";
```

This will automatically apply the polyfill if required.

To apply the polyfill manually, import the `isSupported` and `apply` functions
from `./custom-attributes.js`, which is mapped to `/fn`:

```js
import { isSupported, apply } from "custom-attributes-polyfill/fn";
if (!isSupported()) apply();
```

An `isPolyfilled` function is also available:

```js
import {
  isSupported,
  isPolyfilled,
  apply,
} from "custom-attributes-polyfill/fn";
if (!isSupported() && !isPolyfilled()) apply();
```

Without a package manager, use the `unpkg` script:

```html
<script
  type="module"
  async
  src="https://unpkg.com/custom-attributes-polyfill@latest/custom-attributes.min.js"
></script>
```

## Usage

```js
class PersistValue extends Attr {
  #owner = null;

  connectedCallback() {
    this.#owner = this.ownerElement;
    const stored = localStorage.getItem(this.value);
    if (stored !== null) this.#owner.value = stored;
    this.#owner.addEventListener("input", this);
  }

  disconnectedCallback() {
    this.#owner.removeEventListener("input", this);
    this.#owner = null;
  }

  attributeChangedCallback(oldValue, newValue) {
    if (oldValue !== null) localStorage.removeItem(oldValue);
  }

  handleEvent() {
    localStorage.setItem(this.value, this.#owner.value);
  }
}

customAttributes.define("persist-value", PersistValue);
```

```html
<input name="email" persist-value="email-draft" />
```

`el.getAttributeNode("persist-value")` and `el.attributes["persist-value"]`
return the `PersistValue` instance.

## Polyfilled surface

- `window.customAttributes` which is a `CustomAttributeRegistry`
- `CustomAttributeRegistry` methods `define`, `get`, `getName`,
  `whenDefined`, `upgrade`, `initialize`.
- The `Attr` constructor: `new MyAttr()` for defined classes, `new Attr()` throws.
- `document.createAttribute()` and `document.createAttributeNS()` construct
  defined attributes synchronously. A constructor that throws will be left in
  the failed state, and the exception reported to the console.
- `customAttributeRegistry` on `Element`, `Document` and `ShadowRoot`, and the
  `customAttributeRegistry` option on `createElement()`, `createElementNS()`,
  `createAttribute()`, `createAttributeNS()`, `importNode()` and
  `attachShadow()`. Passing `null` (except to `importNode()`) creates a node
  with no registry, which `CustomAttributeRegistry.prototype.initialize()` can
  later assign one to.
- `connectedCallback`, `disconnectedCallback`, `connectedMoveCallback`,
  `adoptedCallback` and `attributeChangedCallback(oldValue, newValue)`.
- `setAttributeNode()`, `setAttributeNodeNS()`, `setNamedItem()` and
  `setNamedItemNS()` throw a `NotSupportedError` `DOMException`, before
  changing anything, when given a custom attribute and the element is not an
  HTML element.

## Limitations

The polyfill observes the DOM with a `MutationObserver`, so it cannot match the
specification exactly:

- Reactions run at the next microtask checkpoint rather than synchronously at
  the end of the DOM operation. `define()`, `upgrade()`, `initialize()`,
  `createAttribute()` and `createAttributeNS()` are synchronous, as are
  `setAttributeNode()`, `setAttributeNodeNS()`, `setNamedItem()` and
  `setNamedItemNS()` on elements the polyfill does not observe (see below).
- An element removed and re-inserted within the same task keeps its custom
  attributes connected; no `disconnectedCallback`/`connectedCallback` pair
  fires. Likewise, an attribute node removed and re-added within the same task
  gets `attributeChangedCallback(value, null)` then
  `attributeChangedCallback(null, value)` but no
  `disconnectedCallback`/`connectedCallback` pair. `moveBefore()` fires
  `connectedMoveCallback` synchronously.
- Only `document`, shadow roots, and documents passed to `initialize()` are
  observed. Attributes upgraded elsewhere (for example inside an `<iframe>`) do
  not receive callbacks until they are adopted into an observed document.
- Closed shadow roots that already exist when `apply()` runs, including closed
  declarative shadow roots in the page's markup, cannot be found and are never
  observed. Open shadow roots that already exist are observed.
- Attributes added to a disconnected element are upgraded straight away only
  when added with `setAttributeNode()`, `setAttributeNodeNS()`,
  `setNamedItem()` or `setNamedItemNS()`, or when the element already has a
  custom attribute. Otherwise (for example with `setAttribute()` on a new
  element) they are upgraded when the element is connected or passed to
  `upgrade()`, and an already-custom attribute attached that way gets no
  callbacks until then.
- `adoptedCallback` fires when the polyfill next sees the attribute: when its
  element is next processed after adoption, or when it is attached to an
  element. `document.adoptNode()` on an attribute fires nothing by itself.
- An element's registry is fixed the first time the polyfill needs it rather
  than at creation. `createElement()`, `importNode()`, `attachShadow()` and
  `initialize()` pin it immediately; `cloneNode()` does not copy it. A
  registry change caused by adoption into another document is applied the next
  time the registry is read, using the element's parent at that time.
- The `shadowrootcustomattributeregistry` attribute on declarative shadow roots
  is not supported.
- Attributes that fail to construct keep the prototype `super()` gave them, as
  native custom elements do, but never receive callbacks.

[Custom Attributes]: https://github.com/webplatformco/project-custom-attributes
