import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';

// Black-box tests against the actual production server, with an isolated database.
const root = resolve('test-results'); mkdirSync(root, { recursive: true });
const folder = mkdtempSync(resolve(root, 'integration-'));
const origin = 'http://127.0.0.1:4328';
let server, logs = '';
async function start() {
  server = spawn(process.execPath, ['dist/server/entry.mjs'], { env: { ...process.env, DATABASE_URL: '', DATABASE_FILE: resolve(folder, 'test.sqlite'), HOST: '127.0.0.1', PORT: '4328' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + '/join', { signal: AbortSignal.timeout(1000) })).status === 200) return; } catch {}
    if (server.exitCode !== null) throw new Error(logs);
    await delay(100);
  }
  throw new Error('Server did not start: ' + logs);
}
async function stop() { if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; } }
async function request(path, cookie, body, extraHeaders = {}) {
  return fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie || '', Origin: origin, Accept: 'application/json', 'Content-Type': 'application/json', ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
}
async function join(nickname) {
  const res = await request('/api/join', '', { nickname }); assert.equal(res.status, 200, await res.clone().text());
  const header = res.headers.get('set-cookie'); assert.match(header, /HttpOnly/i); assert.match(header, /SameSite=Lax/i); assert.match(header, /Max-Age=2592000/i);
  return header.split(';')[0];
}
async function stream(cookie, room = 'lobby') {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/rooms/${room}/stream`, { headers: { Cookie: cookie }, signal: controller.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const events = []; let text = '';
  const reading = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        text += decoder.decode(value, { stream: true });
        let end;
        while ((end = text.indexOf('\n\n')) !== -1) {
          const frame = text.slice(0, end); text = text.slice(end + 2);
          if (frame.startsWith(': heartbeat')) events.push({ event: 'heartbeat', data: {} });
          const event = frame.match(/^event: (.+)$/m)?.[1];
          if (event) events.push({ event, data: JSON.parse(frame.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n')) });
        }
      }
    } catch (e) { if (!controller.signal.aborted && e.name !== 'TypeError') throw e; }
  })();
  const wait = async (event, predicate = () => true, timeout = 5000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const match = events.find(e => e.event === event && predicate(e.data)); if (match) return match.data; await delay(25); }
    throw new Error(`Missing ${event} event: ${JSON.stringify(events).slice(-1500)}\n${logs}`);
  };
  const close = async () => { controller.abort(); await reading; };
  await wait('ready'); return { events, wait, close };
}

test('Commonroom: complete two-session flow, isolation, security, and restart', { timeout: 120000 }, async t => {
  const open = [];
  try {
    await start();
    await t.test('protected routes and unique nicknames', async () => {
      assert.equal((await request('/rooms/lobby')).status, 303);
      assert.equal((await request('/api/notifications', 'chat_user_id=system')).status, 303);
      assert.equal((await request('/api/join', '', { nickname: 'System' })).status, 400);
      assert.equal((await request('/api/join', '', { nickname: '<script>' })).status, 400);
      assert.equal((await request('/api/join', '', { nickname: 'InvalidOrigin' }, { Origin: 'https://evil.example' })).status, 403);
    });
    const alice = await join('Alice'), bob = await join('Bob');
    assert.equal((await request('/api/join', '', { nickname: 'aLiCe' })).status, 409);
    const a = await stream(alice), b = await stream(bob); open.push(a, b);
    let aliceId, bobId;
    await t.test('both users see each other; body identity is ignored', async () => {
      const people = await a.wait('userlist', people => people.length === 2);
      aliceId = people.find(p => p.nickname === 'Alice').id; bobId = people.find(p => p.nickname === 'Bob').id;
      await b.wait('userlist', people => people.length === 2);
      const response = await request('/api/rooms/lobby/messages', alice, { content: 'Hello Bob!\nA second line.', user_id: bobId });
      assert.equal(response.status, 201);
      const { message } = await response.json(); assert.equal(message.user_id, aliceId);
      assert.equal((await b.wait('message', m => m.id === message.id)).content, 'Hello Bob!\nA second line.');
      await request('/api/rooms/lobby/messages', bob, { content: 'Hi Alice!' });
      await a.wait('message', m => m.content === 'Hi Alice!');
    });
    await t.test('typing appears and expires without a stop request', async () => {
      assert.equal((await request('/api/rooms/lobby/typing', bob, {})).status, 204);
      await a.wait('typing', people => people.some(p => p.id === bobId));
      const start = a.events.length; await delay(2300);
      assert.ok(a.events.slice(start).some(e => e.event === 'typing' && e.data.length === 0));
    });
    await t.test('mentions persist, target the right user, and mark read', async () => {
      await request('/api/rooms/lobby/messages', alice, { content: '@bob @Bob please take a look. @Alice' });
      await b.wait('mention', n => n.preview.includes('take a look'));
      let result = await (await request('/api/notifications', bob)).json(); assert.equal(result.count, 1);
      assert.equal((await (await request('/api/notifications', alice)).json()).count, 0);
      await request('/api/notifications/read', bob, { user_id: aliceId });
      assert.equal((await (await request('/api/notifications', bob)).json()).count, 0);
      await request('/api/rooms/lobby/messages', alice, { content: '@everyone hello!' });
      assert.equal((await (await request('/api/notifications', bob)).json()).count, 1);
    });
    let otherRoom;
    await t.test('room creation broadcasts and messages stay in their room', async () => {
      const res = await request('/api/rooms', alice, { name: 'The creative corner', description: 'Ideas live here.' });
      assert.equal(res.status, 200); otherRoom = (await res.json()).room;
      await b.wait('newroom', r => r.id === otherRoom.id);
      const c = await stream(bob, otherRoom.id); open.push(c);
      const res2 = await request(`/api/rooms/${otherRoom.id}/messages`, bob, { content: 'A private-to-this-room thought.' });
      const { message } = await res2.json(); await c.wait('message', m => m.id === message.id); await delay(100);
      assert.ok(!a.events.some(e => e.event === 'message' && e.data.id === message.id));
      assert.ok(!b.events.some(e => e.event === 'message' && e.data.id === message.id));
      await c.close();
    });
    await t.test('rename broadcasts, rejects reserved/duplicate names, and updates sender', async () => {
      assert.equal((await request('/api/rename', bob, { nickname: 'Alice' })).status, 409);
      assert.equal((await request('/api/rename', bob, { nickname: 'everyone' })).status, 400);
      assert.equal((await request('/api/rename', bob, { nickname: 'Bobby' })).status, 200);
      await a.wait('message', m => m.type === 'rename' && m.content.includes('Bobby'));
      await a.wait('userlist', people => people.some(p => p.nickname === 'Bobby'));
      await request('/api/rooms/lobby/messages', bob, { content: 'New name, same person.' });
      assert.equal((await a.wait('message', m => m.content === 'New name, same person.')).nickname, 'Bobby');
    });
    await t.test('refresh keeps identity and cancels the departure timer', async () => {
      await b.close(); const refreshed = await stream(bob); open.push(refreshed);
      assert.equal((await refreshed.wait('ready')).user.nickname, 'Bobby');
      const rows = (await (await request('/api/rooms/lobby/history', bob)).json()).messages;
      assert.ok(rows.some(m => m.content === 'Hi Alice!'));
      assert.equal(rows.filter(m => m.type === 'join' && m.content.startsWith('Bob joined')).length, 1);
      await refreshed.close();
    });
    await t.test('heartbeat arrives; disconnect leaves after the full 60-second grace', async () => {
      const began = Date.now();
      await a.wait('heartbeat', () => true, 35000);
      const left = await a.wait('message', m => m.type === 'leave' && m.content === 'Bobby left the room', 65000);
      assert.ok(left); assert.ok(Date.now() - began >= 59000, 'Grace should be 60 seconds');
    });
    await t.test('pagination has no gaps, including timestamp ties', async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const seed = new DatabaseSync(resolve(folder, 'test.sqlite'));
      const insert = seed.prepare('INSERT INTO messages (id,room_id,user_id,content,type,created_at) VALUES (?,?,?,?,?,?)');
      for (let i = 0; i < 75; i++) insert.run(`tie-${String(i).padStart(3, '0')}`, 'lobby', aliceId, `pagination ${i}`, 'message', '2025-01-01T00:00:00.000Z');
      seed.close();
      let cursor = '', ids = [], hasMore = true;
      while (hasMore) { const data = await (await request(`/api/rooms/lobby/history${cursor}`, alice)).json(); ids.push(...data.messages.map(m => m.id)); hasMore = data.hasMore; const first = data.messages[0]; cursor = `?before=${encodeURIComponent(first.created_at)}&before_id=${encodeURIComponent(first.id)}`; }
      assert.equal(new Set(ids).size, ids.length); assert.equal(ids.filter(id => id.startsWith('tie-')).length, 75);
    });
    await t.test('a real server restart preserves users, rooms, messages, and notifications', async () => {
      await a.close(); await stop(); await start();
      const resumed = await stream(bob); open.push(resumed);
      assert.equal((await resumed.wait('ready')).user.nickname, 'Bobby');
      assert.equal((await resumed.wait('ready')).counts.lobby, 1);
      const saved = await (await request('/api/rooms/lobby/history', bob)).json(); assert.ok(saved.messages.some(m => m.content === 'New name, same person.'));
      assert.equal((await (await request('/api/notifications', bob)).json()).count, 1);
      assert.equal((await request(`/api/rooms/${otherRoom.id}/history`, bob)).status, 200);
      await request('/api/rooms/lobby/messages', alice, { content: 'Back after the restart.' }); await resumed.wait('message', m => m.content === 'Back after the restart.');
      const res = await request('/api/leave', bob, {}); assert.equal(res.status, 200); assert.match(res.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
    });
  } finally { for (const s of open) await s.close().catch(() => {}); await stop(); }
});
