import { EventEmitter } from 'node:events';
import { saveMessage } from './db.mjs';

function createHub() {
  const emitter = new EventEmitter(); emitter.setMaxListeners(0);
  const presence = new Map();
  const typing = new Map();
  const connections = new Map();
  const grace = Number(process.env.CHAT_GRACE_MS || 60000);
  const broadcast = (room, event, data, target) => emitter.emit(room, { event, data, target });
  const all = (event, data, target) => { for (const room of presence.keys()) broadcast(room, event, data, target); broadcast('__directory', event, data, target); };
  const list = room => [...(presence.get(room)?.values() || [])].map(p => ({ id: p.user.id, nickname: p.user.nickname, color: p.user.color }));
  const counts = () => Object.fromEntries([...presence].map(([room, people]) => [room, people.size]));
  function presenceChanged(room) {
    broadcast(room, 'userlist', list(room));
    all('presence', { room_id: room, count: list(room).length, counts: counts() });
  }
  async function system(room, user, type, content) {
    try { const { message } = await saveMessage(room, user, content, type); broadcast(room, 'message', message); }
    catch (error) { console.error('System event failed:', error); }
  }
  function typingChanged(room) {
    const people = [...(typing.get(room)?.values() || [])].map(t => t.user);
    broadcast(room, 'typing', people);
  }
  function clearTyping(room, userId) {
    const entry = typing.get(room)?.get(userId);
    if (entry) { clearTimeout(entry.timer); typing.get(room).delete(userId); typingChanged(room); }
  }
  function setTyping(room, user, active = true) {
    if (!active) return clearTyping(room, user.id);
    if (!typing.has(room)) typing.set(room, new Map());
    const entries = typing.get(room);
    clearTimeout(entries.get(user.id)?.timer);
    entries.set(user.id, { user: { id: user.id, nickname: user.nickname }, timer: setTimeout(() => clearTyping(room, user.id), 2000) });
    typingChanged(room);
  }
  function connect(room, user, token, close) {
    if (!presence.has(room)) presence.set(room, new Map());
    const people = presence.get(room);
    let person = people.get(user.id);
    if (!person) {
      person = { user, tokens: new Set(), timer: null }; people.set(user.id, person);
      void system(room, user, 'join', `${user.nickname} joined the room`);
    }
    clearTimeout(person.timer); person.timer = null; person.user = user; person.tokens.add(token);
    connections.set(token, { room, userId: user.id, close });
    presenceChanged(room);
  }
  function remove(room, userId) {
    const person = presence.get(room)?.get(userId);
    if (!person) return;
    clearTimeout(person.timer); clearTyping(room, userId);
    presence.get(room).delete(userId);
    presenceChanged(room);
    void system(room, person.user, 'leave', `${person.user.nickname} left the room`);
  }
  function disconnect(token) {
    const connection = connections.get(token); if (!connection) return;
    connections.delete(token);
    const person = presence.get(connection.room)?.get(connection.userId);
    person?.tokens.delete(token);
    if (person && !person.tokens.size) {
      clearTyping(connection.room, connection.userId);
      person.timer = setTimeout(() => remove(connection.room, connection.userId), grace);
    }
  }
  function leave(userId) {
    for (const [token, c] of connections) if (c.userId === userId) { c.close(); disconnect(token); }
    for (const [room, people] of presence) if (people.has(userId)) remove(room, userId);
  }
  async function rename(user, oldName, rooms) {
    for (const [room, people] of presence) {
      if (people.has(user.id)) { people.get(user.id).user = user; presenceChanged(room); }
      if (typing.get(room)?.has(user.id)) clearTyping(room, user.id);
    }
    all('identity', user, user.id);
    for (const room of rooms) await system(room.id, user, 'rename', `${oldName} is now known as ${user.nickname}`);
  }
  return { emitter, broadcast, all, list, counts, connect, disconnect, leave, rename, setTyping, clearTyping };
}
export const live = globalThis.__commonroomLive ??= createHub();
export function sseFrame(event, data) {
  return `event: ${event}\n${JSON.stringify(data).split('\n').map(line => `data: ${line}`).join('\n')}\n\n`;
}
