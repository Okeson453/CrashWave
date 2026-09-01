/**
 * Safe Telegram outbound text — avoid parse entity failures on dynamic content.
 */

/** MarkdownV2 special characters */
export function escapeMarkdownV2(text: string): string {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** Legacy Markdown special characters */
export function escapeMarkdown(text: string): string {
  return String(text).replace(/([_*`\[\]])/g, '\\$1');
}

export function stripForPlainText(text: string): string {
  return String(text).replace(/[*_`\[\]]/g, '');
}

/** Prefer plain text for errors and diagnostics (no parse_mode). */
export function asPlainError(title: string, detail?: string): string {
  const d = detail ? `\n\n${stripForPlainText(detail).slice(0, 500)}` : '';
  return `${title}${d}`;
}
