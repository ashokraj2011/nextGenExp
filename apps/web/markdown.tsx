import { Fragment, type ReactNode } from "react";

const inlinePattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;

export function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(inlinePattern);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function RichText({ text, className }: { text: string; className?: string }) {
  const lines = text.split(/\r?\n/);
  const hasStructure = lines.some((line) => /^\s*([-*]|\d+\.)\s+/.test(line)) || text.includes("\n\n");

  if (!hasStructure) {
    return <p className={className}>{renderInlineMarkdown(text)}</p>;
  }

  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={"ul-" + i} className="rich-list">
          {items.map((item, idx) => <li key={idx}>{renderInlineMarkdown(item)}</li>)}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={"ol-" + i} className="rich-list">
          {items.map((item, idx) => <li key={idx}>{renderInlineMarkdown(item)}</li>)}
        </ol>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push(<p key={"p-" + i}>{renderInlineMarkdown(paragraph.join("\n"))}</p>);
  }

  return <div className={(className ? className + " " : "") + "rich-text"}>{blocks}</div>;
}
