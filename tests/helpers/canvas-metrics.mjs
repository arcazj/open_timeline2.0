export function canvasMetrics(canvas) {
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('A WebGL2 context is required for canvas verification');
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const colors = new Set();
  let detailPixels = 0;
  // Vertical grids and zones are constant down each column; records are not.
  for (let i = 0; i < pixels.length; i += 4) {
    colors.add(pixels[i] * 65536 + pixels[i + 1] * 256 + pixels[i + 2]);
    const base = i % (canvas.width * 4);
    if (pixels[i] !== pixels[base] || pixels[i + 1] !== pixels[base + 1] || pixels[i + 2] !== pixels[base + 2]) detailPixels++;
  }
  return { colors: colors.size, detailPixels };
}
