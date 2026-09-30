import {
  afterEach, expect, jest, test,
} from '@jest/globals';

const ORIGINAL_ENABLE_NOTES = process.env.ENABLE_NOTES;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const loadApp = async (env) => {
  jest.resetModules();
  Object.entries(env).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  const { handleEvents } = await import('../app/index.js');
  const {
    COMMAND_BOT_NOTE,
    COMMAND_SYS_COMMAND,
  } = await import('../app/commands/index.js');
  const { createEvents, TEST_HANDLE_OPTIONS } = await import('./utils.js');
  return {
    handleEvents,
    COMMAND_BOT_NOTE,
    COMMAND_SYS_COMMAND,
    createEvents,
    TEST_HANDLE_OPTIONS,
  };
};

afterEach(() => {
  if (ORIGINAL_ENABLE_NOTES === undefined) delete process.env.ENABLE_NOTES;
  else process.env.ENABLE_NOTES = ORIGINAL_ENABLE_NOTES;
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  jest.resetModules();
});

test('note command replies disabled notice when ENABLE_NOTES=true but database is not configured', async () => {
  const {
    handleEvents, COMMAND_BOT_NOTE, createEvents, TEST_HANDLE_OPTIONS,
  } = await loadApp({ ENABLE_NOTES: 'true', DATABASE_URL: undefined });

  const results = await handleEvents(
    createEvents([`${COMMAND_BOT_NOTE.text} 測試筆記`]),
    TEST_HANDLE_OPTIONS,
  );

  expect(results).toHaveLength(1);
  expect(results[0].messages[0].text).toContain('此功能目前已停用');
}, 9000);

test('command help includes notes section when ENABLE_NOTES=true', async () => {
  const {
    handleEvents, COMMAND_SYS_COMMAND, createEvents, TEST_HANDLE_OPTIONS,
  } = await loadApp({ ENABLE_NOTES: 'true' });

  const results = await handleEvents(
    createEvents([COMMAND_SYS_COMMAND.text]),
    TEST_HANDLE_OPTIONS,
  );

  expect(results).toHaveLength(1);
  expect(results[0].messages[0].text).toContain('【筆記】');
}, 9000);
