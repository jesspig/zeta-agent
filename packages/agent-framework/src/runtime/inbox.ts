import type { AgentMessage } from "./agent";

export type QueueMode = "all" | "interrupt" | "step";
export type QueueTarget = "nextTurn" | "nextStep";
export type MessageId = number;

export interface InboxMessage {
  readonly id: MessageId;
  readonly body: AgentMessage;
}

export interface Inbox {
  readonly nextTurn: readonly InboxMessage[];
  readonly nextStep: readonly InboxMessage[];
  inject(body: AgentMessage): InboxMessage;
  steer(body: AgentMessage): InboxMessage;
  followUp(body: AgentMessage): InboxMessage;
  claim(target: QueueTarget): InboxMessage | undefined;
  poll(target: QueueTarget): InboxMessage[];
  peek(target: QueueTarget): InboxMessage | undefined;
  size(target: QueueTarget): number;
  clear(target: QueueTarget): void;
  getMode(): QueueMode;
  setMode(mode: QueueMode): void;
}

export function createInbox(options: { mode?: QueueMode } = {}): Inbox {
  let mode: QueueMode = options.mode ?? "all";
  let nextId = 0;
  let nextTurn: InboxMessage[] = [];
  let nextStep: InboxMessage[] = [];

  function queueFor(target: QueueTarget): InboxMessage[] {
    return target === "nextTurn" ? nextTurn : nextStep;
  }

  function make(body: AgentMessage): InboxMessage {
    nextId += 1;
    return { id: nextId, body };
  }

  return {
    get nextTurn() {
      return nextTurn;
    },
    get nextStep() {
      return nextStep;
    },
    inject(body) {
      const message = make(body);
      nextStep.push(message);
      return message;
    },
    steer(body) {
      const message = make(body);
      if (mode === "interrupt") {
        nextStep = [];
        nextTurn.unshift(message);
      } else {
        nextTurn.push(message);
      }
      return message;
    },
    followUp(body) {
      const message = make(body);
      nextTurn.push(message);
      return message;
    },
    claim(target) {
      return queueFor(target).shift();
    },
    poll(target) {
      const queue = queueFor(target);
      return mode === "step" ? queue.splice(0, 1) : queue.splice(0, queue.length);
    },
    peek(target) {
      return queueFor(target)[0];
    },
    size(target) {
      return queueFor(target).length;
    },
    clear(target) {
      if (target === "nextTurn") nextTurn = [];
      else nextStep = [];
    },
    getMode() {
      return mode;
    },
    setMode(value) {
      mode = value;
    },
  };
}
