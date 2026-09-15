import * as THREE from 'three';
import { clipPreviewInterval, previewTabIndex, reconcilePreviewChildren } from './preview-dom.js';
import { createElement, icons } from 'lucide';
import { escapeHtml } from '../utils/dom.js';
import { zoneLabels } from './zones.js';
import { hazardIcons } from './hazard-icons.js';
import '../styles/grouping.css';
const recordIcons = { circle: icons.Circle, check: icons.Check, 'alert-triangle': icons.AlertTriangle, info: icons.Info, flag: icons.Flag, radio: icons.Radio, clock: icons.Clock, 'file-text': icons.FileText, star: icons.Star };

export class TimelineRenderer {
  constructor(host) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 100);
    this.camera.position.z = 10;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.renderer.domElement.className = 'timeline-canvas';
    this.labels = document.createElement('div'); this.labels.className = 'record-label-layer';
    this.labels.style.overflow = 'visible';
    host.append(this.renderer.domElement, this.labels);
  }
  clear() {
    for (const child of [...this.scene.children]) {
      this.scene.remove(child); child.geometry?.dispose(); child.material?.dispose();
    }
  }
  rect(x, y, width, height, color, opacity = 1, z = 0, fixed = false) {
    if (!(width > 0 && height > 0)) return;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, height), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false }));
    mesh.renderOrder = z * 100;
    mesh.userData.fixed = fixed;
    mesh.userData.horizontalInterval = { x, width };
    mesh.position.set(x + width / 2, this.height - y - height / 2, z);
    mesh.scale.x = width;
    if (!fixed) this.clipRectangle(mesh, 0);
    this.scene.add(mesh);
    return mesh;
  }
  clipRectangle(mesh, offset) {
    const interval = mesh.userData.horizontalInterval;
    // Clip huge/ongoing durations in double precision before handing coordinates to WebGL.
    const left = Math.max(interval.x, -offset - this.width), right = Math.min(interval.x + interval.width, -offset + this.width * 2);
    mesh.visible = right > left;
    if (mesh.visible) { mesh.position.x = left + (right - left) / 2; mesh.scale.x = right - left; }
  }
  previewGrid(ticks = this.baseGrid.ticks, project = this.baseGrid.project) {
    for (const mesh of [...this.scene.children]) if (mesh.userData.timeGrid) {
      this.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose();
    }
    for (const tick of ticks) {
      const mesh = this.rect(project(tick.timeMs), 0, 1, this.height, this.baseGrid.color, tick.minor ? .1 : this.baseGrid.opacity, .2);
      if (mesh) mesh.userData.timeGrid = true;
    }
  }
  point(x, y, radius, color, selected = false, legacy = false) {
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, legacy ? 20 : 24), new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false }));
    mesh.position.set(x, this.height - y, 1); mesh.renderOrder = 100; this.scene.add(mesh);
    if (selected) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(legacy ? 6 : radius + 2, legacy ? 7 : radius + 4, 24), new THREE.MeshBasicMaterial({ color: '#168bff', side: THREE.DoubleSide, transparent: true, depthTest: false, depthWrite: false }));
      ring.position.set(x, this.height - y, 1.1); ring.renderOrder = 110; this.scene.add(ring);
    }
  }
  render({ rows, width, height, rowHeight, fontSize, project, zones = [], selectedId, theme = 'light', ticks = [], hasSearch = false, referenceTime, interactive = true, presentation, labelBackgroundAuthored = false, preview = false }) {
    const focusedGroup = this.labels.contains(document.activeElement) ? document.activeElement.closest('[data-group-key]')?.dataset.groupKey : null;
    const focusedNode = this.labels.contains(document.activeElement) ? document.activeElement : null;
    const focusedRecord = focusedNode?.dataset.recordId;
    if (preview && !this.previewOverflow) {
      this.previewOverflow = { value: this.host.style.getPropertyValue('overflow'), priority: this.host.style.getPropertyPriority('overflow') };
      this.host.style.setProperty('overflow', 'clip');
    } else if (!preview) this.restoreOverflow();
    const styled = !!presentation || rows.items?.some(item => item.style);
    rowHeight = rows.rowHeight || rowHeight; presentation = styled ? rows.presentation || presentation : undefined;
    const paddingTop = presentation?.compact ? presentation.bandLayout?.some(band => band.relativeAxis) ? 28 : 4 : 52;
    this.clear(); this.width = width; this.height = height;
    this.renderer.domElement.dataset.minorTicks = JSON.stringify(ticks.filter(t => t.minor && project(t.timeMs) >= 0 && project(t.timeMs) < width).map(t => t.timeMs));
    this.renderer.setSize(width, height);
    this.camera.left = 0; this.camera.right = width; this.camera.top = height; this.camera.updateProjectionMatrix();
    this.scene.background = new THREE.Color(presentation?.bands.primary.backgroundColor || (theme === 'dark' ? '#171c21' : theme === 'classic' ? '#a9d7ef' : '#eef0f0'));
    const rowSources = new Map();
    for (const item of rows.items || []) if (item.record) { const list = rowSources.get(item.row) || []; list.push(item); rowSources.set(item.row, list); }
    const mixedSourceRows = new Set([...rowSources].filter(([, items]) => new Set(items.map(item => item.record.sourceId)).size > 1).map(([row]) => row));
    for (const [row, items] of rowSources) if (new Set(items.map(item => item.record.sourceId)).size === 1 && items[0].style?.sourceBackground) this.rect(0, paddingTop + (row - rows.startRow) * rowHeight, width, rowHeight, items[0].style.sourceBackground, 1, -0.1, true);
    zones.forEach(z => { const x = project(z.start), e = project(z.end); this.rect(x, 0, e - x, height, z.color || '#e9a951', z.opacity ?? 0.2, 0.1); });
    this.baseGrid = { ticks, project, color: presentation?.bands.primary.dateColor || (theme === 'dark' ? '#394249' : '#d0d7d9'), opacity: presentation ? .22 : .65 };
    this.previewGrid();
    if (referenceTime) { const x = project(referenceTime); if (x >= 0 && x <= width) this.rect(x, 0, 1, height, theme === 'dark' ? '#c0d1da' : '#71848d', 0.7, 0.3); }
    const labels = [zoneLabels(zones, project, width, presentation?.compact ? Math.max(5, height - 40) : 5)];
    for (const enclosure of rows.enclosures || []) {
      const first = enclosure.visibleStartRow ?? Math.max(rows.startRow, enclosure.startRow), last = enclosure.visibleEndRow ?? Math.min(rows.endRow, enclosure.endRow);
      const y = paddingTop + (first - rows.startRow) * rowHeight, h = (last - first) * rowHeight;
      const x = enclosure.xStart, w = enclosure.xEnd - x;
      if (w <= 0 || h <= 0) continue;
      this.rect(x, y, w, h, enclosure.color, enclosure.opacity, 0.31);
      this.rect(x, y, 1, h, enclosure.color, 0.65, 0.32); this.rect(x + w - 1, y, 1, h, enclosure.color, 0.65, 0.32);
      if (!enclosure.continuedBefore) this.rect(x, y, w, 1, enclosure.color, 0.65, 0.32);
      if (!enclosure.continuedAfter) this.rect(x, y + h - 1, w, 1, enclosure.color, 0.65, 0.32);
      labels.push(`<div class="session-enclosure" data-parent-id="${escapeHtml(enclosure.parentId)}" data-continued-before="${!!enclosure.continuedBefore}" data-continued-after="${!!enclosure.continuedAfter}" aria-hidden="true" style="position:absolute;pointer-events:none;left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`);
    }
    const groups = [...(rows.rows || []), ...(rows.items || []).filter(item => item.type === 'group')];
    for (const group of groups) {
      const y = paddingTop + (group.row - rows.startRow) * rowHeight;
      this.rect(0, y, width, rowHeight - 2, group.style?.backgroundColor || (theme === 'dark' ? '#293740' : '#dae3e7'), 1, 0.5, true);
      const groupColor = group.style?.textColor || presentation?.bands.primary.textColor || 'inherit';
      if (interactive && typeof group.collapsed === 'boolean') {
        const disclosure = createElement(group.collapsed ? icons.ChevronRight : icons.ChevronDown, { 'aria-hidden': 'true' }).outerHTML;
        const action = `${group.collapsed ? 'Expand' : 'Collapse'} ${group.name}`;
        const status = `${group.recordCount} records${hasSearch ? `, ${group.matchCount} findings` : ''}${group.continuation ? ', continued' : ''}`;
        labels.push(`<button type="button" class="group-label group-toggle" data-group-key="${escapeHtml(group.key)}" data-continuation="${!!group.continuation}" aria-expanded="${!group.collapsed}" aria-label="${escapeHtml(`${action}, ${status}`)}" title="${escapeHtml(action)}" style="top:${y}px;height:${rowHeight - 2}px;max-width:${Math.max(1, width - 14)}px;color:${groupColor}">${disclosure}<span class="group-name">${escapeHtml(group.name)}</span><span class="group-count">${group.recordCount}</span>${group.continuation ? '<span class="group-continued">continued</span>' : ''}</button>`);
      } else labels.push(`<div class="group-label" style="top:${y}px;color:${groupColor}">${escapeHtml(group.name)}</div>`);
    }
    for (const item of rows.items || []) {
      const record = item.record; if (!record) continue;
      const y = paddingTop + (item.row - rows.startRow) * rowHeight;
      if (item.style && item.labelLines) {
        const style = { ...item.style }, point = record.kind === 'event' || (record.end !== null && record.end === record.start), centerY = y + item.geometryOffsetY;
        const selected = record.id === selectedId, left = item.xStart, right = item.xEnd;
        if (selected) this.rect(0, y, width, rowHeight, '#3c94c4', 0.12, 0.4, true);
        if (item.baselineStart != null && item.baselineEnd != null) this.rect(Math.min(item.baselineStart, item.baselineEnd), y + item.baselineOffsetY, Math.abs(item.baselineEnd - item.baselineStart), 1, presentation?.baseline.color || '#78848d', 1, 0.7);
        if (point && !hazardIcons[style.icon]) this.point(item.xStart, centerY, style.pointRadius, style.color, selected);
        else if (!point) {
          if (selected) { const top = centerY - style.barHeight / 2; this.rect(left - 4, top - 4, right - left + 8, 2, '#168bff', 1, 0.9); this.rect(left - 4, top + style.barHeight + 2, right - left + 8, 2, '#168bff', 1, 0.9); this.rect(left - 4, top - 2, 2, style.barHeight + 4, '#168bff', 1, 0.9); this.rect(right + 2, top - 2, 2, style.barHeight + 4, '#168bff', 1, 0.9); }
          const uncertainty = record.extensions?.uncertainty;
          this.rect(left, centerY - style.barHeight / 2, Math.max(2, right - left), style.barHeight, style.color, uncertainty && Object.keys(uncertainty).length ? .3 : 1, 1);
          if (uncertainty && Object.keys(uncertainty).length) {
            const coreStart = uncertainty.lateststart ? project(uncertainty.lateststart) : left, coreEnd = uncertainty.earliestend ? project(uncertainty.earliestend) : right;
            this.rect(coreStart, centerY - style.barHeight / 2, coreEnd - coreStart, style.barHeight, style.color, 1, 1.01);
          }
        }
        const tag = interactive ? 'button' : 'span', fullLabel = item.fullLabel || record.title;
        const sourceFallback = mixedSourceRows.has(item.row) && !labelBackgroundAuthored && !Object.hasOwn(record.render || {}, 'backgroundColor') ? style.sourceBackground : null;
        const labelBackground = hasSearch && item.match ? '#f7df14' : item.labelInsideBar ? style.color : style.backgroundColor ?? sourceFallback ?? 'transparent';
        if (item.labelInsideBar) {
          const rgb = style.color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
          style.textColor = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > .179 ? '#111111' : '#ffffff';
        }
        labels.push(`<${tag} class="record-label ${hasSearch && item.match ? 'search-match' : ''} ${selected ? 'selected' : ''}" data-record-id="${escapeHtml(record.id)}" data-multiline="true" style="left:${item.labelX}px;top:${y + item.labelOffsetY}px;width:${Math.max(1, item.labelWidth)}px;max-width:none;height:${item.labelLines.length * item.labelLineHeight}px;min-height:0;padding:0;line-height:${item.labelLineHeight}px;font-size:${style.fontSize}px;font-weight:${style.fontWeight};font-style:${style.fontStyle};color:${hasSearch && item.match ? '#16180d' : style.textColor};--record-label-background:${labelBackground};background:${labelBackground};overflow:visible;text-overflow:clip" title="${escapeHtml(fullLabel)}" aria-label="${escapeHtml(`${fullLabel}, ${record.kind}, ${record.start}`)}">${item.labelLines.map((line, index) => `<span class="record-label-line" style="position:absolute;left:${-(item.labelInkOffsets?.[index] || 0)}px;top:${index * item.labelLineHeight}px;white-space:pre">${escapeHtml(line)}</span>`).join('')}</${tag}>`);
        if (style.icon && (recordIcons[style.icon] || hazardIcons[style.icon]) && item.iconX != null) {
          const svg = hazardIcons[style.icon] ? `<img src="${hazardIcons[style.icon]}" width="16" height="16" alt="" aria-hidden="true" draggable="false" data-hazard-icon="${style.icon}" style="width:16px;height:16px;object-fit:contain">`
            : createElement(recordIcons[style.icon], { width: 16, height: 16, style: 'width:16px;height:16px;flex:none', 'stroke-width': 2, 'aria-hidden': 'true' }).outerHTML;
          labels.push(`<${tag} class="record-icon" data-record-id="${escapeHtml(record.id)}" tabindex="-1" title="${escapeHtml(fullLabel)}" aria-label="${escapeHtml(fullLabel)}" style="position:absolute;left:${item.iconX - 4}px;top:${centerY - 12}px;width:24px;height:24px;min-width:24px;min-height:24px;padding:4px;border:0;background:transparent;color:${style.color};display:flex;align-items:center;justify-content:center">${svg}</${tag}>`);
        }
        if (!point && interactive) {
          const hitEnd = Math.max(left + 8, right), hit = clipPreviewInterval(left, hitEnd, width);
          labels.push(`<button class="record-hit" data-record-id="${escapeHtml(record.id)}" data-hit-start="${left}" data-hit-end="${hitEnd}"${hit.visible ? '' : ' hidden'} style="left:${hit.left}px;top:${centerY - Math.max(12, style.barHeight) / 2}px;width:${hit.width}px;height:${Math.max(12, style.barHeight)}px" title="${escapeHtml(fullLabel)}" aria-label="${escapeHtml(fullLabel)}" tabindex="-1"></button>`);
        }
        continue;
      }
      const barTop = fontSize + 8, pointY = fontSize / 2 + 3.5;
      const color = record.render?.color || '#367ba4';
      const isPoint = record.kind === 'event' || (record.end !== null && record.end === record.start);
      const x = item.xStart, end = item.xEnd;
      if (record.id === selectedId) this.rect(0, y, width, rowHeight, '#3c94c4', 0.12, 0.4, true);
      if (isPoint) {
        this.point(x, y + pointY, 4.5, color, record.id === selectedId, true);
      } else {
        const left = x, right = end;
        if (record.id === selectedId) this.rect(left - 2, y + barTop - 2, Math.max(2, right - left) + 4, 12, '#168bff', 1, 0.6);
        this.rect(left, y + barTop, Math.max(2, right - left), 8, color, 1, 1);
      }
      const label = item.displayTitle || record.title;
      const labelTag = interactive ? 'button' : 'span';
      const labelLeft = preview ? item.labelX : Math.max(0, item.labelX);
      labels.push(`<${labelTag} class="record-label ${hasSearch && item.match ? 'search-match' : ''} ${selectedId === record.id ? 'selected' : ''}" data-record-id="${escapeHtml(record.id)}" style="left:${labelLeft}px;top:${y}px;max-width:${Math.max(1, preview ? item.labelWidth + 3 : Math.min(item.labelWidth + 3, width - labelLeft))}px;font-size:${fontSize}px;height:${fontSize + 7}px;line-height:${fontSize + 5}px" title="${escapeHtml(record.title)}" aria-label="${escapeHtml(`${record.title}, ${record.kind}, ${record.start}`)}">${escapeHtml(label)}</${labelTag}>`);
      if (!isPoint && interactive) {
        const hitEnd = Math.max(x + 8, end), hit = clipPreviewInterval(x, hitEnd, width);
        labels.push(`<button class="record-hit" data-record-id="${escapeHtml(record.id)}" data-hit-start="${x}" data-hit-end="${hitEnd}"${hit.visible ? '' : ' hidden'} style="left:${hit.left}px;top:${y + barTop - 2}px;width:${hit.width}px" title="${escapeHtml(record.title)}" aria-label="${escapeHtml(record.title)}" tabindex="-1"></button>`);
      }
    }
    if (preview) {
      const template = document.createElement('template'); template.innerHTML = labels.join('');
      reconcilePreviewChildren(this.labels, [...template.content.children]);
    } else this.labels.innerHTML = labels.join('');
    this.hitTargets = [...this.labels.querySelectorAll('[data-hit-start]')].map(node => ({ node, start: Number(node.dataset.hitStart), end: Number(node.dataset.hitEnd) }));
    this.previewLabels = preview ? [...this.labels.querySelectorAll('button.record-label')].map(node => {
      const start = Number.parseFloat(node.style.left); return { node, start, end: start + node.getBoundingClientRect().width };
    }) : [];
    this.updatePreviewTabOrder(0);
    if (preview && focusedRecord && document.activeElement !== focusedNode) {
      const target = this.labels.contains(focusedNode) ? focusedNode : [...this.labels.querySelectorAll('[data-record-id]')].find(node => node.dataset.recordId === focusedRecord && node.className === focusedNode.className);
      target?.focus({ preventScroll: true });
    }
    if (focusedGroup) [...this.labels.querySelectorAll('[data-group-key]')].find(node => node.dataset.groupKey === focusedGroup)?.focus({ preventScroll: true });
    this.renderer.render(this.scene, this.camera);
  }
  previewOffset(dx) {
    if (!Number.isFinite(dx) || !this.width) return;
    this.camera.left = -dx; this.camera.right = this.width - dx; this.camera.updateProjectionMatrix();
    for (const mesh of this.scene.children) {
      if (mesh.userData.fixed) mesh.position.x = this.width / 2 - dx;
      else if (mesh.userData.horizontalInterval) this.clipRectangle(mesh, dx);
    }
    for (const target of this.hitTargets || []) {
      const hit = clipPreviewInterval(target.start, target.end, this.width, dx);
      if (target.node.hidden === hit.visible) target.node.hidden = !hit.visible;
      const left = `${hit.left}px`, width = `${hit.width}px`;
      if (target.node.style.left !== left) target.node.style.left = left;
      if (target.node.style.width !== width) target.node.style.width = width;
    }
    this.labels.style.transform = `translate3d(${dx}px,0,0)`;
    this.updatePreviewTabOrder(dx);
    for (const label of this.labels.querySelectorAll('.group-label')) label.style.transform = `translateX(${-dx}px)`;
    this.renderer.render(this.scene, this.camera);
  }
  updatePreviewTabOrder(offset) {
    for (const target of this.previewLabels || []) {
      const next = previewTabIndex(target.start, target.end, this.width, offset);
      if (target.node.tabIndex !== next) target.node.tabIndex = next;
    }
  }
  restoreOverflow() {
    if (!this.previewOverflow) return;
    this.host.style.setProperty('overflow', this.previewOverflow.value, this.previewOverflow.priority);
    this.previewOverflow = null;
  }
  dispose() { this.restoreOverflow(); this.clear(); this.renderer.dispose(); this.renderer.domElement.remove(); this.labels.remove(); }
}
