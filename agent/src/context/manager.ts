import type {
  CompactResult,
  ContentPart,
  ContextState,
  Message,
  ModelCapabilities,
  Provider,
  ProviderRequest,
  ToolCall,
  ToolSpec,
} from '../contracts/index.js';

/*
 * Behaviourally adapted from Codex core/src/context_manager/history.rs,
 * normalize.rs and compact.rs. This implementation keeps Dangoo's typed
 * messages, asset references and pinned creative state, and stores raw history
 * through an injected store rather than a Codex rollout or account service.
 */

export type CompactMode = 'auto' | 'manual';

export interface ContextHistoryRecord {
  readonly id: string;
  readonly state: ContextState;
  readonly messages: readonly Message[];
  readonly savedAt: number;
}

export interface ContextHistoryStore {
  save(record: Omit<ContextHistoryRecord, 'id'>): string | Promise<string>;
  read?(id: string): ContextHistoryRecord | undefined | Promise<ContextHistoryRecord | undefined>;
}

export class InMemoryContextHistoryStore implements ContextHistoryStore {
  private readonly records = new Map<string, ContextHistoryRecord>();
  private counter = 0;

  save(record: Omit<ContextHistoryRecord, 'id'>): string {
    this.counter += 1;
    const id = `history-${this.counter}`;
    const stored: ContextHistoryRecord = Object.freeze({
      id,
      state: cloneState(record.state),
      messages: Object.freeze(record.messages.map(cloneMessage)),
      savedAt: record.savedAt,
    });
    this.records.set(id, stored);
    return id;
  }

  read(id: string): ContextHistoryRecord | undefined {
    const record = this.records.get(id);
    return record ? cloneHistoryRecord(record) : undefined;
  }

  latest(): ContextHistoryRecord | undefined {
    const records = [...this.records.values()];
    const record = records.at(-1);
    return record ? cloneHistoryRecord(record) : undefined;
  }
}

export interface ContextManagerOptions {
  historyStore?: ContextHistoryStore;
  /** Coarse image estimate in tokens. Actual provider usage can recalibrate it. */
  imageTokens?: number;
  assetTokens?: number;
  outputReserve?: number | ((capabilities: ModelCapabilities) => number);
  /** Total request estimate threshold, including system, tools and output reserve. */
  autoCompactTokenLimit?: number;
  /** Number of complete history units retained after successful compaction. */
  compactTailUnits?: number;
  /** Maximum token target for the retained tail; pairing can make it larger. */
  compactTailTokens?: number;
  maxMessageTextChars?: number;
}

export class ContextError extends Error {
  readonly code:
    | 'budget'
    | 'invalid_history'
    | 'vision_unsupported'
    | 'summary_failed'
    | 'store_failed';

  constructor(message: string, code: ContextError['code'], options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContextError';
    this.code = code;
  }
}

interface HistoryUnit {
  readonly messages: Message[];
  readonly indices: number[];
}

const DEFAULT_IMAGE_TOKENS = 1_024;
const DEFAULT_ASSET_TOKENS = 64;
const DEFAULT_TAIL_UNITS = 8;
const DEFAULT_TAIL_FRACTION = 0.25;

function isImagePart(part: ContentPart): boolean {
  return part.type === 'image' || part.type === 'asset';
}

function hasImage(message: Message): boolean {
  return message.content.some(isImagePart);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return value;
    }
  }
}

function cloneMessage(message: Message): Message {
  return {
    id: message.id,
    role: message.role,
    content: message.content.map((part) => cloneValue(part)),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => cloneValue(call)) } : {}),
    ...(message.callId ? { callId: message.callId } : {}),
    createdAt: message.createdAt,
  };
}

function cloneState(state: ContextState): ContextState {
  return {
    messages: state.messages.map(cloneMessage),
    ...(state.summary !== undefined ? { summary: state.summary } : {}),
    summaryVersion: state.summaryVersion,
    pinned: cloneValue(state.pinned),
    viewedAssets: state.viewedAssets.map((asset) => cloneValue(asset)),
  };
}

function cloneHistoryRecord(record: ContextHistoryRecord): ContextHistoryRecord {
  return {
    id: record.id,
    state: cloneState(record.state),
    messages: record.messages.map(cloneMessage),
    savedAt: record.savedAt,
  };
}

function textBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function estimateToolCall(call: ToolCall): number {
  return Math.ceil((textBytes(call.id) + textBytes(call.name) + textBytes(safeJson(call.arguments)) + 32) / 4);
}

function estimatePart(part: ContentPart, imageTokens: number, assetTokens: number): number {
  if (part.type === 'text') return Math.ceil(textBytes(part.text) / 4) + 2;
  if (part.type === 'image') return imageTokens;
  return assetTokens;
}

function estimateMessage(message: Message, imageTokens: number, assetTokens: number): number {
  let total = 8 + Math.ceil(textBytes(message.role) / 4) + Math.ceil(textBytes(message.id) / 4);
  for (const part of message.content) total += estimatePart(part, imageTokens, assetTokens);
  for (const call of message.toolCalls ?? []) total += estimateToolCall(call);
  if (message.callId) total += Math.ceil(textBytes(message.callId) / 4);
  return total;
}

function estimateTool(tool: ToolSpec): number {
  return Math.ceil((textBytes(tool.name) + textBytes(tool.description) + textBytes(safeJson(tool.inputSchema)) + textBytes(tool.revision) + 48) / 4);
}

function formatPinnedContext(state: ContextState): string {
  const fields: string[] = [];
  if (Object.keys(state.pinned).length > 0) {
    fields.push(`[DANGOO_PINNED_CREATIVE_CONSTRAINTS]\n${safeJson(state.pinned)}`);
  }
  if (state.viewedAssets.length > 0) {
    fields.push(`[DANGOO_VIEWED_ASSET_REFS]\n${safeJson(state.viewedAssets)}`);
  }
  return fields.join('\n');
}

function systemMessage(id: string, text: string): Message {
  return { id, role: 'system', content: [{ type: 'text', text }], createdAt: 0 };
}

function makeHistoryUnits(messages: Message[]): HistoryUnit[] {
  const callOwner = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const call of message.toolCalls ?? []) callOwner.set(call.id, index);
  });
  const grouped = new Map<number, number[]>();
  messages.forEach((message, index) => {
    if (message.role !== 'tool') return;
    const owner = message.callId ? callOwner.get(message.callId) : undefined;
    if (owner !== undefined) {
      const indexes = grouped.get(owner) ?? [owner];
      indexes.push(index);
      grouped.set(owner, indexes);
    }
  });
  const consumed = new Set<number>();
  const units: HistoryUnit[] = [];
  messages.forEach((message, index) => {
    if (consumed.has(index)) return;
    const indexes = message.toolCalls?.length ? grouped.get(index) ?? [index] : [index];
    indexes.sort((a, b) => a - b);
    indexes.forEach((item) => consumed.add(item));
    units.push({ messages: indexes.map((item) => messages[item]), indices: indexes });
  });
  return units;
}

function flattenUnits(units: readonly HistoryUnit[]): Message[] {
  return units.flatMap((unit) => unit.messages.map(cloneMessage));
}

function truncatePart(part: ContentPart, maxChars: number): ContentPart {
  if (part.type !== 'text' || part.text.length <= maxChars) return cloneValue(part);
  return { type: 'text', text: `${part.text.slice(0, Math.max(0, maxChars - 1))}…` };
}

function truncateMessage(message: Message, maxChars: number): Message {
  const result = cloneMessage(message);
  result.content = result.content.map((part) => truncatePart(part, maxChars));
  return result;
}

function truncateUnitToBudget(unit: HistoryUnit, budget: number, estimate: (messages: Message[]) => number, maxChars: number): HistoryUnit | undefined {
  if (estimate(unit.messages) <= budget) return unit;
  if (unit.messages.some((message) => message.content.some((part) => part.type !== 'text'))) {
    // Images and tool argument JSON are indivisible here. Dropping them would
    // silently change the creative input, so report an explicit budget block.
    const textOnly = unit.messages.map((message) => truncateMessage(message, 0));
    if (estimate(textOnly) > budget) return undefined;
  }
  let high = Math.max(64, maxChars);
  let low = 0;
  let best: HistoryUnit | undefined;
  for (let step = 0; step < 16; step += 1) {
    const chars = Math.floor((low + high) / 2);
    const candidate: HistoryUnit = { ...unit, messages: unit.messages.map((message) => truncateMessage(message, chars)) };
    if (estimate(candidate.messages) <= budget) {
      best = candidate;
      low = chars + 1;
    } else {
      high = chars - 1;
    }
  }
  return best;
}

function assertVision(messages: Message[], capabilities: ModelCapabilities): void {
  if (capabilities.vision && !messages.some(hasImage)) return;
  if (capabilities.vision) return;
  if (messages.some(hasImage)) {
    throw new ContextError('当前模型不支持图片输入，无法安全保留视觉上下文', 'vision_unsupported');
  }
}

export class ContextManager {
  private readonly historyStore: ContextHistoryStore;
  private readonly imageTokens: number;
  private readonly assetTokens: number;
  private readonly outputReserveOption: ContextManagerOptions['outputReserve'];
  private readonly autoCompactTokenLimit: number;
  private readonly compactTailUnits: number;
  private readonly compactTailTokens?: number;
  private readonly maxMessageTextChars: number;

  constructor(options: ContextManagerOptions = {}) {
    this.historyStore = options.historyStore ?? new InMemoryContextHistoryStore();
    this.imageTokens = Math.max(1, options.imageTokens ?? DEFAULT_IMAGE_TOKENS);
    this.assetTokens = Math.max(1, options.assetTokens ?? DEFAULT_ASSET_TOKENS);
    this.outputReserveOption = options.outputReserve;
    this.autoCompactTokenLimit = Math.max(1, Math.floor(options.autoCompactTokenLimit ?? 256_000));
    this.compactTailUnits = Math.max(1, Math.floor(options.compactTailUnits ?? DEFAULT_TAIL_UNITS));
    this.compactTailTokens = options.compactTailTokens;
    this.maxMessageTextChars = Math.max(64, Math.floor(options.maxMessageTextChars ?? 20_000));
  }

  estimate(messages: Message[]): number {
    return messages.reduce(
      (total, message) => total + estimateMessage(message, this.imageTokens, this.assetTokens),
      0,
    );
  }

  estimateRequest(messages: Message[], system = '', tools: ToolSpec[] = [], capabilities?: ModelCapabilities): number {
    const systemTokens = system ? Math.ceil(textBytes(system) / 4) + 8 : 0;
    const toolTokens = tools.reduce((total, tool) => total + estimateTool(tool), 0);
    const reserve = capabilities ? this.outputReserve(capabilities) : 0;
    return systemTokens + toolTokens + this.estimate(messages) + reserve;
  }

  prepare(state: ContextState, system: string, capabilities: ModelCapabilities, tools: ToolSpec[] = []): Message[] {
    const source = state.messages.map(cloneMessage);
    assertVision(source, capabilities);
    if (tools.length > 0 && !capabilities.tools) {
      throw new ContextError('当前模型不支持工具调用，无法安全发送工具目录', 'budget');
    }
    const prefix: Message[] = [];
    if (system.trim()) prefix.push(systemMessage('context-system', system));
    if (state.summary?.trim()) prefix.push(systemMessage(`context-summary-${state.summaryVersion}`, state.summary));
    const pinned = formatPinnedContext(state);
    if (pinned) prefix.push(systemMessage(`context-pinned-${state.summaryVersion}`, pinned));
    const budget = this.promptBudget(capabilities);
    const prefixTokens = this.estimate(prefix) + tools.reduce((total, tool) => total + estimateTool(tool), 0);
    if (prefixTokens > budget) throw new ContextError('Pinned context and tool schemas exceed the model context budget', 'budget');
    const available = budget - prefixTokens;
    const units = makeHistoryUnits(source);
    const selected: HistoryUnit[] = [];
    let used = 0;
    for (let i = units.length - 1; i >= 0; i -= 1) {
      const unit = units[i];
      const cost = this.estimate(unit.messages);
      if (used + cost <= available) {
        selected.unshift(unit);
        used += cost;
        continue;
      }
      // Keep the newest complete call/result unit even when one large result
      // needs bounded text truncation. IDs and tool arguments remain intact.
      if (selected.length === 0 && available > 0) {
        const fit = truncateUnitToBudget(unit, available, (messages) => this.estimate(messages), this.maxMessageTextChars);
        if (!fit) throw new ContextError('最新完整回合无法在保留工具配对和图片的前提下放入上下文预算', 'budget');
        selected.unshift(fit);
      }
      break;
    }
    return [...prefix, ...flattenUnits(selected)];
  }

  needsCompact(state: ContextState, capabilities: ModelCapabilities, system = '', tools: ToolSpec[] = []): boolean {
    const messages = state.messages;
    assertVision(messages, capabilities);
    if (tools.length > 0 && !capabilities.tools) {
      throw new ContextError('当前模型不支持工具调用，无法安全发送工具目录', 'budget');
    }
    return this.estimateRequest(
      messages,
      `${system}\n${state.summary ?? ''}\n${formatPinnedContext(state)}`,
      tools,
      capabilities,
    ) >= Math.min(this.autoCompactTokenLimit, capabilities.contextWindow);
  }

  exceedsWindow(state: ContextState, capabilities: ModelCapabilities, system = '', tools: ToolSpec[] = []): boolean {
    return this.estimateRequest(
      state.messages,
      `${system}\n${state.summary ?? ''}\n${formatPinnedContext(state)}`,
      tools,
      capabilities,
    ) > capabilities.contextWindow;
  }

  /** Compact at a safe complete tool-call/result boundary and persist raw history first. */
  async compact(
    state: ContextState,
    provider: Provider,
    model: string,
    signal: AbortSignal,
    mode: CompactMode | { mode?: CompactMode } = 'manual',
  ): Promise<CompactResult> {
    const original = cloneState(state);
    const compactMode: CompactMode = typeof mode === 'string' ? mode : mode.mode ?? 'manual';
    try {
      const capabilities = provider.capabilities(model);
      assertVision(original.messages, capabilities);
      const historyId = await this.saveRaw(original);
      const summaryInput = this.summaryInput(original, capabilities, model);
      const request: ProviderRequest = {
        model,
        messages: summaryInput,
        tools: [],
        signal,
        maxOutputTokens: Math.max(1, Math.min(capabilities.maxOutputTokens, Math.floor(capabilities.contextWindow * 0.1) || 1)),
      };
      let summaryText = '';
      for await (const event of provider.stream(request)) {
        if (event.type === 'text.delta') summaryText += event.text;
        else if (event.type === 'tool.call') {
          return this.failed(original, '压缩摘要返回了工具调用，未改变当前上下文');
        }
      }
      if (!summaryText.trim()) return this.failed(original, '压缩摘要为空，未改变当前上下文');
      const tail = this.compactTail(original, capabilities);
      const facts = safeJson({
        historyId,
        mode: compactMode,
        pinned: original.pinned,
        viewedAssets: original.viewedAssets,
        retainedMessageIds: tail.map((message) => message.id),
      });
      const next: ContextState = {
        messages: tail,
        summary: `${summaryText.trim()}\n\n[DANGOO_PERSISTENT_FACTS]\n${facts}`,
        summaryVersion: original.summaryVersion + 1,
        pinned: cloneValue(original.pinned),
        viewedAssets: original.viewedAssets.map((asset) => cloneValue(asset)),
      };
      return { state: next, changed: true };
    } catch (error) {
      const reason = error instanceof ContextError ? error.message : '压缩摘要请求失败，未改变当前上下文';
      return this.failed(original, reason);
    }
  }

  compactManual(state: ContextState, provider: Provider, model: string, signal: AbortSignal): Promise<CompactResult> {
    return this.compact(state, provider, model, signal, 'manual');
  }

  compactAuto(state: ContextState, provider: Provider, model: string, signal: AbortSignal): Promise<CompactResult> {
    return this.compact(state, provider, model, signal, 'auto');
  }

  /** Compact automatically at the configured threshold or the provider window. */
  async compactIfNeeded(
    state: ContextState,
    provider: Provider,
    model: string,
    signal: AbortSignal,
    system = '',
    tools: ToolSpec[] = [],
  ): Promise<CompactResult> {
    const capabilities = provider.capabilities(model);
    if (!this.needsCompact(state, capabilities, system, tools)) return { state: cloneState(state), changed: false, reason: 'within_budget' };
    return this.compact(state, provider, model, signal, 'auto');
  }

  async readRawHistory(id: string): Promise<ContextHistoryRecord | undefined> {
    if (!this.historyStore.read) return undefined;
    const record = await this.historyStore.read(id);
    return record ? cloneHistoryRecord(record) : undefined;
  }

  private promptBudget(capabilities: ModelCapabilities): number {
    const reserve = this.outputReserve(capabilities);
    const budget = capabilities.contextWindow - reserve;
    if (budget <= 0) throw new ContextError('模型输出预留已耗尽上下文预算', 'budget');
    return budget;
  }

  private outputReserve(capabilities: ModelCapabilities): number {
    const reserve =
      typeof this.outputReserveOption === 'function'
        ? this.outputReserveOption(capabilities)
        : this.outputReserveOption ?? capabilities.maxOutputTokens;
    return Math.max(1, Math.min(capabilities.contextWindow, Math.floor(reserve)));
  }

  private async saveRaw(state: ContextState): Promise<string> {
    try {
      return await this.historyStore.save({ state: cloneState(state), messages: state.messages.map(cloneMessage), savedAt: Date.now() });
    } catch (error) {
      throw new ContextError('无法保存压缩前的原始历史', 'store_failed', { cause: error });
    }
  }

  private summaryInput(state: ContextState, capabilities: ModelCapabilities, _model: string): Message[] {
    const prefix = [
      '请压缩 Dangoo 艺术创作会话上下文。保留当前目标、用户约束、已完成步骤、未完成事项、当前 Skill 阶段，以及所有 canvas/node/asset ID 和版本、批次顺序、未完成 job、工具调用事实。不要创造或修改事实。',
      formatPinnedContext(state),
      state.summary ? `[PREVIOUS_SUMMARY]\n${state.summary}` : '',
    ].filter(Boolean).join('\n\n');
    const messages: Message[] = [systemMessage('compact-system', prefix)];
    const units = makeHistoryUnits(state.messages);
    // A summary sees the entire raw history. If it is larger than the model's
    // input budget, retain complete call/result units from the tail and keep a
    // deterministic count in the system prompt; the raw copy is already safe.
    const budget = Math.max(1, capabilities.contextWindow - this.outputReserve(capabilities));
    const selected: HistoryUnit[] = [];
    let used = this.estimate(messages);
    for (let i = units.length - 1; i >= 0; i -= 1) {
      const cost = this.estimate(units[i].messages);
      if (used + cost > budget && selected.length > 0) break;
      if (used + cost <= budget) {
        selected.unshift(units[i]);
        used += cost;
      } else if (selected.length === 0) {
        selected.unshift({ ...units[i], messages: units[i].messages.map((message) => truncateMessage(message, this.maxMessageTextChars)) });
      }
    }
    messages.push(...flattenUnits(selected));
    return messages;
  }

  private compactTail(state: ContextState, capabilities: ModelCapabilities): Message[] {
    const units = makeHistoryUnits(state.messages);
    const target = this.compactTailTokens ?? Math.max(1, Math.floor(Math.min(this.promptBudget(capabilities), this.autoCompactTokenLimit) * DEFAULT_TAIL_FRACTION));
    const selected: HistoryUnit[] = [];
    let used = 0;
    for (let i = units.length - 1; i >= 0 && selected.length < this.compactTailUnits; i -= 1) {
      const cost = this.estimate(units[i].messages);
      if (used + cost <= target || selected.length === 0) {
        selected.unshift(units[i]);
        used += cost;
      }
    }
    return flattenUnits(selected);
  }

  private failed(state: ContextState, reason: string): CompactResult {
    return { state: cloneState(state), changed: false, reason };
  }
}
