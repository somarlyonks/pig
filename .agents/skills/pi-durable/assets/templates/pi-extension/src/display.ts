// Used by Pi's TypeScript extension loader. No dependencies beyond Node.js.
import { stripVTControlCharacters } from 'node:util';

/** Sanitize remote text before it reaches a terminal component or session card. */
export function safeText(value: string, limit = 24000): string {
  const text = stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-(?:ant-)?[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]');
  return text.length > limit ? text.slice(0, limit) + '\n[Display truncated; use a specific job or evidence query.]' : text;
}
