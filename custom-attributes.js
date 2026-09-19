export function isSupported() {
  return (
    typeof globalThis.CustomAttributeRegistry === "function" &&
    "customAttributes" in globalThis
  );
}

export function isPolyfilled() {
  return (
    typeof globalThis.CustomAttributeRegistry === "function" &&
    !/native code/i.test(globalThis.CustomAttributeRegistry.toString())
  );
}

export function apply() {
  const NativeAttr = globalThis.Attr;
  const nativeCreateAttribute = Document.prototype.createAttribute;
  const nativeCreateElement = Document.prototype.createElement;
  const nativeCreateElementNS = Document.prototype.createElementNS;
  const nativeImportNode = Document.prototype.importNode;
  const nativeAttachShadow = Element.prototype.attachShadow;

  const ALREADY_CONSTRUCTED = Symbol("already constructed");
  const CALLBACK_NAMES = [
    "connectedCallback",
    "disconnectedCallback",
    "connectedMoveCallback",
    "adoptedCallback",
    "attributeChangedCallback",
  ];
  const ROOT_OPTIONS = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
  };
  const ATTRIBUTE_OPTIONS = { attributes: true, attributeOldValue: true };

  // CustomAttributeRegistry -> { scoped, byName, byConstructor, running, whenDefined, documents }
  const internals = new WeakMap();
  // Element | ShadowRoot | Document -> CustomAttributeRegistry
  const registries = new WeakMap();
  // Attr -> { state, definition, connected, document }
  const entries = new WeakMap();
  // Element -> Map<localName, Attr> of its custom attributes
  const tracked = new WeakMap();
  // Element -> closed ShadowRoot
  const closedShadows = new WeakMap();
  // constructor -> CustomAttributeRegistry, the "active custom attribute constructor map"
  const activeRegistries = new Map();

  function enumerate(obj, key) {
    Object.defineProperty(obj, key, {
      ...Object.getOwnPropertyDescriptor(obj, key),
      enumerable: true,
    });
  }

  function isConstructor(value) {
    if (typeof value !== "function") return false;
    try {
      Reflect.construct(String, [], value);
      return true;
    } catch {
      return false;
    }
  }

  function isValidName(name) {
    return (
      /^[a-z][^A-Z\t\n\f\r \0/=>]*$/.test(name) &&
      name.includes("-") &&
      !/^(aria-|data-|xml|xlink)/.test(name) &&
      name !== "accept-charset" &&
      name !== "http-equiv"
    );
  }

  function ofRegistry(registry) {
    const self = internals.get(registry);
    if (!self) throw new TypeError("Illegal invocation");
    return self;
  }

  function shadowRootOf(element) {
    return element.shadowRoot || closedShadows.get(element) || null;
  }

  function* shadowIncludingElements(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === Node.ELEMENT_NODE) yield node;
      for (
        let child = node.lastElementChild;
        child;
        child = child.previousElementSibling
      ) {
        stack.push(child);
      }
      const shadow =
        node.nodeType === Node.ELEMENT_NODE ? shadowRootOf(node) : null;
      if (shadow) stack.push(shadow);
    }
  }

  function treeElements(root) {
    const elements = root.nodeType === Node.ELEMENT_NODE ? [root] : [];
    if (root.querySelectorAll) elements.push(...root.querySelectorAll("*"));
    return elements;
  }

  function registryOf(node) {
    const known = registries.get(node);
    if (known) return known;
    let registry = null;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const parent = node.parentNode;
      registry =
        parent &&
        (parent.nodeType !== Node.DOCUMENT_FRAGMENT_NODE ||
          parent instanceof ShadowRoot)
          ? registryOf(parent)
          : node.ownerDocument === document
            ? globalRegistry
            : null;
    } else if (node instanceof ShadowRoot) {
      registry = node.ownerDocument === document ? globalRegistry : null;
    }
    if (registry) registries.set(node, registry);
    return registry;
  }

  function lookupDefinition(registry, namespace, localName) {
    if (!registry || namespace !== null) return null;
    return internals.get(registry).byName.get(localName) || null;
  }

  function checkRegistryOption(registry, doc) {
    if (registry === undefined) return undefined;
    if (registry !== null && !internals.has(registry)) {
      throw new TypeError(
        "customAttributeRegistry must be a CustomAttributeRegistry or null",
      );
    }
    if (
      registry &&
      !internals.get(registry).scoped &&
      registry !== registryOf(doc)
    ) {
      throw new DOMException(
        "A non-scoped CustomAttributeRegistry can only be used with its own document",
        "NotSupportedError",
      );
    }
    return registry;
  }

  function invoke(attribute, name, args) {
    const definition = entries.get(attribute)?.definition;
    if (!definition) return;
    let callback = definition.lifecycleCallbacks[name];
    if (name === "connectedMoveCallback" && !callback) {
      const { disconnectedCallback, connectedCallback } =
        definition.lifecycleCallbacks;
      if (!disconnectedCallback && !connectedCallback) return;
      callback = function () {
        disconnectedCallback?.call(this);
        connectedCallback?.call(this);
      };
    }
    if (!callback) return;
    try {
      callback.apply(attribute, args);
    } catch (error) {
      reportError(error);
    }
  }

  function connect(attribute, entry) {
    entry.connected = true;
    invoke(attribute, "connectedCallback", []);
  }

  function disconnect(attribute, entry) {
    entry.connected = false;
    invoke(attribute, "disconnectedCallback", []);
  }

  function track(element, attribute) {
    let map = tracked.get(element);
    if (!map) {
      tracked.set(element, (map = new Map()));
      observer.observe(element, ATTRIBUTE_OPTIONS);
    }
    map.set(attribute.localName, attribute);
  }

  function untrack(element, attribute) {
    const map = tracked.get(element);
    if (map?.get(attribute.localName) === attribute) {
      map.delete(attribute.localName);
    }
  }

  function construct(attribute, entry, definition, registry) {
    const C = definition.constructor;
    definition.constructionStack.push(attribute);
    const previous = activeRegistries.get(C);
    activeRegistries.set(C, registry);
    try {
      entry.state = "precustomized";
      const result = new C();
      if (result !== attribute) {
        throw new TypeError(
          "Custom attribute constructor returned a different object",
        );
      }
    } catch (error) {
      entry.definition = null;
      entry.state = "failed";
      throw error;
    } finally {
      if (previous === undefined) activeRegistries.delete(C);
      else activeRegistries.set(C, previous);
      definition.constructionStack.pop();
    }
    entry.state = "custom";
  }

  function upgrade(attribute, definition, registry, value) {
    if (entries.has(attribute)) return;
    const entry = {
      state: "failed",
      definition,
      connected: false,
      document: attribute.ownerElement.ownerDocument,
    };
    entries.set(attribute, entry);
    try {
      construct(attribute, entry, definition, registry);
    } catch (error) {
      reportError(error);
      return;
    }
    const element = attribute.ownerElement;
    track(element, attribute);
    invoke(attribute, "attributeChangedCallback", [null, value]);
    if (element.isConnected) connect(attribute, entry);
  }

  function tryUpgrade(attribute, value = attribute.value) {
    const element = attribute.ownerElement;
    if (!element || entries.has(attribute)) return;
    const registry = registryOf(element);
    const definition = lookupDefinition(
      registry,
      attribute.namespaceURI,
      attribute.localName,
    );
    if (definition) upgrade(attribute, definition, registry, value);
  }

  // A batch of mutation records is processed with a shared context: the value
  // an attribute had right after a given record is the oldValue of the next
  // record for that attribute, or its current value if there is none.
  class Batch {
    #history = new Map();
    #position = 0;

    constructor(records) {
      records.forEach((record, index) => {
        if (
          record.type !== "attributes" ||
          record.attributeNamespace !== null
        ) {
          return;
        }
        let byName = this.#history.get(record.target);
        if (!byName) this.#history.set(record.target, (byName = new Map()));
        let list = byName.get(record.attributeName);
        if (!list) byName.set(record.attributeName, (list = []));
        list.push({ index, oldValue: record.oldValue });
      });
    }

    run(records) {
      records.forEach((record, index) => {
        this.#position = index;
        if (record.type === "childList") {
          for (const node of record.addedNodes) this.reconcileTree(node);
          for (const node of record.removedNodes) this.reconcileTree(node);
        } else if (
          record.type === "attributes" &&
          record.attributeNamespace === null
        ) {
          this.reconcileAttribute(
            record.target,
            record.attributeName,
            record.oldValue,
          );
        }
      });
    }

    #later(element, name) {
      const list = this.#history.get(element)?.get(name);
      if (!list) return [];
      const start = list.findIndex((item) => item.index > this.#position);
      return start === -1 ? [] : list.slice(start);
    }

    valueAfter(element, name) {
      const later = this.#later(element, name);
      return later.length
        ? later[0].oldValue
        : element.getAttributeNS(null, name);
    }

    addedLater(element, name) {
      return this.#later(element, name).some((item) => item.oldValue === null);
    }

    reconcileTree(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      for (const element of shadowIncludingElements(node)) {
        const shadow = element.shadowRoot;
        if (shadow && !observedRoots.has(shadow)) observeRoot(shadow);
        this.reconcileElement(element);
      }
    }

    reconcileElement(element) {
      if (!element.hasAttributes()) return;
      const connected = element.isConnected;
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.localName;
        if (attribute.namespaceURI !== null || this.addedLater(element, name)) {
          continue;
        }
        const entry = entries.get(attribute);
        if (!entry) {
          if (connected) {
            tryUpgrade(
              attribute,
              this.valueAfter(element, name) ?? attribute.value,
            );
          }
          continue;
        }
        if (entry.state !== "custom") continue;
        if (tracked.get(element)?.get(name) !== attribute) {
          track(element, attribute);
          invoke(attribute, "attributeChangedCallback", [
            null,
            this.valueAfter(element, name) ?? attribute.value,
          ]);
        }
        if (element.ownerDocument !== entry.document) {
          const oldDocument = entry.document;
          entry.document = element.ownerDocument;
          invoke(attribute, "adoptedCallback", [oldDocument, entry.document]);
        }
        if (connected !== entry.connected) {
          if (connected) connect(attribute, entry);
          else disconnect(attribute, entry);
        }
      }
    }

    reconcileAttribute(element, name, oldValue) {
      const previous = tracked.get(element)?.get(name);
      const current = element.getAttributeNodeNS(null, name);
      if (previous && previous === current) {
        invoke(previous, "attributeChangedCallback", [
          oldValue,
          this.valueAfter(element, name),
        ]);
        return;
      }
      if (previous) {
        untrack(element, previous);
        const entry = entries.get(previous);
        invoke(previous, "attributeChangedCallback", [oldValue, null]);
        if (entry.connected) disconnect(previous, entry);
      }
      if (!current || this.addedLater(element, name)) return;
      const value = this.valueAfter(element, name);
      const entry = entries.get(current);
      if (entry) {
        if (entry.state !== "custom") return;
        track(element, current);
        invoke(current, "attributeChangedCallback", [null, value]);
        if (element.isConnected) connect(current, entry);
      } else if (element.isConnected) {
        tryUpgrade(current, value);
      }
    }
  }

  function processRecords(records) {
    new Batch(records).run(records);
  }

  const observer = new MutationObserver(processRecords);
  const observedRoots = new WeakSet();

  function observeRoot(root) {
    observedRoots.add(root);
    observer.observe(root, ROOT_OPTIONS);
  }

  function flush() {
    const records = observer.takeRecords();
    if (records.length) processRecords(records);
  }

  let constructingGlobal = false;

  class CustomAttributeRegistry {
    constructor() {
      internals.set(this, {
        scoped: !constructingGlobal,
        byName: new Map(),
        byConstructor: new Map(),
        running: false,
        whenDefined: new Map(),
        documents: new Set(),
      });
    }

    define(name, constructor) {
      const self = ofRegistry(this);
      if (!isConstructor(constructor)) {
        throw new TypeError("constructor must be a constructor");
      }
      name = String(name);
      if (!isValidName(name)) {
        throw new DOMException(
          `"${name}" is not a valid custom attribute name`,
          "SyntaxError",
        );
      }
      if (self.byName.has(name)) {
        throw new DOMException(
          `"${name}" has already been defined as a custom attribute`,
          "NotSupportedError",
        );
      }
      if (self.byConstructor.has(constructor)) {
        throw new DOMException(
          "This constructor has already been used with this registry",
          "NotSupportedError",
        );
      }
      if (self.running) {
        throw new DOMException(
          "define() may not be called while another definition is running",
          "NotSupportedError",
        );
      }
      self.running = true;
      const lifecycleCallbacks = {};
      try {
        const prototype = constructor.prototype;
        if (Object(prototype) !== prototype) {
          throw new TypeError("constructor.prototype must be an object");
        }
        for (const callbackName of CALLBACK_NAMES) {
          const callback = prototype[callbackName];
          if (callback !== undefined && typeof callback !== "function") {
            throw new TypeError(`${callbackName} must be a function`);
          }
          lifecycleCallbacks[callbackName] = callback ?? null;
        }
      } finally {
        self.running = false;
      }
      const definition = {
        name,
        constructor,
        lifecycleCallbacks,
        constructionStack: [],
      };
      self.byName.set(name, definition);
      self.byConstructor.set(constructor, definition);
      flush();
      for (const doc of new Set([document, ...self.documents])) {
        for (const element of shadowIncludingElements(doc)) {
          const attribute = element.getAttributeNodeNS(null, name);
          if (
            attribute &&
            !entries.has(attribute) &&
            registryOf(element) === this
          ) {
            upgrade(attribute, definition, this, attribute.value);
          }
        }
      }
      const pending = self.whenDefined.get(name);
      if (pending) {
        self.whenDefined.delete(name);
        pending.resolve(constructor);
      }
    }

    get(name) {
      return ofRegistry(this).byName.get(String(name))?.constructor;
    }

    getName(constructor) {
      const self = ofRegistry(this);
      if (typeof constructor !== "function") {
        throw new TypeError("constructor must be a function");
      }
      return self.byConstructor.get(constructor)?.name ?? null;
    }

    whenDefined(name) {
      const self = ofRegistry(this);
      name = String(name);
      if (!isValidName(name)) {
        return Promise.reject(
          new DOMException(
            `"${name}" is not a valid custom attribute name`,
            "SyntaxError",
          ),
        );
      }
      const definition = self.byName.get(name);
      if (definition) return Promise.resolve(definition.constructor);
      let pending = self.whenDefined.get(name);
      if (!pending) {
        pending = Promise.withResolvers();
        self.whenDefined.set(name, pending);
      }
      return pending.promise;
    }

    upgrade(root) {
      ofRegistry(this);
      if (!(root instanceof Node)) throw new TypeError("root must be a Node");
      flush();
      for (const element of shadowIncludingElements(root)) {
        if (registryOf(element) !== this) continue;
        for (const attribute of Array.from(element.attributes)) {
          tryUpgrade(attribute);
        }
      }
    }

    initialize(root) {
      const self = ofRegistry(this);
      if (!(root instanceof Node)) throw new TypeError("root must be a Node");
      flush();
      const isDocument = root.nodeType === Node.DOCUMENT_NODE;
      if (
        !self.scoped &&
        (isDocument || registryOf(root.ownerDocument) !== this)
      ) {
        throw new DOMException(
          "A non-scoped CustomAttributeRegistry can only initialize nodes of its own document",
          "NotSupportedError",
        );
      }
      if ((isDocument || root instanceof ShadowRoot) && !registryOf(root)) {
        registries.set(root, this);
      }
      const doc = isDocument ? root : root.ownerDocument;
      if (self.scoped) self.documents.add(doc);
      if (!observedRoots.has(doc)) observeRoot(doc);
      for (const element of treeElements(root)) {
        if (!registryOf(element)) registries.set(element, this);
        if (registryOf(element) !== this) continue;
        for (const attribute of Array.from(element.attributes)) {
          tryUpgrade(attribute);
        }
      }
    }
  }
  for (const key of [
    "define",
    "get",
    "getName",
    "whenDefined",
    "upgrade",
    "initialize",
  ]) {
    enumerate(CustomAttributeRegistry.prototype, key);
  }
  Object.defineProperty(CustomAttributeRegistry.prototype, Symbol.toStringTag, {
    value: "CustomAttributeRegistry",
    configurable: true,
  });

  constructingGlobal = true;
  const globalRegistry = new CustomAttributeRegistry();
  constructingGlobal = false;
  registries.set(document, globalRegistry);

  function Attr() {
    if (new.target === undefined || new.target === Attr) {
      throw new TypeError("Illegal constructor");
    }
    const registry = activeRegistries.get(new.target) ?? globalRegistry;
    const definition = internals.get(registry).byConstructor.get(new.target);
    if (!definition) {
      throw new TypeError(
        "Illegal constructor: class is not a defined custom attribute",
      );
    }
    let prototype = new.target.prototype;
    if (Object(prototype) !== prototype) prototype = NativeAttr.prototype;
    const stack = definition.constructionStack;
    if (stack.length === 0) {
      const attribute = nativeCreateAttribute.call(document, definition.name);
      Object.setPrototypeOf(attribute, prototype);
      entries.set(attribute, {
        state: "custom",
        definition,
        connected: false,
        document,
      });
      return attribute;
    }
    const attribute = stack[stack.length - 1];
    if (attribute === ALREADY_CONSTRUCTED) {
      throw new TypeError("Illegal constructor: attribute already constructed");
    }
    Object.setPrototypeOf(attribute, prototype);
    stack[stack.length - 1] = ALREADY_CONSTRUCTED;
    return attribute;
  }
  Attr.prototype = NativeAttr.prototype;
  Object.setPrototypeOf(Attr, Object.getPrototypeOf(NativeAttr));
  Object.defineProperty(NativeAttr.prototype, "constructor", {
    value: Attr,
    writable: true,
    configurable: true,
  });
  globalThis.Attr = Attr;
  globalThis.CustomAttributeRegistry = CustomAttributeRegistry;
  Object.defineProperty(globalThis, "customAttributes", {
    get() {
      return globalRegistry;
    },
    enumerable: true,
    configurable: true,
  });

  Object.defineProperty(Element.prototype, "customAttributeRegistry", {
    get() {
      return registryOf(this);
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(ShadowRoot.prototype, "customAttributeRegistry", {
    get() {
      return registryOf(this);
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(Document.prototype, "customAttributeRegistry", {
    get() {
      return registries.get(this) ?? null;
    },
    enumerable: true,
    configurable: true,
  });

  Document.prototype.createAttribute = function createAttribute(localName) {
    const attribute = nativeCreateAttribute.call(this, localName);
    const registry = registryOf(this);
    const definition = lookupDefinition(registry, null, attribute.localName);
    if (definition) {
      const entry = {
        state: "precustomized",
        definition,
        connected: false,
        document: this,
      };
      entries.set(attribute, entry);
      construct(attribute, entry, definition, registry);
    }
    return attribute;
  };

  function optionRegistry(options, doc) {
    return typeof options === "object" && options !== null
      ? checkRegistryOption(options.customAttributeRegistry, doc)
      : undefined;
  }

  Document.prototype.createElement = function createElement(
    localName,
    options,
  ) {
    const registry = optionRegistry(options, this);
    const element = nativeCreateElement.call(this, localName, options);
    const chosen = registry === undefined ? registryOf(this) : registry;
    if (chosen) registries.set(element, chosen);
    return element;
  };

  Document.prototype.createElementNS = function createElementNS(
    namespace,
    qualifiedName,
    options,
  ) {
    const registry = optionRegistry(options, this);
    const element = nativeCreateElementNS.call(
      this,
      namespace,
      qualifiedName,
      options,
    );
    const chosen = registry === undefined ? registryOf(this) : registry;
    if (chosen) registries.set(element, chosen);
    return element;
  };

  Document.prototype.importNode = function importNode(node, options = false) {
    const registry = optionRegistry(options, this);
    const copy = nativeImportNode.call(this, node, options);
    const fallback = registry ?? registryOf(this);
    if (fallback) {
      const sources = treeElements(node);
      treeElements(copy).forEach((element, i) => {
        const own = sources[i] && registryOf(sources[i]);
        registries.set(
          element,
          own ? (internals.get(own).scoped ? own : registryOf(this)) : fallback,
        );
      });
    }
    return copy;
  };

  Element.prototype.attachShadow = function attachShadow(init) {
    const registry = optionRegistry(init, this.ownerDocument);
    const shadow = nativeAttachShadow.call(this, init);
    const chosen =
      registry === undefined ? registryOf(this.ownerDocument) : registry;
    if (chosen) registries.set(shadow, chosen);
    if (shadow.mode === "closed") closedShadows.set(this, shadow);
    observeRoot(shadow);
    return shadow;
  };

  for (const proto of [Element.prototype, ShadowRoot.prototype]) {
    for (const name of ["setHTMLUnsafe", "setHTML"]) {
      const native = proto[name];
      if (!native) continue;
      proto[name] = {
        [name](html, options) {
          const registry = optionRegistry(options, this.ownerDocument);
          const result = native.call(this, html, options);
          if (registry) {
            for (const element of this.querySelectorAll("*")) {
              registries.set(element, registry);
            }
          }
          return result;
        },
      }[name];
    }
  }

  for (const proto of [
    Element.prototype,
    Document.prototype,
    DocumentFragment.prototype,
  ]) {
    const native = proto.moveBefore;
    if (!native) continue;
    proto.moveBefore = function moveBefore(node, child) {
      const result = native.call(this, node, child);
      if (this.isConnected && node.nodeType === Node.ELEMENT_NODE) {
        for (const element of shadowIncludingElements(node)) {
          for (const attribute of Array.from(element.attributes)) {
            const entry = entries.get(attribute);
            if (entry?.state === "custom" && entry.connected) {
              invoke(attribute, "connectedMoveCallback", []);
            }
          }
        }
      }
      return result;
    };
  }

  observeRoot(document);
}
