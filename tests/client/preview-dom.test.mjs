import test from 'node:test';
import assert from 'node:assert/strict';
import { clipPreviewInterval, previewTabIndex, reconcilePreviewChildren } from '../../client/src/timeline/preview-dom.js';

test('huge session hit areas clip before CSS while remaining aligned through camera movement', () => {
  assert.deepEqual(clipPreviewInterval(-1e20, 1e20, 1000), { left: -1000, width: 3000, visible: true });
  assert.deepEqual(clipPreviewInterval(-1e20, 10, 1000), { left: -1000, width: 1010, visible: true });
  assert.deepEqual(clipPreviewInterval(100, 1e20, 1000, -500), { left: 100, width: 2400, visible: true });
  assert.deepEqual(clipPreviewInterval(-1e20, 1e20, 1000, -2500), { left: 1500, width: 3000, visible: true });
  assert.deepEqual(clipPreviewInterval(2100, 2200, 1000), { left: 0, width: 0, visible: false });
  assert.deepEqual(clipPreviewInterval(2100, 2200, 1000, -1000), { left: 2100, width: 100, visible: true });
  for (const args of [[0, 0, 1000], [0, Infinity, 1000], [NaN, 10, 1000], [0, 10, 0]]) assert.equal(clipPreviewInterval(...args).visible, false);
});

test('only camera-intersecting preview labels enter keyboard navigation', () => {
  assert.equal(previewTabIndex(450, 500, 400), -1);
  assert.equal(previewTabIndex(-80, 0, 400), -1);
  assert.equal(previewTabIndex(450, 500, 400, -100), 0);
  assert.equal(previewTabIndex(-80, 20, 400), 0);
  assert.equal(previewTabIndex(-1000, 1000, 400), 0);
  assert.equal(previewTabIndex(20, 100, 400, -200), -1);
  for (const args of [[0, 0, 400], [0, Infinity, 400], [NaN, 10, 400], [0, 10, 0]]) assert.equal(previewTabIndex(...args), -1);
});

class Node {
  constructor(html) { this.outerHTML = html; this.parent = null; }
  get nextSibling() { const siblings = this.parent?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
}
class Parent {
  constructor(nodes) { this.children = nodes; this.operations = []; for (const node of nodes) node.parent = this; }
  get firstChild() { return this.children[0] || null; }
  removeChild(node) { this.operations.push(['remove', node]); this.children.splice(this.children.indexOf(node), 1); node.parent = null; }
  insertBefore(node, cursor) {
    this.operations.push(['insert', node]);
    if (node.parent) node.parent.removeChild(node);
    const index = cursor ? this.children.indexOf(cursor) : this.children.length;
    this.children.splice(index, 0, node); node.parent = this;
  }
}
const nodes = values => values.map(value => new Node(value));

test('preview reconciliation preserves unchanged focused nodes without detach or reorder', () => {
  const [a, focus, b] = nodes(['a', 'focus', 'b']), parent = new Parent([a, focus, b]);
  reconcilePreviewChildren(parent, nodes(['new', 'a', 'focus', 'other', 'b']));
  assert.deepEqual(parent.children.map(node => node.outerHTML), ['new', 'a', 'focus', 'other', 'b']);
  assert.equal(parent.children[2], focus);
  assert.ok(parent.operations.every(([, node]) => ![a, focus, b].includes(node)));
  parent.operations = [];
  reconcilePreviewChildren(parent, nodes(['a', 'focus', 'b']));
  assert.equal(parent.children[1], focus);
  assert.ok(parent.operations.every(([, node]) => ![a, focus, b].includes(node)));
});

test('preview reconciliation handles changed content, duplicate markup, ordering and empty results', () => {
  const parent = new Parent(nodes(['duplicate', 'duplicate', 'old', 'tail']));
  const duplicates = parent.children.slice(0, 2);
  reconcilePreviewChildren(parent, nodes(['tail', 'duplicate', 'new', 'duplicate']));
  assert.deepEqual(parent.children.map(node => node.outerHTML), ['tail', 'duplicate', 'new', 'duplicate']);
  assert.equal(parent.children[1], duplicates[0]); assert.equal(parent.children[3], duplicates[1]);
  reconcilePreviewChildren(parent, []);
  assert.equal(parent.children.length, 0);
});
