/** RED 反例套件的公共返回结构；不参与 bun test 发现。 */

export const TIMEOUT_MS = 5000;

export function red(actual, reason, evidence) {
  return { green: false, actual, reason, evidence };
}

export function green(actual, evidence) {
  return { green: true, actual, reason: "", evidence };
}

export function text(value) {
  return typeof value === "string" ? value : String(value);
}

export function snippet(messages) {
  return messages.map((message) => text(message?.content)).join("\n");
}
