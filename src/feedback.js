import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { renderDeck } from './deck.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function inputFields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)))
    throw fail('수정 요청 입력을 확인해 주세요.');
}
function positiveVersion(value) { return Number.isSafeInteger(value) && value > 0; }

export class Feedback {
  constructor(store) { this.store = store; }
  async activeDeck(id) {
    const deck = await this.store.get(id);
    if (deck.deleted) throw fail('휴지통의 자료는 복원한 후 수정 요청을 확인해 주세요.', 409);
    return deck;
  }
  async records(id) {
    try { return JSON.parse(await readFile(this.store.path(id, 'feedback.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async targets(deck) {
    const source = await readFile(this.store.path(deck.id, 'assets/index.html'), 'utf8');
    const document = parseHTML(renderDeck(source, deck.state)).document;
    const owners = new Map();
    for (const element of document.querySelectorAll('[data-sd-id]')) {
      const slide = element.closest('[data-sd-slide]')?.getAttribute('data-sd-slide');
      if (deck.state.order.includes(slide)) owners.set(element.getAttribute('data-sd-id'), slide);
    }
    return owners;
  }
  async list(id) {
    return this.store.locked(id, async () => {
      const deck = await this.activeDeck(id), owners = await this.targets(deck);
      const items = await this.records(id);
      return {
        revision: deck.revision,
        items: items.slice().reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => ({
          ...item,
          stale: item.revision !== deck.revision,
          targetExists: deck.state.order.includes(item.slideId) && (item.elementId === null || owners.get(item.elementId) === item.slideId),
        })),
      };
    });
  }
  async create(id, input) {
    inputFields(input, ['revision', 'slideId', 'elementId', 'text']);
    if (!positiveVersion(input.revision) || typeof input.slideId !== 'string' || input.slideId.length > 80 ||
        input.elementId != null && (typeof input.elementId !== 'string' || !input.elementId || input.elementId.length > 180) ||
        typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000)
      throw fail('슬라이드와 대상을 선택하고 수정 요청을 1~2,000자로 입력해 주세요.');
    return this.store.locked(id, async () => {
      const deck = await this.activeDeck(id);
      if (input.revision !== deck.revision) throw fail('다른 창에서 자료가 변경되었습니다. 최신 자료를 다시 열고 수정 요청을 남겨 주세요.', 409);
      if (!deck.state.order.includes(input.slideId)) throw fail('현재 자료에 없는 슬라이드입니다. 대상을 다시 선택해 주세요.');
      const elementId = input.elementId ?? null;
      if (elementId !== null && (await this.targets(deck)).get(elementId) !== input.slideId)
        throw fail('선택한 개체가 이 슬라이드에 없습니다. 대상을 다시 선택해 주세요.');
      const items = await this.records(id);
      if (items.length >= 500) throw fail('자료마다 수정 요청을 500개까지 보관할 수 있습니다.', 409);
      const now = new Date().toISOString();
      const record = { id: randomUUID(), slideId: input.slideId, elementId, text: input.text.trim(), revision: deck.revision,
        createdAt: now, updatedAt: now, status: 'open', version: 1 };
      items.push(record);
      await this.store.atomic(this.store.path(id, 'feedback.json'), items);
      return record;
    });
  }
  async update(id, feedbackId, input) {
    inputFields(input, ['version', 'status']);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(feedbackId) || !positiveVersion(input.version) || !['open', 'resolved'].includes(input.status))
      throw fail('수정 요청의 버전과 처리 상태를 확인해 주세요.');
    return this.store.locked(id, async () => {
      await this.activeDeck(id);
      const items = await this.records(id), index = items.findIndex(item => item.id === feedbackId);
      if (index < 0) throw fail('수정 요청을 찾을 수 없습니다.', 404);
      if (items[index].version !== input.version) throw fail('다른 창에서 수정 요청의 상태가 변경되었습니다. 목록을 다시 확인해 주세요.', 409);
      const record = { ...items[index], status: input.status, version: input.version + 1, updatedAt: new Date().toISOString() };
      items[index] = record;
      await this.store.atomic(this.store.path(id, 'feedback.json'), items);
      return record;
    });
  }
}
