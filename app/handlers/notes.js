import config from '../../config/index.js';
import { t } from '../../locales/index.js';
import {
  createNote,
  deleteNote,
  listNotes,
} from '../../repositories/notes.js';
import { upsertUser } from '../../repositories/users.js';
import { isDatabaseConfigured } from '../../services/database.js';
import {
  COMMAND_BOT_NOTE,
  COMMAND_BOT_NOTE_DELETE,
  COMMAND_BOT_NOTE_LIST,
} from '../commands/index.js';

const PAGE_SIZE = 10;

const NOTE_COMMANDS = [
  COMMAND_BOT_NOTE_LIST,
  COMMAND_BOT_NOTE_DELETE,
  COMMAND_BOT_NOTE,
];

/**
 * @param {import('../context.js').default} context
 * @returns {boolean}
 */
const check = (context) => NOTE_COMMANDS.some((command) => context.hasCommand(command));

const stripCommand = (text, command) => {
  const lower = text.toLowerCase();
  const prefix = [command.text, ...command.aliases]
    .find((alias) => lower.startsWith(alias.toLowerCase()));
  return (prefix ? text.slice(prefix.length) : text).trim();
};

const stripTrailingMarks = (text) => text.replace(/[。！？.!?]+$/u, '').trim();

const compactText = (text) => text.replace(/\s+/g, ' ').trim();

const previewNote = (content, maxLength = 60) => {
  const compact = compactText(content);
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
};

const parseListArg = (raw) => {
  const [_, offsetPart] = stripTrailingMarks(raw).split('@');
  const offset = Number.isInteger(Number(offsetPart)) && Number(offsetPart) > 0 ? Number(offsetPart) : 0;
  return { offset };
};

const createNewNote = async (context, owner) => {
  const content = stripTrailingMarks(stripCommand(context.trimmedText, COMMAND_BOT_NOTE));
  if (!content) {
    context.pushText(t('__TEXT_NOTE_USAGE'));
    return context;
  }
  const note = await createNote(owner.id, content);
  context.pushText(`${t('__TEXT_NOTE_CREATED')}\n${previewNote(note.content, 120)}`);
  return context;
};

const listNotesView = async (context, owner) => {
  const rawArg = stripCommand(context.trimmedText, COMMAND_BOT_NOTE_LIST);
  const { offset } = parseListArg(rawArg);
  const rows = await listNotes(owner.id, { limit: PAGE_SIZE + 1, offset });
  const hasMore = rows.length > PAGE_SIZE;
  const notes = rows.slice(0, PAGE_SIZE);
  if (notes.length === 0) {
    context.pushText(t('__TEXT_NOTE_LIST_EMPTY'));
    return context;
  }

  const body = notes
    .map((note, index) => `${offset + index + 1}. ${previewNote(note.content)}`)
    .join('\n');
  const actions = notes.map((note, index) => ({
    label: `${t('__LABEL_NOTE_DELETE')} ${index + 1}`,
    data: `${COMMAND_BOT_NOTE_DELETE.text} ${note.id}`,
    displayText: `${COMMAND_BOT_NOTE_DELETE.text} ${index + 1}`,
  }));
  if (hasMore) {
    const filterArg = rawArg.split('@')[0].trim();
    actions.push({
      label: t('__LABEL_NOTE_NEXT_PAGE'),
      data: `${COMMAND_BOT_NOTE_LIST.text} ${filterArg}@${offset + PAGE_SIZE}`,
      displayText: t('__LABEL_NOTE_NEXT_PAGE'),
    });
  }
  context.pushText(`${t('__TEXT_NOTE_LIST_HEADER')}\n${body}`, actions);
  return context;
};

const removeNote = async (context, owner) => {
  const id = stripTrailingMarks(stripCommand(context.trimmedText, COMMAND_BOT_NOTE_DELETE));
  if (!id) {
    context.pushText(t('__TEXT_NOTE_DELETE_USAGE'));
    return context;
  }
  const removed = await deleteNote(owner.id, id);
  context.pushText(removed ? t('__TEXT_NOTE_DELETED') : t('__TEXT_NOTE_NOTFOUND'));
  return context;
};

/**
 * @param {import('../context.js').default} context
 * @returns {false|Promise<import('../context.js').default>}
 */
const exec = (context) => check(context) && (
  async () => {
    if (!config.ENABLE_NOTES || !isDatabaseConfigured()) {
      context.pushText(t('__ERROR_FEATURE_DISABLED'));
      return context;
    }
    try {
      const owner = await upsertUser({ channelUserKey: context.userId });
      if (context.hasCommand(COMMAND_BOT_NOTE_LIST)) return await listNotesView(context, owner);
      if (context.hasCommand(COMMAND_BOT_NOTE_DELETE)) return await removeNote(context, owner);
      return await createNewNote(context, owner);
    } catch (err) {
      context.pushError(err);
    }
    return context;
  }
)();

export default exec;
