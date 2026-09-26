/**
 * ---------------------------------------------------------------------------
 * A small, safe XML reader
 * ---------------------------------------------------------------------------
 * For the vendors that still answer in XML: Bandwidth's account API today,
 * Kurmi's SOAP next. Written here rather than imported because the shared
 * module graph has zero runtime dependencies and must run in a browser tab -
 * and `DOMParser` does not exist in Node, so there is no portable built-in.
 *
 * WHAT IT REFUSES, deliberately, because each is how an XML parser becomes an
 * attack surface on input we did not write:
 *
 *   - Any DOCTYPE. DTDs are where external entities (XXE) and entity
 *     expansion ("billion laughs") live, and no API response this platform
 *     reads has a reason to carry one. Refusing the whole construct is
 *     simpler and safer than parsing it carefully.
 *   - Named entities beyond the five XML predefines. With no DTD there is
 *     nothing to define them, so any other `&name;` is malformed.
 *   - Input over MAX_XML_BYTES, and nesting past MAX_DEPTH - bounded work on
 *     a hostile or broken body, not a hung Lambda.
 *
 * WHAT IT DOES NOT DO: namespaces are kept as written (`soap:Envelope` is an
 * element named `soap:Envelope`), and `localName` strips the prefix for
 * lookups - enough for SOAP bodies, where the prefix a server chooses is not
 * something to depend on. No schema validation; callers read what they need
 * and treat a missing element as missing.
 */

export type XmlElement = {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated character data directly inside this element, entity-decoded. */
  text: string;
};

export const MAX_XML_BYTES = 10 * 1024 * 1024;
export const MAX_DEPTH = 64;

export class XmlError extends Error {
  constructor(message: string) {
    super('XML: ' + message);
    this.name = 'XmlError';
  }
}

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);|&/g, (m, ref: string | undefined) => {
    if (!ref) throw new XmlError('bare "&" in text');
    if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    const v = PREDEFINED[ref];
    if (v === undefined) throw new XmlError('undefined entity &' + ref + ';');
    return v;
  });
}

const NAME = /^[A-Za-z_][\w.:-]*/;

export function parseXml(input: string): XmlElement {
  if (input.length > MAX_XML_BYTES) throw new XmlError('document larger than ' + MAX_XML_BYTES + ' bytes');
  let i = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    const text = lt === -1 ? input.slice(i) : input.slice(i, lt);
    if (text.length > 0) {
      if (stack.length === 0) {
        if (text.trim() !== '') throw new XmlError('text outside the root element');
      } else {
        stack[stack.length - 1].text += decode(text);
      }
    }
    if (lt === -1) break;
    i = lt;

    if (input.startsWith('<?', i)) {
      const end = input.indexOf('?>', i);
      if (end === -1) throw new XmlError('unterminated processing instruction');
      i = end + 2;
    } else if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i);
      if (end === -1) throw new XmlError('unterminated comment');
      i = end + 3;
    } else if (input.startsWith('<![CDATA[', i)) {
      const end = input.indexOf(']]>', i);
      if (end === -1) throw new XmlError('unterminated CDATA');
      if (stack.length === 0) throw new XmlError('CDATA outside the root element');
      stack[stack.length - 1].text += input.slice(i + 9, end);
      i = end + 3;
    } else if (input.startsWith('<!', i)) {
      // DOCTYPE and every other declaration. See the header.
      throw new XmlError('DOCTYPE and other declarations are refused');
    } else if (input.startsWith('</', i)) {
      const end = input.indexOf('>', i);
      if (end === -1) throw new XmlError('unterminated closing tag');
      const name = input.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new XmlError('mismatched closing tag </' + name + '>');
      if (stack.length === 0) root = open;
      i = end + 1;
    } else {
      const m = NAME.exec(input.slice(i + 1));
      if (!m) throw new XmlError('invalid tag at offset ' + i);
      const el: XmlElement = { name: m[0], attrs: {}, children: [], text: '' };
      i += 1 + m[0].length;

      // Attributes, then `>` or `/>`.
      for (;;) {
        while (/\s/.test(input[i] ?? '')) i++;
        if (input.startsWith('/>', i) || input[i] === '>') break;
        const an = NAME.exec(input.slice(i));
        if (!an) throw new XmlError('invalid attribute in <' + el.name + '>');
        i += an[0].length;
        while (/\s/.test(input[i] ?? '')) i++;
        if (input[i] !== '=') throw new XmlError('attribute without a value in <' + el.name + '>');
        i++;
        while (/\s/.test(input[i] ?? '')) i++;
        const q = input[i];
        if (q !== '"' && q !== "'") throw new XmlError('unquoted attribute in <' + el.name + '>');
        const close = input.indexOf(q, i + 1);
        if (close === -1) throw new XmlError('unterminated attribute in <' + el.name + '>');
        el.attrs[an[0]] = decode(input.slice(i + 1, close));
        i = close + 1;
      }

      if (stack.length === 0 && root) throw new XmlError('more than one root element');
      if (stack.length > 0) stack[stack.length - 1].children.push(el);
      if (input.startsWith('/>', i)) {
        i += 2;
        if (stack.length === 0) root = el;
      } else {
        i += 1;
        if (stack.length >= MAX_DEPTH) throw new XmlError('nesting deeper than ' + MAX_DEPTH);
        stack.push(el);
      }
    }
  }

  if (stack.length > 0) throw new XmlError('unclosed <' + stack[stack.length - 1].name + '>');
  if (!root) throw new XmlError('no root element');
  return root;
}

/** The element name without its namespace prefix. */
export function localName(el: XmlElement): string {
  const c = el.name.indexOf(':');
  return c === -1 ? el.name : el.name.slice(c + 1);
}

/** Direct children with this local name. */
export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => localName(c) === name);
}

export function child(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => localName(c) === name);
}

/** Trimmed text of a direct child, or undefined when the child is absent. */
export function childText(el: XmlElement, name: string): string | undefined {
  const c = child(el, name);
  return c ? c.text.trim() : undefined;
}

/** Every descendant with this local name, depth-first. */
export function descendants(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (localName(c) === name) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/** Escape text for an XML body the mocks write. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
