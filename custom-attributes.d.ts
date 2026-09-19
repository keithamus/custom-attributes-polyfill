export {};

declare global {
  type CustomAttributeConstructor = new () => Attr;

  interface CustomAttributeRegistry {
    define(name: string, constructor: CustomAttributeConstructor): void;
    get(name: string): CustomAttributeConstructor | undefined;
    getName(constructor: CustomAttributeConstructor): string | null;
    whenDefined(name: string): Promise<CustomAttributeConstructor>;
    upgrade(root: Node): void;
    initialize(root: Node): void;
  }

  var CustomAttributeRegistry: {
    prototype: CustomAttributeRegistry;
    new (): CustomAttributeRegistry;
  };

  var Attr: {
    prototype: Attr;
    new (): Attr;
  };

  interface Window {
    readonly customAttributes: CustomAttributeRegistry;
  }
  var customAttributes: CustomAttributeRegistry;

  interface Element {
    readonly customAttributeRegistry: CustomAttributeRegistry | null;
  }
  interface Document {
    readonly customAttributeRegistry: CustomAttributeRegistry | null;
  }
  interface ShadowRoot {
    readonly customAttributeRegistry: CustomAttributeRegistry | null;
  }

  interface ElementCreationOptions {
    customAttributeRegistry?: CustomAttributeRegistry | null;
  }
  interface ImportNodeOptions {
    customAttributeRegistry?: CustomAttributeRegistry;
  }
  interface ShadowRootInit {
    customAttributeRegistry?: CustomAttributeRegistry | null;
  }
  interface SetHTMLOptions {
    customAttributeRegistry?: CustomAttributeRegistry;
  }
  interface SetHTMLUnsafeOptions {
    customAttributeRegistry?: CustomAttributeRegistry;
  }
}
