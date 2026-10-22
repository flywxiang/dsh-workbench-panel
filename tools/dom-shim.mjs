/**
 * A very small DOM shim, enough for the workbench engine: elements with
 * attributes, children, text, classes, and events; a document that creates
 * them; and a container with a settable client width.
 *
 * The engine deliberately touches no framework, so a shim this thin is a real
 * test of the shipped code rather than a test of a mock.
 */

/** Minimal CSSStyleDeclaration stand-in that reports no custom properties. */
class ShimStyle {
  /**
   * @param {Record<string, string>} [properties] - inline properties.
   */
  constructor(properties = {}) {
    this.properties = { ...properties }
  }

  /** @returns {string} the value or an empty string. */
  getPropertyValue(name) {
    return this.properties[name] ?? ''
  }
}

/** Minimal DOM element. */
export class ShimElement {
  /**
   * @param {string} tagName - tag name.
   * @param {string} [namespace] - namespace URI.
   */
  constructor(tagName, namespace = 'http://www.w3.org/1999/xhtml') {
    this.tagName = tagName.toUpperCase()
    this.localName = tagName.toLowerCase()
    this.namespaceURI = namespace
    this.attributes = new Map()
    this.children = []
    this.listeners = new Map()
    this.style = new ShimStyle()
    this.textContent = ''
    this.hidden = false
    this.disabled = false
    this.value = ''
    /** Test-controlled layout width. */
    this.clientWidth = 900
    this.ownerDocument = undefined
  }

  /**
   * `class` and `className` are the same slot in the real DOM, and the engine
   * uses both spellings (SVG takes attributes, HTML takes the property).
   * @returns {string} the class attribute.
   */
  get className() {
    return this.attributes.get('class') ?? ''
  }

  /** @param {string} value - replacement class attribute. */
  set className(value) {
    this.attributes.set('class', value)
  }

  /** @param {Record<string, unknown>} attributes - attribute map. */
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  /** @returns {string | undefined} the attribute value. */
  getAttribute(name) {
    return this.attributes.get(name)
  }

  /** @param {string} name - attribute name. */
  removeAttribute(name) {
    this.attributes.delete(name)
  }

  /** @param {ShimElement} child - child to append. */
  appendChild(child) {
    this.append(child)
    return child
  }

  /** @param {ShimElement} child - child to remove. */
  removeChild(child) {
    this.children = this.children.filter((node) => node !== child)
    return child
  }

  /** Remove this element from its parent, if it has one. */
  remove() {
    this.parentNode?.removeChild(this)
  }

  /** @param {ShimElement} child - child to append. */
  append(...nodes) {
    for (const node of nodes) {
      // The real DOM stringifies every non-Node argument, so `replaceChildren(a,
      // null)` appends a text node "null" instead of throwing. Mirror that here:
      // a shim that throws on input the browser accepts only hides real bugs.
      if (node === null || typeof node !== 'object') {
        const text = new ShimElement('#text')
        text.textContent = String(node)
        text.ownerDocument = this.ownerDocument
        this.children.push(text)
        continue
      }
      node.ownerDocument = this.ownerDocument
      node.parentNode = this
      this.children.push(node)
    }
  }

  /** @param {ShimElement[]} nodes - replacement children. */
  replaceChildren(...nodes) {
    this.children = []
    this.append(...nodes)
  }

  /** @returns {ShimElement[]} descendants in document order. */
  descendants() {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  /** @param {string} selector - a tag name, `.class`, or `[attribute]` selector. */
  querySelectorAll(selector) {
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const name = selector.slice(1, -1)
      return this.descendants().filter((node) => node.getAttribute(name) !== undefined)
    }
    if (selector.startsWith('.')) {
      return this.descendants().filter((node) => node.classList.contains(selector.slice(1)))
    }
    return this.descendants().filter((node) => node.tagName === selector.toUpperCase())
  }

  /**
   * First descendant matching the selector, like the real DOM.
   * @param {string} selector - a tag name, `.class`, or `[attribute]` selector.
   * @returns {ShimElement | null} first match or null.
   */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  /** @param {string} type - event type. @param {(event: unknown) => void} handler - listener. */
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  /** @param {string} type - event type. @param {unknown} event - event payload. */
  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  /** Class-list affordances used by the engine. */
  get classList() {
    const owner = this
    return {
      /** @param {string} name - class name. */
      add(name) {
        if (!owner.className.split(' ').includes(name)) owner.className = `${owner.className} ${name}`.trim()
      },
      /** @param {string} name - class name. */
      remove(name) {
        owner.className = owner.className
          .split(' ')
          .filter((part) => part !== name)
          .join(' ')
      },
      /** @param {string} name - class name. */
      contains(name) {
        return owner.className.split(' ').includes(name)
      },
      /**
       * @param {string} name - class name.
       * @param {boolean} [force] - add when true, remove when false.
       */
      toggle(name, force) {
        const shouldAdd = force ?? !this.contains(name)
        if (shouldAdd) this.add(name)
        else this.remove(name)
      },
    }
  }

  /** @returns {ShimElement | undefined} the first child. */
  get firstChild() {
    return this.children[0]
  }
}

/** Minimal document. */
export class ShimDocument {
  constructor() {
    this.head = new ShimElement('head')
    this.body = new ShimElement('body')
    this.defaultView = { ResizeObserver: undefined, getComputedStyle: () => new ShimStyle() }
    this.head.ownerDocument = this
    this.body.ownerDocument = this
  }

  /**
   * @param {string} tagName - tag name.
   * @returns {ShimElement} a new element.
   */
  createElement(tagName) {
    const node = new ShimElement(tagName)
    node.ownerDocument = this
    return node
  }

  /**
   * @param {string} namespace - namespace URI.
   * @param {string} tagName - tag name.
   * @returns {ShimElement} a new element.
   */
  createElementNS(namespace, tagName) {
    return this.createElement(tagName)
  }
}
