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
  connectedCallback() {
    const stored = localStorage.getItem(this.value);
    if (stored !== null) this.ownerElement.value = stored;
    this.ownerElement.addEventListener("input", this);
  }

  disconnectedCallback() {
    this.ownerElement.removeEventListener("input", this);
  }

  attributeChangedCallback(oldValue, newValue) {
    if (oldValue !== null) localStorage.removeItem(oldValue);
  }

  handleEvent() {
    localStorage.setItem(this.value, this.ownerElement.value);
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
- `document.createAttribute()` constructs defined attributes synchronously.
- `customAttributeRegistry` on `Element`, `Document` and `ShadowRoot`, and the
  `customAttributeRegistry` option on `createElement()`, `createElementNS()`,
  `importNode()`, `attachShadow()`, `setHTML()` and `setHTMLUnsafe()`.
- `connectedCallback`, `disconnectedCallback`, `connectedMoveCallback`,
  `adoptedCallback` and `attributeChangedCallback(oldValue, newValue)`.

## Limitations

The polyfill observes the DOM with a `MutationObserver`, so it cannot match the
specification exactly:

- Reactions run at the next microtask checkpoint rather than synchronously at
  the end of the DOM operation. `define()`, `upgrade()`, `initialize()` and
  `createAttribute()` are synchronous.
- An element removed and re-inserted within the same task keeps its custom
  attributes connected; no `disconnectedCallback`/`connectedCallback` pair
  fires. `moveBefore()` fires `connectedMoveCallback` synchronously.
- Only `document`, shadow roots, and documents passed to `initialize()` are
  observed. Attributes upgraded elsewhere (for example inside an `<iframe>`) do
  not receive callbacks until they are adopted into an observed document.
- An element's registry is fixed the first time the polyfill needs it rather
  than at creation. `createElement()`, `importNode()`, `attachShadow()`,
  `setHTMLUnsafe()` and `initialize()` pin it immediately; `cloneNode()` does
  not copy it.
- Attributes that fail to construct keep the prototype `super()` gave them, as
  native custom elements do, but never receive callbacks.

[Custom Attributes]: https://github.com/webplatformco/project-custom-attributes
