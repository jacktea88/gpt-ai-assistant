import {
  afterEach, expect, jest, test,
} from '@jest/globals';

const MOCKED_MODULES = [
  '../../../repositories/users.js',
  '../../../repositories/notes.js',
  '../../../services/database.js',
];

let upsertUser;
let createNote;
let listNotes;
let deleteNote;

const load = async ({ enabled = true, databaseConfigured = true } = {}) => {
  jest.resetModules();
  process.env.ENABLE_NOTES = enabled ? 'true' : 'false';
  upsertUser = jest.fn().mockResolvedValue({ id: 'owner-1' });
  createNote = jest.fn().mockResolvedValue({ id: 'n1', content: '整理報稅資料' });
  listNotes = jest.fn().mockResolvedValue([]);
  deleteNote = jest.fn().mockResolvedValue(true);
  jest.doMock('../../../repositories/users.js', () => ({ upsertUser }));
  jest.doMock('../../../repositories/notes.js', () => ({ createNote, listNotes, deleteNote }));
  jest.doMock('../../../services/database.js', () => ({
    isDatabaseConfigured: jest.fn().mockReturnValue(databaseConfigured),
  }));
  const { default: notesHandler } = await import('../../../app/handlers/notes.js');
  return notesHandler;
};

const makeContext = (text) => ({
  userId: 'U-line-id',
  trimmedText: text,
  messages: [],
  hasCommand({ text: commandText, aliases }) {
    const content = text.toLowerCase();
    return [commandText, ...aliases].some((alias) => content.startsWith(alias.toLowerCase()));
  },
  pushText(value, actions = []) { this.messages.push({ type: 'text', text: value, actions }); return this; },
  pushError(err) { this.error = err; return this; },
});

const makeNotes = (count) => Array.from({ length: count }, (_, i) => ({
  id: `n${i + 1}`,
  content: `筆記內容 ${i + 1}`,
}));

afterEach(() => {
  delete process.env.ENABLE_NOTES;
  MOCKED_MODULES.forEach((mod) => jest.dontMock(mod));
  jest.resetModules();
});

test('ignores messages that are not note commands', async () => {
  const handler = await load();
  expect(handler(makeContext('今天天氣好嗎'))).toBe(false);
  expect(upsertUser).not.toHaveBeenCalled();
});

test('replies feature-disabled and touches no data when ENABLE_NOTES is off', async () => {
  const handler = await load({ enabled: false });
  const context = await handler(makeContext('新增筆記 測試'));
  expect(context.messages).toHaveLength(1);
  expect(upsertUser).not.toHaveBeenCalled();
  expect(createNote).not.toHaveBeenCalled();
});

test('replies feature-disabled and touches no data when the database is not configured', async () => {
  const handler = await load({ databaseConfigured: false });
  const context = await handler(makeContext('新增筆記 測試'));
  expect(context.messages).toHaveLength(1);
  expect(upsertUser).not.toHaveBeenCalled();
  expect(createNote).not.toHaveBeenCalled();
});

test('creates a note scoped to the owner and strips the command and trailing punctuation', async () => {
  const handler = await load();
  const context = await handler(makeContext('新增筆記 整理報稅資料。'));
  expect(createNote).toHaveBeenCalledWith('owner-1', '整理報稅資料');
  expect(context.messages[0].text).toContain('已新增筆記');
  expect(context.messages[0].text).toContain('整理報稅資料');
});

test('replies usage and does not create a note when the content is empty', async () => {
  const handler = await load();
  const context = await handler(makeContext('新增筆記'));
  expect(createNote).not.toHaveBeenCalled();
  expect(context.messages[0].text).toContain('請告訴我筆記內容');
});

test('lists an empty state when there are no notes', async () => {
  const handler = await load();
  const context = await handler(makeContext('我的筆記'));
  expect(listNotes).toHaveBeenCalledWith('owner-1', { limit: 11, offset: 0 });
  expect(context.messages[0].text).toContain('目前沒有筆記');
});

test('lists notes with a delete postback per note and no next-page button when they fit one page', async () => {
  const handler = await load();
  listNotes.mockResolvedValue(makeNotes(3));
  const context = await handler(makeContext('我的筆記'));
  const [message] = context.messages;
  expect(message.text).toContain('1. 筆記內容 1');
  expect(message.text).toContain('3. 筆記內容 3');
  expect(message.actions).toHaveLength(3);
  expect(message.actions[0]).toEqual(expect.objectContaining({
    data: '刪筆記 n1',
    displayText: '刪筆記 1',
  }));
});

test('adds a next-page button carrying the offset when more than one page exists', async () => {
  const handler = await load();
  listNotes.mockResolvedValue(makeNotes(11));
  const context = await handler(makeContext('我的筆記'));
  const [message] = context.messages;
  expect(message.text).not.toContain('筆記內容 11');
  expect(message.actions).toHaveLength(11);
  expect(message.actions.at(-1).data).toBe('我的筆記 @10');
});

test('the next-page sentinel is parsed back into an offset and numbering continues', async () => {
  const handler = await load();
  listNotes.mockResolvedValue(makeNotes(2));
  const context = await handler(makeContext('我的筆記 @10'));
  expect(listNotes).toHaveBeenCalledWith('owner-1', { limit: 11, offset: 10 });
  expect(context.messages[0].text).toContain('11. 筆記內容 1');
});

test('deletes a note by id scoped to the owner', async () => {
  const handler = await load();
  const context = await handler(makeContext('刪筆記 n1'));
  expect(deleteNote).toHaveBeenCalledWith('owner-1', 'n1');
  expect(context.messages[0].text).toContain('已刪除筆記');
});

test('replies not-found when the note does not exist or belongs to someone else', async () => {
  const handler = await load();
  deleteNote.mockResolvedValue(false);
  const context = await handler(makeContext('刪筆記 n999'));
  expect(context.messages[0].text).toContain('找不到那筆筆記');
});

test('replies delete usage when no id is given', async () => {
  const handler = await load();
  const context = await handler(makeContext('刪筆記'));
  expect(deleteNote).not.toHaveBeenCalled();
  expect(context.messages[0].text).toContain('請點筆記列表');
});

test('routes repository errors to pushError instead of throwing', async () => {
  const handler = await load();
  const failure = new Error('db down');
  createNote.mockRejectedValue(failure);
  const context = await handler(makeContext('新增筆記 測試'));
  expect(context.error).toBe(failure);
});
