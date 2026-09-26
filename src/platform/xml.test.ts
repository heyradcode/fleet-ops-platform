/**
 * The XML reader. The refusals are pinned as hard as the parsing: each one
 * is a way a parser becomes an attack surface on a vendor's response body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { childText, childrenNamed, descendants, escapeXml, localName, parseXml, XmlError } from './xml.ts';

test('parses elements, attributes, text, entities, CDATA and self-closing tags', () => {
  const doc = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<Root kind='sites'>
  <Site id="1"><Name>HHS &amp; Partners &#x2014; &#169;</Name><Empty/></Site>
  <Site id="2"><Name><![CDATA[<raw> & unescaped]]></Name></Site>
</Root>`);
  assert.equal(doc.name, 'Root');
  assert.equal(doc.attrs.kind, 'sites');
  const sites = childrenNamed(doc, 'Site');
  assert.equal(sites.length, 2);
  assert.equal(childText(sites[0], 'Name'), 'HHS & Partners — ©');
  assert.equal(childText(sites[1], 'Name'), '<raw> & unescaped');
  assert.equal(childText(sites[0], 'Empty'), '');
  assert.equal(childText(sites[0], 'Missing'), undefined);
});

test('namespace prefixes are kept, and ignored by the lookups', () => {
  const doc = parseXml('<S:Envelope xmlns:S="x"><S:Body><ns2:Result><status>SUCCESS</status></ns2:Result></S:Body></S:Envelope>');
  assert.equal(doc.name, 'S:Envelope');
  assert.equal(localName(doc), 'Envelope');
  assert.equal(descendants(doc, 'status')[0].text, 'SUCCESS');
});

test('refuses a DOCTYPE - no DTD, so no external entities and no entity expansion', () => {
  const xxe = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>';
  assert.throws(() => parseXml(xxe), XmlError);
  const laughs = '<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><l>&b;</l>';
  assert.throws(() => parseXml(laughs), /DOCTYPE/);
});

test('refuses undefined entities, bare ampersands and malformed structure', () => {
  assert.throws(() => parseXml('<a>&nbsp;</a>'), /undefined entity/);
  assert.throws(() => parseXml('<a>fish & chips</a>'), /bare "&"/);
  assert.throws(() => parseXml('<a><b></a>'), /mismatched/);
  assert.throws(() => parseXml('<a>'), /unclosed/);
  assert.throws(() => parseXml('<a/><b/>'), /more than one root/);
  assert.throws(() => parseXml('<a x=1/>'), /unquoted/);
  assert.throws(() => parseXml('text only'), /outside the root|no root/);
});

test('bounds nesting depth', () => {
  const deep = '<a>'.repeat(100) + '</a>'.repeat(100);
  assert.throws(() => parseXml(deep), /nesting/);
});

test('escapeXml round-trips through the parser', () => {
  const s = `Tom & Jerry's <"sbc">`;
  assert.equal(parseXml('<a t="' + escapeXml(s) + '">' + escapeXml(s) + '</a>').text, s);
});
