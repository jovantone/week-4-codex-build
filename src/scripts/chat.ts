export {};
import { compareMessages } from '../lib/order.mjs';
// The room protocol carries JSON. Rendering uses text nodes throughout.
const state = JSON.parse(document.getElementById('initial-state')!.textContent!);
let me = state.user;
const room = state.room;
const $ = (id: string) => document.getElementById(id)!;
const hide = (el: HTMLElement, value = true) => { el.hidden = value; };
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4000); }
async function api(path: string, data?: any) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
  if (response.redirected && new URL(response.url).pathname === '/join') { location.href = '/join'; throw new Error('Please rejoin the conversation.'); }
  if (response.status === 204) return {};
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not complete that request. Try again.');
  return result;
}
document.querySelectorAll<HTMLElement>('[data-open]').forEach(button => button.addEventListener('click', () => ($((button.dataset.open!)) as HTMLDialogElement).showModal()));
document.querySelectorAll<HTMLElement>('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog')!.close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) { const box = dialog.getBoundingClientRect(); const mouse = e as MouseEvent; if (mouse.clientX < box.left || mouse.clientX > box.right || mouse.clientY < box.top || mouse.clientY > box.bottom) dialog.close(); } }));
for (const [formId, endpoint] of [['new-room-form', '/api/rooms'], ['rename-form', '/api/rename']]) {
  $(formId).addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target as HTMLFormElement;
    const button = form.querySelector<HTMLButtonElement>('[type="submit"]')!; const error = form.querySelector<HTMLElement>('.form-error')!;
    button.disabled = true; error.textContent = '';
    try {
      const result = await api(endpoint, Object.fromEntries(new FormData(form)));
      if (result.redirect) location.href = result.redirect;
      else { updateIdentity(result.user); form.closest('dialog')!.close(); toast('A fresh name. Same good company.'); }
    } catch (e: any) { error.textContent = e.message; }
    finally { button.disabled = false; }
  });
}
function updateIdentity(user: any) {
  me = user;
  document.querySelectorAll('.own-name').forEach(el => el.textContent = user.nickname);
  document.querySelectorAll<HTMLElement>('.own-avatar').forEach(el => { el.textContent = user.nickname.slice(0, 2).toUpperCase(); el.style.setProperty('--avatar', user.color); });
  ($('new-nickname') as HTMLInputElement).value = user.nickname;
}
$('theme-toggle').addEventListener('click', () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('commonroom-theme', theme); } catch {} });
let sound = false;
try { sound = localStorage.getItem('commonroom-sound') === 'true'; } catch {}
let audio: AudioContext;
function soundUI() { hide($('sound-on'), !sound); hide($('sound-off'), sound); $('sound-toggle').setAttribute('aria-pressed', String(sound)); $('sound-toggle').setAttribute('aria-label', sound ? 'Mute notification sounds' : 'Enable notification sounds'); $('sound-toggle').title = sound ? 'Mute notification sounds' : 'Enable notification sounds'; }
function play(mention = false) {
  if (!sound) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') return;
    [mention ? 660 : 440, mention ? 880 : 550].forEach((frequency, i) => {
      const oscillator = audio.createOscillator(), gain = audio.createGain();
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      const t = audio.currentTime + i * .11; gain.gain.setValueAtTime(.035, t); gain.gain.exponentialRampToValueAtTime(.001, t + .17); oscillator.start(t); oscillator.stop(t + .18);
    });
  } catch {}
}
$('sound-toggle').addEventListener('click', async () => { sound = !sound; if (sound) { audio ??= new AudioContext(); await audio.resume(); } try { localStorage.setItem('commonroom-sound', String(sound)); } catch {} soundUI(); play(); });
document.addEventListener('pointerdown', () => { if (sound) { audio ??= new AudioContext(); void audio.resume(); } }, { once: true });
soundUI();

let notices: any[] = [];
async function loadNotices() {
  try {
    const data = await api('/api/notifications'); notices = data.notifications;
    $('notification-badge').textContent = data.count > 99 ? '99+' : String(data.count); hide($('notification-badge'), !data.count);
    $('notification-list').replaceChildren();
    if (!notices.length) { const p = document.createElement('p'); p.className = 'notification-empty'; p.textContent = 'All caught up. Nice and quiet.'; $('notification-list').append(p); }
    for (const n of notices) {
      const link = document.createElement('a'); link.href = `/rooms/${n.room_id}#message-${n.message_id}`; link.className = 'notification-item';
      const title = document.createElement('strong'); title.textContent = `${n.nickname} in #${n.room_name}`;
      const preview = document.createElement('span'); preview.textContent = n.preview;
      const time = document.createElement('small'); time.textContent = new Date(n.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      link.append(title, preview, time); $('notification-list').append(link);
      if (n.room_id === room?.id) link.addEventListener('click', () => { void revealMessage(n.message_id); hide($('notification-panel')); $('notification-toggle').setAttribute('aria-expanded', 'false'); });
    }
  } catch (e: any) { toast(e.message); }
}
$('notification-toggle').addEventListener('click', () => { const isHidden = !$('notification-panel').hidden; hide($('notification-panel'), isHidden); $('notification-toggle').setAttribute('aria-expanded', String(!isHidden)); if (!isHidden) void loadNotices(); });
$('read-notifications').addEventListener('click', async () => { try { await api('/api/notifications/read', {}); await loadNotices(); } catch (e: any) { toast(e.message); } });
document.addEventListener('click', e => { if (!(e.target as HTMLElement).closest('.notification-wrap')) { hide($('notification-panel')); $('notification-toggle').setAttribute('aria-expanded', 'false'); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hide($('notification-panel')); });
void loadNotices();
function addRoom(r: any) {
  if (document.querySelector(`[data-room-link="${CSS.escape(r.id)}"]`)) return;
  const a = document.createElement('a'); a.href = `/rooms/${r.id}`; a.className = 'room-link'; a.dataset.roomLink = r.id;
  const hash = document.createElement('span'); hash.className = 'room-hash'; hash.textContent = '#';
  const name = document.createElement('span'); name.className = 'room-link-name'; name.textContent = r.name;
  const count = document.createElement('span'); count.className = 'room-count'; count.dataset.count = r.id;
  a.append(hash, name, count); $('room-nav').append(a);
  if (!room) {
    const card = document.createElement('a'); card.className = 'room-card'; card.href = a.href; card.dataset.card = r.id;
    const icon = document.createElement('span'); icon.className = 'card-hash'; icon.textContent = '#';
    const heading = document.createElement('h3'); heading.textContent = r.name;
    const status = document.createElement('span'); status.className = 'card-online';
    const count = document.createElement('span'); count.dataset.count = r.id; count.textContent = '0';
    status.append(count, document.createTextNode(' online'));
    const text = document.createElement('p'); text.textContent = r.description || 'A fresh space for a new conversation.';
    const enter = document.createElement('span'); enter.className = 'card-enter'; enter.textContent = 'Join conversation →';
    card.append(icon, status, heading, text, enter); $('room-cards').insertBefore(card, document.querySelector('.create-card'));
  }
}
function updateCounts(counts: any) {
  document.querySelectorAll<HTMLElement>('[data-count]').forEach(el => { const n = counts[el.dataset.count!] || 0; el.textContent = el.classList.contains('room-count') && !n ? '' : String(n); });
}

const items = new Map<string, any>();
let hasMore = !!state.initial?.hasMore;
let online: any[] = [];
let loadingOlder = false;
const ordered = () => [...items.values()].sort(compareMessages);
const scroll = room ? $('message-scroll') : null;
const atBottom = () => !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
function toBottom() { if (scroll) { scroll.scrollTop = scroll.scrollHeight; hide($('new-messages')); } }
function contentNodes(content: string) {
  const fragment = document.createDocumentFragment();
  const pattern = /(?:^|(?<=[^a-zA-Z0-9_@-]))@([a-zA-Z0-9_][a-zA-Z0-9_-]*)/g;
  let offset = 0;
  for (const match of content.matchAll(pattern)) {
    fragment.append(document.createTextNode(content.slice(offset, match.index)));
    const span = document.createElement('span'); span.className = 'mention';
    if (match[1].toLowerCase() === me.nickname.toLowerCase() || match[1].toLowerCase() === 'everyone') span.classList.add('mention-me');
    span.textContent = match[1].toLowerCase() === 'everyone' ? '@EVERYONE' : match[0]; fragment.append(span); offset = match.index! + match[0].length;
  }
  fragment.append(document.createTextNode(content.slice(offset))); return fragment;
}
function renderMessages() {
  const rows = ordered(); const fragment = document.createDocumentFragment(); let previous: any;
  for (const m of rows) {
    const date = new Date(m.created_at), dateLabel = date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    if (!previous || new Date(previous.created_at).toDateString() !== date.toDateString()) {
      const divider = document.createElement('div'); divider.className = 'date-divider'; const label = document.createElement('span'); label.textContent = date.toDateString() === new Date().toDateString() ? `Today, ${date.toLocaleDateString([], { month: 'long', day: 'numeric' })}` : dateLabel; divider.append(label); fragment.append(divider);
    }
    const el = document.createElement('article'); el.id = `message-${m.id}`;
    if (m.type !== 'message') { el.className = 'system-message'; el.textContent = m.content; }
    else {
      const grouped = previous?.type === 'message' && previous.user_id === m.user_id && date.getTime() - new Date(previous.created_at).getTime() < 300000 && date.toDateString() === new Date(previous.created_at).toDateString();
      el.className = `message${m.user_id === me.id ? ' own-message' : ''}${grouped ? ' grouped' : ''}`;
      const avatar = document.createElement('span'); avatar.className = 'avatar message-avatar'; avatar.style.setProperty('--avatar', m.color); avatar.textContent = (m.nickname || '?').slice(0, 2).toUpperCase();
      const body = document.createElement('div'); body.className = 'message-body';
      if (!grouped) {
        const header = document.createElement('div'); header.className = 'message-meta';
        const name = document.createElement('strong'); name.textContent = m.nickname || 'Someone';
        const time = document.createElement('time'); time.dateTime = m.created_at; time.textContent = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        header.append(name); if (m.user_id === me.id) { const you = document.createElement('span'); you.className = 'you-tag'; you.textContent = 'you'; header.append(you); } header.append(time); body.append(header);
      }
      const p = document.createElement('p'); p.append(contentNodes(m.content)); body.append(p); el.append(avatar, body);
    }
    fragment.append(el); previous = m;
  }
  $('messages').replaceChildren(fragment); hide($('load-earlier'), !hasMore); hide($('empty-chat'), rows.some(m => m.type === 'message'));
}
function mergeMessages(rows: any[], older = false) {
  const bottom = atBottom(); const height = scroll!.scrollHeight; const top = scroll!.scrollTop;
  for (const m of rows) items.set(m.id, m);
  renderMessages();
  if (older) scroll!.scrollTop = top + scroll!.scrollHeight - height;
  else if (bottom) toBottom(); else { scroll!.scrollTop = top; hide($('new-messages'), false); }
}
async function loadEarlier() {
  if (loadingOlder || !hasMore) return false;
  loadingOlder = true; const button = $('load-earlier') as HTMLButtonElement; button.disabled = true; button.textContent = 'Loading…';
  try { const first = ordered()[0]; const data = await api(`/api/rooms/${room.id}/history?before=${encodeURIComponent(first.created_at)}&before_id=${encodeURIComponent(first.id)}`); hasMore = data.hasMore; mergeMessages(data.messages, true); return true; }
  catch (e: any) { toast(e.message); return false; }
  finally { loadingOlder = false; button.disabled = false; button.textContent = 'Load earlier messages'; }
}
async function revealMessage(id: string) {
  while (!items.has(id) && hasMore) { if (!await loadEarlier()) return; }
  const target = document.getElementById(`message-${id}`); if (target) { target.scrollIntoView({ block: 'center' }); target.classList.add('message-highlight'); setTimeout(() => target.classList.remove('message-highlight'), 2500); }
}
let syncing = false;
async function syncHistory() {
  if (!room || syncing) return; syncing = true;
  try {
    const known = new Set(items.keys()); const batch = [];
    let data = await api(`/api/rooms/${room.id}/history`);
    while (true) {
      batch.push(...data.messages);
      if (!known.size || data.messages.some((m: any) => known.has(m.id)) || !data.hasMore) break;
      const first = data.messages[0]; data = await api(`/api/rooms/${room.id}/history?before=${encodeURIComponent(first.created_at)}&before_id=${encodeURIComponent(first.id)}`);
    }
    if (!known.size) hasMore = data.hasMore;
    mergeMessages(batch);
    if (location.hash.startsWith('#message-')) await revealMessage(location.hash.slice(9));
  } catch (e: any) { toast(e.message); } finally { syncing = false; }
}
if (room) {
  for (const m of state.initial.messages) items.set(m.id, m);
  renderMessages(); toBottom();
  $('load-earlier').addEventListener('click', () => void loadEarlier());
  $('new-messages').addEventListener('click', toBottom);
  scroll!.addEventListener('scroll', () => { if (atBottom()) hide($('new-messages')); });
  $('members-toggle').addEventListener('click', () => { const closed = $('chat-app').classList.toggle('members-closed'); $('members-toggle').setAttribute('aria-expanded', String(!closed)); });
}
function renderOnline(people: any[]) {
  online = people;
  if (!room) return;
  $('online-count').textContent = String(people.length); $('member-count').textContent = String(people.length); $('member-list').replaceChildren();
  for (const person of people.sort((a, b) => a.nickname.localeCompare(b.nickname))) {
    const row = document.createElement('button'); row.className = 'member'; row.title = `Mention ${person.nickname}`;
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.style.setProperty('--avatar', person.color); avatar.textContent = person.nickname.slice(0, 2).toUpperCase();
    const label = document.createElement('span'); label.textContent = person.nickname;
    const dot = document.createElement('span'); dot.className = 'tiny-dot'; row.append(avatar, label, dot);
    row.addEventListener('click', () => { input.value += `${input.value && !input.value.endsWith(' ') ? ' ' : ''}@${person.nickname} `; input.focus(); }); $('member-list').append(row);
  }
}
const input = room ? $('message-input') as HTMLTextAreaElement : null!;
let selected = 0, choices: any[] = [], mentionStart = -1;
function mentionOptions() {
  const text = input.value.slice(0, input.selectionStart); const match = text.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
  const menu = $('mention-menu'); menu.replaceChildren();
  if (!match) { hide(menu); mentionStart = -1; return; }
  mentionStart = text.lastIndexOf('@');
  choices = [...online.filter(p => p.id !== me.id), { id: 'everyone', nickname: 'everyone', color: '#847149' }].filter(p => p.nickname.toLowerCase().startsWith(match[1].toLowerCase())).slice(0, 8);
  selected = Math.min(selected, choices.length - 1);
  choices.forEach((p, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `mention-option${index === selected ? ' selected' : ''}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === selected)); button.textContent = `@${p.nickname}${p.id === 'everyone' ? ' · Notify everyone' : ''}`;
    button.addEventListener('mousedown', e => e.preventDefault()); button.addEventListener('click', () => chooseMention(index)); menu.append(button);
  }); hide(menu, !choices.length);
}
function chooseMention(index: number) {
  if (mentionStart < 0 || !choices[index]) return;
  const end = input.selectionStart; const replacement = `@${choices[index].nickname} `;
  input.value = input.value.slice(0, mentionStart) + replacement + input.value.slice(end); input.focus(); input.selectionStart = input.selectionEnd = mentionStart + replacement.length; hide($('mention-menu')); mentionStart = -1;
}
let lastTyped = 0, sending = false;
if (room) {
  input.addEventListener('input', () => {
    input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
    selected = 0; mentionOptions();
    if (Date.now() - lastTyped > 800) { lastTyped = Date.now(); void api(`/api/rooms/${room.id}/typing`, { active: !!input.value.trim() }).catch(() => {}); }
  });
  input.addEventListener('keydown', e => {
    if (!$('mention-menu').hidden) {
      if (['ArrowDown','ArrowUp'].includes(e.key)) { e.preventDefault(); selected = (selected + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length; mentionOptions(); return; }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); chooseMention(selected); return; }
      if (e.key === 'Escape') { hide($('mention-menu')); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ($('message-form') as HTMLFormElement).requestSubmit(); }
  });
  input.addEventListener('blur', () => { setTimeout(() => hide($('mention-menu')), 150); });
  $('message-form').addEventListener('submit', async e => {
    e.preventDefault(); if (sending || !input.value.trim()) return;
    sending = true; const content = input.value; ($('send-button') as HTMLButtonElement).disabled = true; $('message-error').textContent = '';
    try {
      const data = await api(`/api/rooms/${room.id}/messages`, { content }); mergeMessages([data.message]);
      if (input.value === content) { input.value = ''; input.style.height = 'auto'; }
      hide($('mention-menu')); input.focus();
    } catch (error: any) { $('message-error').textContent = error.message; }
    finally { sending = false; ($('send-button') as HTMLButtonElement).disabled = false; }
  });
}

const source = new EventSource(room ? `/api/rooms/${room.id}/stream` : '/api/directory/stream');
const listen = (event: string, fn: (data: any) => void) => source.addEventListener(event, (e: MessageEvent) => { try { fn(JSON.parse(e.data)); } catch (error) { console.error(`Live ${event} event`, error); } });
listen('ready', data => { updateCounts(data.counts); updateIdentity(data.user); if (room) { hide($('connection-banner')); $('connection-label').textContent = 'Connected & live'; $('connection-dot').classList.remove('offline'); } void loadNotices(); void api('/api/rooms').then(data => { data.rooms.forEach(addRoom); updateCounts(data.counts); }).catch(() => {}); });
listen('sync', () => void syncHistory());
listen('message', m => { if (!room || m.room_id !== room.id) return; const fresh = !items.has(m.id); mergeMessages([m]); if (fresh && m.type === 'message' && m.user_id !== me.id) { const mentioned = [...m.content.matchAll(/@([a-zA-Z0-9_-]+)/g)].some(match => ['everyone', me.nickname.toLowerCase()].includes(match[1].toLowerCase())); if (!mentioned) play(); } });
listen('presence', data => updateCounts(data.counts));
listen('userlist', renderOnline);
listen('typing', people => { if (!room) return; const names = people.filter((p: any) => p.id !== me.id).map((p: any) => p.nickname); $('typing').textContent = names.length ? `${names.slice(0, 3).join(', ')} ${names.length === 1 ? 'is' : 'are'} typing…` : ''; });
const mentionIds = new Set<string>();
listen('mention', data => { if (mentionIds.has(data.id)) return; mentionIds.add(data.id); void loadNotices(); play(true); toast(`${data.nickname} mentioned you${data.room_id === room?.id ? '' : ' in another room'}`); });
listen('notifications-read', () => void loadNotices());
listen('newroom', addRoom);
listen('identity', updateIdentity);
source.onerror = () => { if (room) { hide($('connection-banner'), false); $('connection-label').textContent = 'Reconnecting'; $('connection-dot').classList.add('offline'); } };
window.addEventListener('pagehide', () => source.close());
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
