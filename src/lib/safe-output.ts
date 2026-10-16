// src/lib/safe-output.ts
// Setup global sanitization to redirect console.log to console.error
// and strip/replace emojis from stdout/stderr to prevent crashes on Windows.

// Replace common emojis with safe text equivalents to preserve log meaning
const emojiMap: Record<string, string> = {
  '✅': '[OK]',
  '❌': '[ERR]',
  '⚠️': '[WARN]',
  '⚠': '[WARN]',
  'ℹ️': '[INFO]',
  'ℹ': '[INFO]',
  '📚': '[DOCS]',
  '🚀': '[START]',
  '🔍': '[FIND]',
  '🌐': '[NET]',
  '🧠': '[AI]',
  '🔗': '[LINK]',
  '💡': '[INFO]',
  '🏗️': '[CAP]',
  '🏗': '[CAP]',
  '🧪': '[TEST]',
  '🎨': '[DESIGN]',
  '🕹️': '[UI5]',
  '🕹': '[UI5]',
  '🔧': '[TOOL]',
  '🚢': '[MTA]',
  '📝': '[NOTE]',
  '📊': '[STATS]',
  '💻': '[DEV]',
  '✨': '[CLEAN]',
  '🧹': '[CLEAN]',
  '🔀': '[MIXED]',
  '☁️': '[BTP]',
  '☁': '[BTP]',
  '🏛️': '[ARCH]',
  '🏛': '[ARCH]'
};

export function sanitizeText(text: string): string {
  if (typeof text !== 'string') return text;
  
  let cleaned = text;
  for (const [emoji, replacement] of Object.entries(emojiMap)) {
    cleaned = cleaned.replaceAll(emoji, replacement);
  }

  // Remove any remaining emojis, emoji presentation selectors, skin tones, or zero-width joiners
  const emojiRegex = /[\u200D\uFE0F\uFE0E]|\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
  return cleaned.replace(emojiRegex, '');
}

// Redirect console.log and console.info to console.error
console.log = (...args: any[]) => {
  console.error(...args);
};

console.info = (...args: any[]) => {
  console.error(...args);
};

// Monkey-patch process.stdout.write and process.stderr.write
const originalStdoutWrite = process.stdout.write;
process.stdout.write = function (
  chunk: any,
  encodingOrCb?: any,
  callback?: any
): boolean {
  if (typeof chunk === 'string') {
    chunk = sanitizeText(chunk);
  }
  return originalStdoutWrite.call(process.stdout, chunk, encodingOrCb, callback);
};

const originalStderrWrite = process.stderr.write;
process.stderr.write = function (
  chunk: any,
  encodingOrCb?: any,
  callback?: any
): boolean {
  if (typeof chunk === 'string') {
    chunk = sanitizeText(chunk);
  }
  return originalStderrWrite.call(process.stderr, chunk, encodingOrCb, callback);
};
