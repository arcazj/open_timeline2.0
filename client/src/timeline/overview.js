import * as THREE from 'three';
import { resolvePresentation, resolveRecordStyle } from './presentation.js';

export class OverviewRenderer {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    host.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene(); this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 100); this.camera.position.z = 10;
  }
  clear() { for (const mesh of [...this.scene.children]) { this.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); } }
  render({ items, zones, width, height, project, theme, domainEnd, presentation, ticks = [] }) {
    this.clear();
    this.renderer.setSize(width, height); this.camera.right = width; this.camera.top = height; this.camera.updateProjectionMatrix();
    const resolved = presentation || resolvePresentation({ theme });
    const styled = !!presentation || items.some(item => Object.keys(item.render || {}).some(key => key !== 'color'));
    this.scene.background = presentation ? new THREE.Color(resolved.bands.overview.backgroundColor) : null;
    const add = (geometry, x, y, color, opacity, order) => {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false }));
      mesh.position.set(x, height - y, 0); mesh.renderOrder = order; this.scene.add(mesh);
    };
    const rect = (x, y, w, h, color, opacity = 1, order = 1) => {
      if (h <= 0 || w <= 0) return;
      add(new THREE.PlaneGeometry(w, h), x + w / 2, y + h / 2, color, opacity, order);
    };
    const entries = items.map(item => ({ item, style: resolveRecordStyle({ ...item, render: item.render || (!item.sourceId && item.color ? { color: item.color } : {}) }, resolved, 'overview') }));
    const maxGeometry = Math.max(3, ...entries.map(({ style }) => Math.max(style.barHeight, style.pointRadius * 2)));
    const pitch = styled ? maxGeometry + 3 : 6, laneCount = styled ? Math.max(1, Math.floor((height - 10) / pitch)) : 8;
    if (styled) for (let lane = 0; lane < laneCount; lane++) {
      const members = entries.filter((_, i) => i % laneCount === lane);
      if (members.length && members.every(({ item }) => !item.count) && new Set(members.map(({ item }) => item.sourceId)).size === 1 && members[0].style.sourceBackground) rect(0, 5 + lane * pitch, width, pitch, members[0].style.sourceBackground, 1, 0);
    }
    zones.forEach(zone => { const left = Math.max(0, project(zone.start)), right = Math.min(width, project(zone.end)); rect(left, 0, right - left, height, zone.color, zone.opacity ?? 0.18, 1); });
    for (const tick of ticks) rect(project(tick.timeMs), 0, 1, height, '#999999', .18, 1);
    entries.forEach(({ item, style }, i) => {
      const start = project(item.start), end = project(item.end || (item.kind === 'session' ? domainEnd : item.start)), y = 5 + (i % laneCount) * pitch;
      const color = item.count ? '#77858c' : styled ? style.color : item.color || (theme === 'dark' ? '#91c5d2' : '#397aa6');
      if (styled && !item.count && (item.kind === 'event' || item.end === item.start)) add(new THREE.CircleGeometry(style.pointRadius, 20), start, y + maxGeometry / 2, color, 1, 2);
      else rect(Math.max(0, start), y + (styled ? (maxGeometry - style.barHeight) / 2 : 0), Math.max(2, Math.min(width, end) - Math.max(0, start)), item.count ? Math.min(14, 3 + Math.log2(item.count)) : styled ? style.barHeight : 3, color, 1, 2);
    });
    this.renderer.render(this.scene, this.camera);
  }
  dispose() { this.clear(); this.renderer.dispose(); this.renderer.domElement.remove(); }
}
