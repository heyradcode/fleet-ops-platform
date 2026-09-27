import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSse } from './sse.ts';

test('complete events are returned; a half-received one waits for the next chunk', () => {
  const first = parseSse('data: {"a":1}\n\ndata: {"b"');
  assert.deepEqual(first.events, [{ a: 1 }]);
  const second = parseSse(first.rest + ':2}\n\n');
  assert.deepEqual(second.events, [{ b: 2 }]);
  assert.equal(second.rest, '');
});

test('CRLF line endings and multi-line data are handled', () => {
  assert.deepEqual(parseSse('data: {"x":\r\ndata: 1}\r\n\r\n').events, [{ x: 1 }]);
});
