import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle as sqliteDrizzle } from 'drizzle-orm/sqlite-proxy';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import { sqliteTable, text as sqliteText, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, boolean } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { and, eq, lt, or, desc, asc, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

const postgres = !!process.env.DATABASE_URL;
const table = postgres ? pgTable : sqliteTable;
const text = postgres ? pgText : sqliteText;
export const users = table('users', {
  id: text('id').primaryKey(), nickname: text('nickname').notNull().unique(),
  color: text('color').notNull(), created_at: text('created_at').notNull()
});
export const rooms = table('rooms', {
  id: text('id').primaryKey(), name: text('name').notNull(), description: text('description'),
  created_by: text('created_by').references(() => users.id), created_at: text('created_at').notNull()
});
export const messages = table('messages', {
  id: text('id').primaryKey(), room_id: text('room_id').notNull().references(() => rooms.id),
  user_id: text('user_id').references(() => users.id), content: text('content').notNull(),
  type: text('type').notNull(), created_at: text('created_at').notNull()
});
export const notifications = table('notifications', {
  id: text('id').primaryKey(), user_id: text('user_id').notNull().references(() => users.id),
  from_user_id: text('from_user_id').notNull().references(() => users.id),
  room_id: text('room_id').notNull().references(() => rooms.id),
  message_id: text('message_id').notNull().references(() => messages.id), preview: text('preview').notNull(),
  read: (postgres ? boolean('read') : integer('read', { mode: 'boolean' })).notNull().default(false),
  created_at: text('created_at').notNull()
});
const now = () => new Date().toISOString();

async function initialize() {
  let raw, db;
  if (postgres) {
    raw = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    db = pgDrizzle(raw);
  } else {
    const file = resolve(process.env.DATABASE_FILE || './data/commonroom.sqlite');
    mkdirSync(dirname(file), { recursive: true });
    raw = new DatabaseSync(file);
    raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    db = sqliteDrizzle(async (query, params, method) => {
      const stmt = raw.prepare(query);
      if (method === 'run') { stmt.run(...params); return { rows: [] }; }
      stmt.setReturnArrays(true);
      return { rows: method === 'get' ? stmt.get(...params) : stmt.all(...params) };
    });
  }
  const ddl = `
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, nickname TEXT NOT NULL UNIQUE, color TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS users_nickname_case_idx ON users (lower(nickname));
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), user_id TEXT REFERENCES users(id), content TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('message','join','leave','rename')), created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_room_time_idx ON messages(room_id, created_at);
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), from_user_id TEXT NOT NULL REFERENCES users(id), room_id TEXT NOT NULL REFERENCES rooms(id), message_id TEXT NOT NULL REFERENCES messages(id), preview TEXT NOT NULL, read ${postgres ? 'BOOLEAN' : 'INTEGER'} NOT NULL DEFAULT ${postgres ? 'FALSE' : '0'}, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, read, created_at);
  `;
  if (postgres) await raw.query(ddl); else raw.exec(ddl);
  await db.insert(users).values({ id: 'system', nickname: 'System', color: '#666666', created_at: now() }).onConflictDoNothing();
  await db.insert(rooms).values({ id: 'lobby', name: 'Lobby', description: 'The default room', created_by: 'system', created_at: now() }).onConflictDoNothing();
  return { db, raw };
}
const state = await (globalThis.__commonroomDB ??= initialize());
export const db = state.db;
let writes = Promise.resolve();
// Serialize writes locally, and make message + notifications one atomic operation.
export function transaction(fn) {
  const result = writes.then(async () => {
    if (postgres) return db.transaction(fn);
    state.raw.exec('BEGIN IMMEDIATE');
    try { const result = await fn(db); state.raw.exec('COMMIT'); return result; }
    catch (error) { state.raw.exec('ROLLBACK'); throw error; }
  });
  writes = result.catch(() => {});
  return result;
}
export async function findUser(id) { return (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]; }
export async function findRoom(id) { return (await db.select().from(rooms).where(eq(rooms.id, id)).limit(1))[0]; }
export function listRooms() { return db.select().from(rooms).orderBy(asc(rooms.created_at)); }
export function validNickname(value) { return typeof value === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_-]{1,23}$/.test(value) && !['system','everyone'].includes(value.toLowerCase()); }
export async function createUser(nickname) {
  if (!validNickname(nickname)) throw new Error('Use 2–24 letters, numbers, underscores or hyphens. System and everyone are reserved.');
  const palette = ['#8b5cf6','#e05c9a','#299c90','#d68a35','#5279cf','#b16bc6'];
  const user = { id: nanoid(32), nickname, color: palette[Math.floor(Math.random() * palette.length)], created_at: now() };
  await transaction(tx => tx.insert(users).values(user)); return user;
}
export async function renameUser(id, nickname) {
  if (!validNickname(nickname)) throw new Error('Use 2–24 letters, numbers, underscores or hyphens. System and everyone are reserved.');
  await transaction(tx => tx.update(users).set({ nickname }).where(eq(users.id, id)));
  return findUser(id);
}
export async function createRoom(user, name, description) {
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 40) throw new Error('Room names must be 2–40 characters.');
  if (typeof description !== 'string' || description.length > 160) throw new Error('Keep the description under 160 characters.');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'room';
  const room = { id: `${slug}-${nanoid(5).toLowerCase()}`, name: name.trim(), description: description.trim(), created_by: user.id, created_at: now() };
  await transaction(tx => tx.insert(rooms).values(room)); return room;
}
const projection = { id: messages.id, room_id: messages.room_id, user_id: messages.user_id, content: messages.content, type: messages.type, created_at: messages.created_at, nickname: users.nickname, color: users.color };
const idOrder = sql`${messages.id} COLLATE ${sql.raw(postgres ? '"C"' : 'BINARY')}`;
export async function history(roomId, before, beforeId) {
  let condition = eq(messages.room_id, roomId);
  if (before) condition = and(condition, beforeId ? or(lt(messages.created_at, before), and(eq(messages.created_at, before), lt(idOrder, beforeId))) : lt(messages.created_at, before));
  const rows = await db.select(projection).from(messages).leftJoin(users, eq(messages.user_id, users.id)).where(condition).orderBy(desc(messages.created_at), desc(idOrder)).limit(51);
  const hasMore = rows.length > 50;
  return { messages: rows.slice(0, 50).reverse(), hasMore };
}
export async function saveMessage(roomId, user, content, type = 'message') {
  if (typeof content !== 'string' || !content.trim() || content.length > 4000) throw new Error('Messages must contain 1–4,000 characters.');
  const message = { id: nanoid(), room_id: roomId, user_id: type === 'message' ? user.id : null, content: content.trim(), type, created_at: now() };
  const notices = [];
  await transaction(async tx => {
    await tx.insert(messages).values(message);
    if (type !== 'message') return;
    const mentions = new Set([...content.matchAll(/(?:^|[^a-zA-Z0-9_@-])@([a-zA-Z0-9_][a-zA-Z0-9_-]*)(?![a-zA-Z0-9_-])/g)].map(m => m[1].toLowerCase()));
    if (!mentions.size) return;
    const all = await tx.select().from(users);
    for (const target of all) {
      if (target.id === 'system' || target.id === user.id || (!mentions.has('everyone') && !mentions.has(target.nickname.toLowerCase()))) continue;
      notices.push({ id: nanoid(), user_id: target.id, from_user_id: user.id, room_id: roomId, message_id: message.id, preview: message.content.slice(0, 180), read: false, created_at: message.created_at });
    }
    if (notices.length) await tx.insert(notifications).values(notices);
  });
  return { message: { ...message, nickname: type === 'message' ? user.nickname : null, color: user.color }, notices };
}
export async function unread(userId) {
  const rows = await db.select({ id: notifications.id, room_id: notifications.room_id, message_id: notifications.message_id, preview: notifications.preview, created_at: notifications.created_at, nickname: users.nickname, room_name: rooms.name }).from(notifications)
    .innerJoin(users, eq(users.id, notifications.from_user_id)).innerJoin(rooms, eq(rooms.id, notifications.room_id))
    .where(and(eq(notifications.user_id, userId), eq(notifications.read, false))).orderBy(desc(notifications.created_at)).limit(100);
  const [count] = await db.select({ count: sql`count(*)` }).from(notifications).where(and(eq(notifications.user_id, userId), eq(notifications.read, false)));
  return { notifications: rows, count: Number(count.count) };
}
export async function markRead(userId) { await transaction(tx => tx.update(notifications).set({ read: true }).where(eq(notifications.user_id, userId))); }
