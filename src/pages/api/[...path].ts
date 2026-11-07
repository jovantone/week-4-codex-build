import type { APIRoute } from 'astro';
import { nanoid } from 'nanoid';
import { createUser, renameUser, createRoom, findRoom, findUser, listRooms, saveMessage, history, unread, markRead } from '../../lib/db.mjs';
import { live, sseFrame } from '../../lib/live.mjs';

const limits = (globalThis as any).__chatLimits ??= new Map();
function throttle(key: string, max: number, window = 60000) {
  const now = Date.now();
  for (const [k, v] of limits) if (v.until < now) limits.delete(k);
  const item = limits.get(key) || { count: 0, until: now + window };
  if (++item.count > max) throw Object.assign(new Error('A little too fast. Please try again shortly.'), { status: 429 });
  limits.set(key, item);
}
const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
export const ALL: APIRoute = async (ctx) => {
  const { request, params, cookies, locals, url, redirect } = ctx;
  const path = params.path || '';
  const method = request.method;
  const user = locals.user;
  try {
    if (method === 'POST') {
      if (Number(request.headers.get('content-length')) > 20000) return json({ error: 'Request is too large.' }, 413);
      const input = await request.text();
      if (input.length > 20000) return json({ error: 'Request is too large.' }, 413);
      const data = request.headers.get('content-type')?.includes('application/json') ? JSON.parse(input) : Object.fromEntries(new URLSearchParams(input));
      const wantsJSON = request.headers.get('accept')?.includes('application/json');
      const done = (location: string, payload = {}) => wantsJSON ? json({ ...payload, redirect: location }) : request.headers.has('hx-request') ? new Response(null, { headers: { 'HX-Redirect': location } }) : redirect(location, 303);
      if (path === 'join') {
        if (user) return done('/rooms/lobby');
        throttle(`join:${request.headers.get('x-forwarded-for') || ctx.clientAddress}`, 20);
        const person = await createUser(data.nickname?.trim());
        cookies.set('chat_user_id', person.id, { httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', path: '/', maxAge: 60 * 60 * 24 * 30 });
        return done('/rooms/lobby');
      }
      if (!user) return redirect('/join', 303);
      // Resolve identity again: long-lived connections cannot authorize a stale nickname or body ID.
      const actor = await findUser(user.id);
      if (path === 'leave') {
        live.leave(user.id); cookies.delete('chat_user_id', { path: '/' }); return done('/join');
      }
      if (path === 'rename') {
        throttle(`rename:${user.id}`, 10);
        const updated = await renameUser(user.id, data.nickname?.trim());
        await live.rename(updated, actor.nickname, await listRooms()); return json({ user: updated });
      }
      if (path === 'rooms') {
        throttle(`rooms:${user.id}`, 10);
        const room = await createRoom(actor, data.name, data.description || '');
        live.all('newroom', room); return done(`/rooms/${room.id}`, { room });
      }
      if (path === 'notifications/read') { await markRead(user.id); live.all('notifications-read', {}, user.id); return json({ ok: true }); }
      const match = path.match(/^rooms\/([^/]+)\/(messages|typing)$/);
      if (match) {
        const [, roomId, action] = match;
        if (!await findRoom(roomId)) return json({ error: 'Room not found.' }, 404);
        if (action === 'typing') { throttle(`typing:${user.id}`, 180); live.setTyping(roomId, actor, data.active !== false); return new Response(null, { status: 204 }); }
        throttle(`message:${user.id}`, 60);
        const { message, notices } = await saveMessage(roomId, actor, data.content);
        live.clearTyping(roomId, user.id);
        live.broadcast(roomId, 'message', message);
        for (const notice of notices) live.all('mention', { ...notice, nickname: actor.nickname }, notice.user_id);
        return json({ message }, 201);
      }
    }
    if (method === 'GET' && path === 'notifications') return json(await unread(user!.id));
    if (method === 'GET' && path === 'rooms') return json({ rooms: await listRooms(), counts: live.counts() });
    const directory = path === 'directory/stream';
    const match = directory ? [path, '__directory', 'stream'] : path.match(/^rooms\/([^/]+)\/(history|stream)$/);
    if (method === 'GET' && match) {
      const [, roomId, action] = match;
      if (!directory && !await findRoom(roomId)) return json({ error: 'Room not found.' }, 404);
      if (action === 'history') {
        const before = url.searchParams.get('before');
        if (before && Number.isNaN(Date.parse(before))) return json({ error: 'Invalid history cursor.' }, 400);
        return json(await history(roomId, before, url.searchParams.get('before_id')));
      }
      const token = nanoid();
      let cleanup = () => {};
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          let closed = false;
          let timer: ReturnType<typeof setInterval>;
          const send = (event: string, data: any) => {
            if (closed) return;
            try { controller.enqueue(encoder.encode(sseFrame(event, data))); } catch { cleanup(); }
          };
          const listener = (item: any) => { if (!item.target || item.target === user!.id) send(item.event, item.data); };
          cleanup = () => {
            if (closed) return; closed = true;
            clearInterval(timer); live.emitter.off(roomId, listener); live.disconnect(token);
            request.signal.removeEventListener('abort', cleanup);
            try { controller.close(); } catch {}
          };
          controller.enqueue(encoder.encode('retry: 2000\n\n'));
          live.emitter.on(roomId, listener);
          if (!directory) live.connect(roomId, user, token, cleanup);
          send('ready', { user, counts: live.counts() });
          if (!directory) send('userlist', live.list(roomId));
          // Every reconnect catches up from the database, including a server restart.
          send('sync', {});
          timer = setInterval(() => {
            if (!closed) try { controller.enqueue(encoder.encode(': heartbeat\n\n')); } catch { cleanup(); }
          }, 30000);
          request.signal.addEventListener('abort', cleanup, { once: true });
          if (request.signal.aborted) cleanup();
        },
        cancel() { cleanup(); }
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
    }
    return json({ error: 'Route not found.' }, 404);
  } catch (error: any) {
    const duplicate = /unique|duplicate/i.test(error.message + String(error.cause?.message || ''));
    const message = duplicate ? 'That nickname is already taken. Pick another one.' : error.status ? error.message : /Messages must|Use 2|Room names|description/.test(error.message) ? error.message : 'Something went wrong. Please try again.';
    if (message.startsWith('Something')) console.error(error);
    if (path === 'join' && !request.headers.has('hx-request') && !request.headers.get('accept')?.includes('application/json')) return redirect(`/join?error=${encodeURIComponent(message)}`, 303);
    return json({ error: message }, duplicate ? 409 : error.status || 400);
  }
};
