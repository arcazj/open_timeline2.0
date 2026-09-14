import { toSvg } from 'html-to-image';

export async function captureTimeline(node) {
  const box = node.getBoundingClientRect();
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(16000000 / (box.width * box.height)));
  const style = getComputedStyle(node);
  const url = await toSvg(node, {
    backgroundColor: style.getPropertyValue('--canvas').trim() || '#eef0f0',
    includeStyleProperties: Array.from(style).filter(name => name !== 'will-change'),
    filter: element => element.tagName !== 'INPUT' || element.type !== 'password',
  });
  // Native checkbox properties are not serialized by foreignObject cloning.
  const svg = new DOMParser().parseFromString(decodeURIComponent(url.slice(url.indexOf(',') + 1)), 'image/svg+xml');
  const inputs = [...node.querySelectorAll('input')].filter(input => input.type !== 'password');
  [...svg.getElementsByTagName('input')].forEach((input, index) => {
    if (['checkbox', 'radio'].includes(inputs[index]?.type)) {
      if (inputs[index].checked) input.setAttribute('checked', ''); else input.removeAttribute('checked');
    }
  });
  const selects = [...node.querySelectorAll('select')];
  [...svg.getElementsByTagName('select')].forEach((select, index) => {
    [...select.getElementsByTagName('option')].forEach((option, optionIndex) => {
      if (selects[index]?.options[optionIndex]?.selected) option.setAttribute('selected', ''); else option.removeAttribute('selected');
    });
  });
  const image = new Image(); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = Math.round(box.width * pixelRatio); canvas.height = Math.round(box.height * pixelRatio);
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The browser could not capture this view.')), 'image/png'));
}
