import { query } from '../services/database.js';

/**
 * @param {string} ownerId
 * @param {string} content
 * @returns {Promise<Object>}
 */
export const createNote = async (ownerId, content) => {
  const result = await query(
    `INSERT INTO notes (owner_id, content)
     VALUES ($1, $2)
     RETURNING *`,
    [ownerId, content],
  );
  return result.rows[0];
};

/**
 * @param {string} ownerId
 * @param {{ limit?: number, offset?: number }} [opts]
 * @returns {Promise<Array<Object>>}
 */
export const listNotes = async (ownerId, { limit = 11, offset = 0 } = {}) => {
  const result = await query(
    `SELECT * FROM notes
     WHERE owner_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [ownerId, limit, offset],
  );
  return result.rows;
};

/**
 * @param {string} ownerId
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export const deleteNote = async (ownerId, id) => {
  const result = await query(
    'DELETE FROM notes WHERE id = $1 AND owner_id = $2',
    [id, ownerId],
  );
  return result.rowCount > 0;
};

export default {
  createNote,
  listNotes,
  deleteNote,
};
