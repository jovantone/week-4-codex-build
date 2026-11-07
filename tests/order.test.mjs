import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { compareMessages } from '../src/lib/order.mjs';
test('client ordering matches database cursor ordering for mixed-case nanoids and timestamp ties', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE messages(id TEXT,created_at TEXT)');
  const insert = db.prepare('INSERT INTO messages VALUES(?,?)');
  const rows = ['a_b','ZAb','-Ab','_Ab','a-B','ABc','0bc','zBc'].map((id,i) => ({ id, created_at: i === 3 ? '2026-10-22T00:00:01.000Z' : '2026-10-22T00:00:00.000Z' }));
  for (const row of rows) insert.run(row.id, row.created_at);
  assert.deepEqual(rows.sort(compareMessages).map(r => r.id), db.prepare('SELECT id FROM messages ORDER BY created_at,id COLLATE BINARY').all().map(r => r.id));
  db.close();
});
