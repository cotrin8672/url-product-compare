type Span = Readonly<{ value: string; quote: string }>;

/** Over-find literal values; Jev decides which field, if any, each value describes. */
export function consumerValueSpans(text: string): readonly Span[] {
  const spans: Span[] = [];
  const seen = new Set<string>();
  const add = (value: string, start: number, end: number): void => {
    const trimmed = value.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > 100 ||
      seen.has(trimmed) ||
      /(?:です|ます|ください|しました|されています)(?:$|[、,])/.test(trimmed)
    ) {
      return;
    }
    seen.add(trimmed);
    const valueStart = text.indexOf(trimmed, start);
    if (valueStart < 0 || valueStart > end) {
      return;
    }
    const from = Math.max(0, valueStart - 45);
    spans.push({
      value: trimmed,
      quote: text.slice(from, Math.min(text.length, valueStart + trimmed.length + 45)).trim(),
    });
  };
  const quantities =
    /\d+(?:[.,]\d+)*\s*(?:[a-zμµ%℃]+(?!\d)|セット|(?:(?!入|セット)[\p{Script=Han}\p{Script=Katakana}ー]){1,6})(?:\s*[×x*]\s*\d+(?:[.,]\d+)*\s*(?:[a-zμµ%℃]+(?!\d)|セット|(?:(?!入|セット)[\p{Script=Han}\p{Script=Katakana}ー]){1,6})?)*/giu;
  for (const match of text.matchAll(quantities)) {
    add(match[0], match.index, match.index + match[0].length);
    for (const part of match[0].matchAll(/(?:^|[×*]|x(?=\s*\d))(.+?)(?=[×*]|x(?=\s*\d)|$)/g)) {
      if (part[1] !== undefined) {
        add(part[1], match.index + part.index, match.index + part.index + part[0].length);
      }
    }
  }
  for (const match of text.matchAll(
    /(?:【([^】\n]{1,80})】|^([^\n:：]{1,80})[:：])([^【\n]{1,300})/gm,
  )) {
    const value = match[3];
    if (value !== undefined) {
      add(value, match.index, match.index + match[0].length);
    }
  }
  for (const match of text.matchAll(
    /(?:^|[\n。;；【】()[\]、,，:：])([^\n。;；【】()[\]、,，:：]{2,100})(?=[\n。;；【】()[\]、,，:：]|$)/g,
  )) {
    if (match[1] !== undefined && !/[:：]/.test(text[match.index + match[0].length] ?? "")) {
      add(match[1], match.index, match.index + match[0].length);
    }
  }
  for (const match of text.matchAll(/[\p{Script=Katakana}ー]{3,32}[\p{Script=Han}]{0,8}/gu)) {
    add(match[0], match.index, match.index + match[0].length);
  }
  // shortcut: Keep the first 128 spans; revisit if long listings lose important values.
  return Object.freeze(spans.slice(0, 128));
}
