type Node = Readonly<{
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: readonly Node[];
  value: string;
}>;
type MutableNode = {
  name: string;
  attributes: Record<string, string>;
  children: MutableNode[];
  value: string;
};

function entities(input: string): string | null {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  let output = "",
    cursor = 0;
  for (;;) {
    const amp = input.indexOf("&", cursor);
    if (amp < 0) {
      return output + input.slice(cursor);
    }
    const semi = input.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 16) {
      return null;
    }
    const entity = input.slice(amp + 1, semi);
    const value = named[entity];
    output += input.slice(cursor, amp);
    if (Object.hasOwn(named, entity) && value !== undefined) {
      output += value;
    } else {
      const code = /^#(?:[0-9]+|x[0-9a-fA-F]+)$/u.test(entity)
        ? Number.parseInt(entity.slice(entity[1] === "x" ? 2 : 1), entity[1] === "x" ? 16 : 10)
        : 0;
      if (
        !(
          code === 9 ||
          code === 10 ||
          code === 13 ||
          (code >= 32 &&
            code <= 0x10ffff &&
            !(code >= 0xd800 && code <= 0xdfff) &&
            code !== 0xfffe &&
            code !== 0xffff)
        )
      ) {
        return null;
      }
      output += String.fromCodePoint(code);
    }
    cursor = semi + 1;
  }
}

/** Bounded, non-validating XML subset for Yahoo's documented response. No DTD, entities, external IO or execution. */
export function parseXml(input: string): Node | null {
  if (
    input.length > 1_048_576 ||
    /<!DOCTYPE|<!ENTITY/iu.test(input) ||
    Array.from(input).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 && ![9, 10, 13].includes(code);
    })
  ) {
    return null;
  }
  const tokens =
    /<\?xml\s[^?]*\?>|<!--(?:(?!-->)[\s\S])*-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/[A-Za-z_][\w:.-]*\s*>|<[A-Za-z_][\w:.-]*(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/gy;
  const stack: MutableNode[] = [];
  let root: MutableNode | null = null,
    position = 0,
    count = 0;
  while (position < input.length) {
    tokens.lastIndex = position;
    const match = tokens.exec(input);
    if (match === null) {
      return null;
    }
    const token = match[0];
    position = tokens.lastIndex;
    const current = stack.at(-1);
    if (token.startsWith("<?xml")) {
      if (root !== null || input.slice(0, match.index).trim().length > 0) {
        return null;
      }
      continue;
    }
    if (token.startsWith("<!--")) {
      continue;
    }
    if (token.startsWith("<![CDATA[")) {
      if (current === undefined) {
        return null;
      }
      current.value += token.slice(9, -3);
      continue;
    }
    if (token.startsWith("</")) {
      if (current?.name !== token.slice(2, -1).trim()) {
        return null;
      }
      stack.pop();
      continue;
    }
    if (token.startsWith("<")) {
      const name = /^<([A-Za-z_][\w:.-]*)/u.exec(token)?.[1];
      if (
        name === undefined ||
        stack.length >= 32 ||
        ++count > 10000 ||
        (current === undefined && root !== null)
      ) {
        return null;
      }
      const attributes: Record<string, string> = {};
      for (const attribute of token
        .slice(name.length + 1)
        .matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
        const key = attribute[1],
          raw = attribute[2] ?? attribute[3];
        if (key === undefined || raw === undefined || Object.hasOwn(attributes, key)) {
          return null;
        }
        const value = entities(raw);
        if (value === null || key === "__proto__" || key === "constructor") {
          return null;
        }
        attributes[key] = value;
      }
      const node: MutableNode = { name, attributes, children: [], value: "" };
      if (current === undefined) {
        root = node;
      } else {
        current.children.push(node);
      }
      if (!token.endsWith("/>")) {
        stack.push(node);
      }
      continue;
    }
    const value = entities(token);
    if (value === null) {
      return null;
    }
    if (current === undefined) {
      if (value.trim().length > 0) {
        return null;
      }
    } else {
      current.value += value;
    }
  }
  return stack.length === 0 ? root : null;
}
export function child(node: Node | undefined, name: string): Node | undefined {
  const matches = node?.children.filter((entry) => entry.name === name);
  return matches?.length === 1 ? matches[0] : undefined;
}
